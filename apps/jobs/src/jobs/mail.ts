// Shared pieces for the reader email jobs (DESIGN §13): who may be mailed, footers with signed
// one-click unsubscribe links, books with one-click marks, and handing rendered mail to Q_EMAIL.
// The consumer checks suppressions again at send time.

import { openInboxItem } from "@rlr/core/inbox";
import { type FeatureMatrix, loadMatrix, type MatchOptions, matchOptionsFrom } from "@rlr/core/match";
import { type LinkKeys, type Pick, parseLinkKeys, signLink } from "@rlr/core/readers";
import { type EmailList, emailConsents } from "@rlr/core/schema";
import { loadSettings, type Settings } from "@rlr/core/settings";
import { formatDate, RELEASE_LABEL } from "@rlr/core/site";
import type { EmailBook, EmailJob, Footer } from "@rlr/email";
import { and, eq, inArray } from "drizzle-orm";
import type { JobContext } from "./types";

export type RenderedJob = Extract<EmailJob, { kind: "rendered" }>;

export interface MailContext extends JobContext {
  settings: Settings;
  keys: LinkKeys;
  origin: string;
  matrix: FeatureMatrix | null;
  options: MatchOptions;
}

export async function mailContext(ctx: JobContext): Promise<MailContext> {
  const settings = await loadSettings({ db: ctx.db, kv: ctx.env.CONFIG, log: ctx.log });
  return {
    ...ctx,
    settings,
    keys: parseLinkKeys(ctx.env.LINK_SIGNING_KEYS),
    origin: ctx.env.PUBLIC_ORIGIN.replace(/\/$/, ""),
    matrix: await loadMatrix(ctx.env.CONFIG),
    options: matchOptionsFrom(settings),
  };
}

/**
 * CAN-SPAM: every marketing email carries a postal address (DESIGN §13.3). Until one is set,
 * production marketing mail waits and the owner gets one inbox item.
 */
export async function marketingReady(mc: MailContext): Promise<boolean> {
  if (mc.settings["email.postal_address"].trim() || mc.env.ENVIRONMENT !== "production") return true;
  await openInboxItem(mc.db, {
    type: "system_alert",
    title: "Set a postal address before marketing email can go out",
    payload: { setting: "email.postal_address", why: "CAN-SPAM requires one in every marketing email" },
    priority: 90,
    dedupeKey: "email.postal_address_missing",
  });
  mc.log.warn("email.postal_address_missing");
  return false;
}

export async function activeLists(mc: MailContext, userId: string): Promise<Set<EmailList>> {
  const rows = await mc.db
    .select({ list: emailConsents.list })
    .from(emailConsents)
    .where(and(eq(emailConsents.userId, userId), eq(emailConsents.status, "active")));
  return new Set(rows.map((r) => r.list));
}

export async function subscribedTo(
  mc: MailContext,
  userIds: string[],
  list: EmailList,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < userIds.length; i += 90) {
    const rows = await mc.db
      .select({ userId: emailConsents.userId })
      .from(emailConsents)
      .where(
        and(
          inArray(emailConsents.userId, userIds.slice(i, i + 90)),
          eq(emailConsents.list, list),
          eq(emailConsents.status, "active"),
        ),
      );
    for (const r of rows) out.add(r.userId);
  }
  return out;
}

const REASON: Record<EmailList, string> = {
  weekly_digest: "You're getting this because you subscribed to Patch Notes on ReadLitRPG.",
  release_alerts: "You're getting this because you asked for release-day emails for books you follow.",
  reading_list: "You're getting this because you asked for your reading list on ReadLitRPG.",
};

/** The footer and RFC 8058 headers for one reader and list. Unsubscribe links never expire. */
export async function footerFor(
  mc: MailContext,
  userId: string,
  list: EmailList,
): Promise<{ footer: Footer; headers: Record<string, string> }> {
  const unsubscribeUrl = `${mc.origin}/u/${await signLink(mc.keys, "unsub", [userId, list])}`;
  return {
    footer: {
      unsubscribeUrl,
      preferencesUrl: `${mc.origin}/account/email`,
      postalAddress: mc.settings["email.postal_address"].trim(),
      reason: REASON[list],
    },
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

const MARK_DAYS = 90;

/** A pick as an email block. With `marks`, three signed one-click choices (QUIZZES §3.4). */
export async function pickBook(
  mc: MailContext,
  p: Pick,
  opts: { src: string; userId?: string; marks?: boolean; showWhy?: boolean },
): Promise<EmailBook> {
  const exp = mc.now.getTime() + MARK_DAYS * 86_400_000;
  const mark = async (status: "loved" | "read" | "dnf") =>
    `${mc.origin}/m/${await signLink(mc.keys, "mark", [opts.userId ?? "", p.id, status], exp)}`;
  return {
    title: p.title,
    url: `${mc.origin}/books/${p.slug}?${opts.src}`,
    authors: p.authors,
    series: p.series,
    hook: p.hook,
    note: p.percent > 0 ? `${p.percent}% match` : null,
    why: opts.showWhy === false ? null : p.why,
    marks:
      opts.marks && opts.userId
        ? { loved: await mark("loved"), read: await mark("read"), no: await mark("dnf") }
        : null,
  };
}

export interface ReleaseRow {
  bookSlug: string;
  title: string;
  kind: string;
  date: string | null;
  precision: string;
  seriesName: string | null;
  position: number | null;
}

export function releaseBook(mc: MailContext, r: ReleaseRow, src: string): EmailBook {
  const kind = RELEASE_LABEL[r.kind] ?? "Release";
  return {
    title: r.title,
    url: `${mc.origin}/books/${r.bookSlug}?${src}`,
    authors: "",
    series: r.seriesName ? `${r.seriesName}${r.position ? ` #${r.position}` : ""}` : null,
    note: `${kind} · ${formatDate(r.date, r.precision)}`,
  };
}

export async function queueRendered(mc: MailContext, job: Omit<RenderedJob, "kind">): Promise<void> {
  await mc.env.Q_EMAIL.send({ kind: "rendered", ...job } satisfies RenderedJob);
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
