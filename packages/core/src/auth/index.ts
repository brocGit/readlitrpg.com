// Better Auth configuration for both hosts (DESIGN §15.3). No passwords and no social login.
//
// - web (readlitrpg.com): magic links and passkeys. Readers get 30-day sliding sessions.
// - admin (admin.readlitrpg.com): passkeys only, 12-hour absolute sessions, separate cookie,
//   no sign-up path. The owner registers a passkey on the main site first. The relying-party ID
//   is the registrable domain, so the same passkey works on the admin subdomain.

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db";
import { accounts, passkeys, sessions, users, verifications } from "../db/schema";
import { ulid } from "../ids";
import { createLogger, type Logger } from "../log";

export const RP_NAME = "ReadLitRPG";
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  passkey: passkeys,
};

interface CommonOptions {
  d1: D1Database;
  secret: string;
  /** Origin of this host, e.g. https://readlitrpg.com or http://localhost:4321. */
  baseURL: string;
  /** Registrable domain for passkeys: "readlitrpg.com" in production, "localhost" in dev. */
  rpID: string;
  log?: Logger;
}

export interface WebAuthOptions extends CommonOptions {
  sendMagicLink: (args: { email: string; url: string }) => Promise<void>;
  /** Checked before a new account is created (the `flags.signups` kill switch). */
  signupsOpen: () => Promise<boolean>;
  sessionDays?: number;
}

export interface AdminAuthOptions extends CommonOptions {
  sessionHours?: number;
}

function common(opts: CommonOptions, db: Db) {
  const log = opts.log ?? createLogger({ component: "auth" });
  return {
    appName: RP_NAME,
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    telemetry: { enabled: false },
    logger: {
      level: "warn" as const,
      log: (level: "debug" | "info" | "warn" | "error", message: string) => log[level](`auth: ${message}`),
    },
    advanced: {
      database: { generateId: () => ulid() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: opts.baseURL.startsWith("https://"),
    },
    databaseHooks: {
      session: {
        create: {
          // Deleted and restricted accounts can't start new sessions.
          before: async (session: { userId: string }) => {
            const [user] = await db
              .select({ state: users.state })
              .from(users)
              .where(eq(users.id, session.userId));
            return user?.state === "active";
          },
        },
      },
    },
  };
}

export function createWebAuth(opts: WebAuthOptions) {
  const db = createDb(opts.d1);
  const base = common(opts, db);
  return betterAuth({
    ...base,
    advanced: { ...base.advanced, cookiePrefix: "rlr" },
    session: {
      expiresIn: (opts.sessionDays ?? 30) * 86_400,
      updateAge: 86_400,
    },
    databaseHooks: {
      ...base.databaseHooks,
      user: {
        create: {
          before: async (user) => {
            if (!(await opts.signupsOpen())) return false;
            return { data: { ...user, email: user.email.trim().toLowerCase() } };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => opts.sendMagicLink({ email, url }),
      }),
      passkey({
        rpID: opts.rpID,
        rpName: RP_NAME,
        origin: opts.baseURL,
      }),
    ],
  });
}

export function createAdminAuth(opts: AdminAuthOptions) {
  const db = createDb(opts.d1);
  const base = common(opts, db);
  return betterAuth({
    ...base,
    advanced: { ...base.advanced, cookiePrefix: "rlr_admin" },
    session: {
      expiresIn: (opts.sessionHours ?? 12) * 3600,
      disableSessionRefresh: true,
    },
    databaseHooks: {
      ...base.databaseHooks,
      user: {
        create: {
          // Accounts are never created on the admin host.
          before: async () => false,
        },
      },
    },
    plugins: [
      passkey({
        rpID: opts.rpID,
        rpName: RP_NAME,
        // Sign-in assertions happen on the admin host, so only its origin is accepted here.
        origin: opts.baseURL,
      }),
    ],
  });
}

export type WebAuth = ReturnType<typeof createWebAuth>;
export type AdminAuth = ReturnType<typeof createAdminAuth>;

/** "jane.doe@gmail.com" → "j***@gmail.com", for "Sign in as …?" confirmations. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
