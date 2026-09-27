// Author verification (DESIGN §10.2): the member proves control of something only the real author
// controls by placing a code there. Automated checks fetch it through safeFetch (§15.8); Royal
// Road, Amazon and other profile pages are never fetched, so those go to the Owner Inbox.
//
// A code found on a domain or handle the profile already lists (set by the owner or a cited source)
// verifies at once. Found anywhere else, it only proves the member controls that place, not that the
// place belongs to the author, so the owner confirms it with one click.

import { and, desc, eq, inArray } from "drizzle-orm";
import { type AuditActor, appendAudit } from "../audit";
import type { Db } from "../db";
import { authors, type VerifyMethod, verificationRequests } from "../db/schema";
import { ulid } from "../ids";
import { openInboxItem } from "../inbox";
import { SafeFetchError, safeFetch } from "../net/safe-fetch";
import { nowIso } from "../time";

export const VERIFY_DAYS = 14;
export const MAX_CHECKS = 30;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class VerificationError extends Error {}

export function newVerificationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `rlr-verify-${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

/** "https://www.Example.com/books" → "example.com". Null for anything that isn't a public host name. */
export function normalizeDomain(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  try {
    host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (host.length > 253 || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) return null;
  return host;
}

export function normalizeHandle(raw: string): string | null {
  const h = raw
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\/bsky\.app\/profile\//, "")
    .replace(/\/.*$/, "");
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) && h.length <= 253 ? h : null;
}

/** Domains and Bluesky handles the profile already lists (not member-editable, §10.2). */
export async function establishedTargets(db: Db, authorId: string) {
  const [a] = await db.select({ links: authors.links }).from(authors).where(eq(authors.id, authorId));
  const domains = new Set<string>();
  const handles = new Set<string>();
  for (const link of a?.links ?? []) {
    const bsky = /^https?:\/\/bsky\.app\/profile\/([^/?#]+)/i.exec(link);
    if (bsky?.[1]) {
      const h = normalizeHandle(bsky[1]);
      if (h) handles.add(h);
      continue;
    }
    const d = normalizeDomain(link);
    if (d) domains.add(d);
  }
  return { domains, handles };
}

const DOMAIN_METHODS: ReadonlySet<VerifyMethod> = new Set([
  "website_file",
  "meta_tag",
  "dns_txt",
  "email_domain",
]);

export interface StartInput {
  authorId: string;
  userId: string;
  method: Exclude<VerifyMethod, "owner_override">;
  target: string;
}

export interface Started {
  id: string;
  code: string;
  target: string;
}

/** Start (or reuse) a request. The same member, profile and method share one open request. */
export async function startVerification(db: Db, input: StartInput, now = new Date()): Promise<Started> {
  let target: string | null;
  if (DOMAIN_METHODS.has(input.method)) target = normalizeDomain(input.target);
  else if (input.method === "bluesky") target = normalizeHandle(input.target);
  else target = /^https:\/\/[^\s]{4,500}$/.test(input.target.trim()) ? input.target.trim() : null;
  if (!target)
    throw new VerificationError(
      DOMAIN_METHODS.has(input.method)
        ? "enter your website's address, like yourname.com"
        : input.method === "bluesky"
          ? "enter your Bluesky handle, like yourname.bsky.social"
          : "enter the https:// address of the page where you'll put the code",
    );
  const [open] = await db
    .select()
    .from(verificationRequests)
    .where(
      and(
        eq(verificationRequests.authorId, input.authorId),
        eq(verificationRequests.userId, input.userId),
        eq(verificationRequests.method, input.method),
        inArray(verificationRequests.status, ["pending", "review"]),
      ),
    )
    .orderBy(desc(verificationRequests.createdAt))
    .limit(1);
  if (open && open.target === target && open.expiresAt > nowIso(now))
    return { id: open.id, code: open.code, target };
  if (open)
    await db
      .update(verificationRequests)
      .set({ status: "expired", updatedAt: nowIso(now) })
      .where(eq(verificationRequests.id, open.id));
  const id = ulid();
  const code = newVerificationCode();
  await db.insert(verificationRequests).values({
    id,
    authorId: input.authorId,
    userId: input.userId,
    method: input.method,
    code,
    target,
    expiresAt: new Date(now.getTime() + VERIFY_DAYS * 86_400_000).toISOString(),
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  });
  return { id, code, target };
}

export interface CheckDeps {
  /** The account's address, for the email-domain method. */
  userEmail: string;
  fetch?: typeof fetch;
  now?: Date;
}

export type CheckOutcome =
  | { status: "verified" }
  | { status: "review"; message: string }
  | { status: "pending"; message: string }
  | { status: "expired" | "failed"; message: string };

async function fetchText(url: string, host: string, f?: typeof fetch): Promise<string | null> {
  try {
    const res = await safeFetch(url, { allowHosts: [host], fetch: f, maxBytes: 500_000, timeoutMs: 8_000 });
    return res.status === 200 ? res.text : null;
  } catch (error) {
    if (error instanceof SafeFetchError) return null;
    throw error;
  }
}

/** Is the code where the member said it would be? Returns what was seen, for the evidence log. */
async function lookForCode(
  method: VerifyMethod,
  target: string,
  code: string,
  deps: CheckDeps,
): Promise<{ found: boolean; where: string }> {
  switch (method) {
    case "website_file":
      for (const host of [target, `www.${target}`]) {
        const text = await fetchText(`https://${host}/.well-known/readlitrpg-verify.txt`, host, deps.fetch);
        if (text?.includes(code))
          return { found: true, where: `https://${host}/.well-known/readlitrpg-verify.txt` };
      }
      return { found: false, where: `https://${target}/.well-known/readlitrpg-verify.txt` };
    case "meta_tag":
      for (const host of [target, `www.${target}`]) {
        const html = await fetchText(`https://${host}/`, host, deps.fetch);
        const tags = html?.match(/<meta\b[^>]*>/gi) ?? [];
        if (tags.some((t) => /name=["']?readlitrpg-verify["']?/i.test(t) && t.includes(code)))
          return { found: true, where: `https://${host}/` };
      }
      return { found: false, where: `https://${target}/` };
    case "dns_txt": {
      const name = `_readlitrpg.${target}`;
      try {
        const res = await safeFetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
          {
            allowHosts: ["cloudflare-dns.com"],
            headers: { accept: "application/dns-json" },
            fetch: deps.fetch,
            maxBytes: 50_000,
          },
        );
        const answers = (JSON.parse(res.text) as { Answer?: { data?: string }[] }).Answer ?? [];
        return { found: answers.some((a) => (a.data ?? "").includes(code)), where: `TXT ${name}` };
      } catch {
        return { found: false, where: `TXT ${name}` };
      }
    }
    case "email_domain": {
      const domain = deps.userEmail.split("@")[1]?.toLowerCase() ?? "";
      return { found: domain === target || domain.endsWith(`.${target}`), where: `account email @${domain}` };
    }
    case "bluesky": {
      try {
        const res = await safeFetch(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(target)}`,
          { allowHosts: ["public.api.bsky.app"], fetch: deps.fetch, maxBytes: 100_000 },
        );
        const profile = JSON.parse(res.text) as { description?: string; handle?: string };
        return {
          found: res.status === 200 && (profile.description ?? "").includes(code),
          where: `Bluesky @${target}`,
        };
      } catch {
        return { found: false, where: `Bluesky @${target}` };
      }
    }
    default:
      return { found: false, where: target };
  }
}

/** Run the check the member asked for, and verify, send for review, or say what's missing. */
export async function checkVerification(db: Db, id: string, deps: CheckDeps): Promise<CheckOutcome> {
  const now = deps.now ?? new Date();
  const [req] = await db.select().from(verificationRequests).where(eq(verificationRequests.id, id));
  if (!req) throw new VerificationError("no such request");
  if (req.status === "verified") return { status: "verified" };
  if (req.status === "review")
    return { status: "review", message: "Waiting for a quick check by ReadLitRPG." };
  if (req.status !== "pending")
    return { status: "failed", message: "This request is closed. Start a new one." };
  if (req.expiresAt < nowIso(now)) {
    await db
      .update(verificationRequests)
      .set({ status: "expired", updatedAt: nowIso(now) })
      .where(eq(verificationRequests.id, id));
    return { status: "expired", message: "This code has expired. Start again for a new one." };
  }
  if (req.attempts >= MAX_CHECKS)
    return { status: "failed", message: "Too many checks on this code. Start again for a new one." };

  if (req.method === "profile_code")
    return sendForReview(db, req, { where: req.target ?? "", found: null }, now);

  const target = req.target ?? "";
  const seen = await lookForCode(req.method, target, req.code, deps);
  const evidence = { where: seen.where, found: seen.found, checkedAt: nowIso(now) };
  await db
    .update(verificationRequests)
    .set({ attempts: req.attempts + 1, evidence, checkedAt: nowIso(now), updatedAt: nowIso(now) })
    .where(eq(verificationRequests.id, id));
  if (!seen.found)
    return {
      status: "pending",
      message:
        req.method === "email_domain"
          ? `Your account's email address isn't at ${target}.`
          : `We didn't find the code at ${seen.where} yet. Changes can take a few minutes to show; try again soon.`,
    };
  const established = await establishedTargets(db, req.authorId);
  const known = req.method === "bluesky" ? established.handles.has(target) : established.domains.has(target);
  if (!known) return sendForReview(db, req, evidence, now);
  await markVerified(db, id, { type: "user", id: req.userId }, now);
  return { status: "verified" };
}

async function sendForReview(
  db: Db,
  req: typeof verificationRequests.$inferSelect,
  evidence: Record<string, unknown>,
  now: Date,
): Promise<CheckOutcome> {
  const [author] = await db.select({ name: authors.name }).from(authors).where(eq(authors.id, req.authorId));
  await openInboxItem(db, {
    type: "verification_manual",
    title: `Verify "${author?.name ?? "an author"}" (${req.method.replace("_", " ")})`,
    subjectType: "author",
    subjectId: req.authorId,
    priority: 50,
    payload: {
      requestId: req.id,
      authorId: req.authorId,
      method: req.method,
      target: req.target,
      code: req.code,
      evidence,
      // What to check: the code on a page we don't fetch, or a place not yet on the profile.
      check:
        req.method === "profile_code"
          ? "Open the page and look for the code."
          : "The code is there. Is this the author's own site or account?",
    },
    dedupeKey: `verify:${req.id}`,
  });
  await db
    .update(verificationRequests)
    .set({ status: "review", evidence, updatedAt: nowIso(now) })
    .where(eq(verificationRequests.id, req.id));
  return {
    status: "review",
    message:
      req.method === "profile_code"
        ? "Thanks. We'll check the page by hand, usually within a day or two."
        : "Found it. Because this site isn't on your profile yet, we'll confirm it's yours by hand, usually within a day or two.",
  };
}

/**
 * Mark a request verified: the profile becomes verified and moves from T0 to T1 (a restricted or
 * trusted profile keeps its level), and the verified site or handle joins the profile's links.
 */
export async function markVerified(
  db: Db,
  id: string,
  actor: AuditActor,
  now = new Date(),
): Promise<boolean> {
  const [req] = await db.select().from(verificationRequests).where(eq(verificationRequests.id, id));
  if (!req || req.status === "verified") return false;
  const [author] = await db.select().from(authors).where(eq(authors.id, req.authorId));
  if (!author) return false;
  const stamp = nowIso(now);
  const link =
    req.method === "bluesky" && req.target
      ? `https://bsky.app/profile/${req.target}`
      : req.target && DOMAIN_METHODS.has(req.method)
        ? `https://${req.target}/`
        : null;
  const links = link && !author.links.includes(link) ? [...author.links, link] : author.links;
  await db.batch([
    db
      .update(verificationRequests)
      .set({ status: "verified", decidedBy: actor.id ?? null, decidedAt: stamp, updatedAt: stamp })
      .where(eq(verificationRequests.id, id)),
    db
      .update(authors)
      .set({
        verifiedAt: author.verifiedAt ?? stamp,
        trustLevel: author.trustLevel === "T0" ? "T1" : author.trustLevel,
        links,
        updatedAt: stamp,
      })
      .where(eq(authors.id, req.authorId)),
  ]);
  await appendAudit(db, {
    actor,
    action: "author.verify",
    subjectType: "author",
    subjectId: req.authorId,
    diff: {
      method: req.method,
      target: req.target,
      trust: author.trustLevel === "T0" ? "T1" : author.trustLevel,
    },
  });
  return true;
}

export async function rejectVerification(
  db: Db,
  id: string,
  actor: AuditActor,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(verificationRequests)
    .set({ status: "rejected", decidedBy: actor.id ?? null, decidedAt: nowIso(now), updatedAt: nowIso(now) })
    .where(and(eq(verificationRequests.id, id), inArray(verificationRequests.status, ["pending", "review"])))
    .returning({ authorId: verificationRequests.authorId });
  if (rows[0])
    await appendAudit(db, {
      actor,
      action: "author.verify_reject",
      subjectType: "author",
      subjectId: rows[0].authorId,
    });
  return rows.length === 1;
}

/** The owner knows the author (§10.2 "Owner override"): verified, audited. */
export async function ownerOverride(
  db: Db,
  authorId: string,
  adminId: string,
  now = new Date(),
): Promise<void> {
  const id = ulid();
  await db.insert(verificationRequests).values({
    id,
    authorId,
    userId: adminId,
    method: "owner_override",
    code: "",
    status: "pending",
    expiresAt: nowIso(now),
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  });
  await markVerified(db, id, { type: "admin", id: adminId }, now);
}

export async function requestsFor(db: Db, authorId: string) {
  return db
    .select()
    .from(verificationRequests)
    .where(eq(verificationRequests.authorId, authorId))
    .orderBy(desc(verificationRequests.createdAt))
    .limit(20);
}
