// Shared bits for the console's catalog pages.

import {
  type BookField,
  type BookInput,
  bookInputSchema,
  type IngestContext,
  parseDate,
} from "@rlr/core/catalog";
import type { Settings } from "@rlr/core/settings";
import type { AdminSession } from "./admin-session";

/** Everything the owner adds is admin-sourced and counts as an owner check (DESIGN §7.15). */
export function ownerIngestContext(admin: AdminSession, settings: Settings): IngestContext {
  return {
    source: "admin",
    origin: "admin",
    actorId: admin.userId,
    sourceRef: "console",
    confirmation: { source: "owner_check", ref: "console" },
    fuzzyMin: settings["catalog.fuzzy_title_min"],
    crowdMinVotes: settings["tags.crowd_min_votes"],
  };
}

const splitList = (v: string | undefined) =>
  (v ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
const optionalNumber = (v: string | undefined) => (v?.trim() ? Number(v) : undefined);

/** The quick-add form, as book input. */
export function quickAddInput(form: Record<string, string>): { input?: BookInput; error?: string } {
  const editions: Record<string, unknown>[] = [];
  if (form.asin || form.isbn || form.publisher || form.ku) {
    editions.push({
      format: form.format || (form.isbn && !form.asin ? "paperback" : "ebook"),
      ...(form.asin ? { asin: form.asin } : {}),
      ...(form.isbn ? { isbn: form.isbn } : {}),
      ...(form.publisher ? { publisher: form.publisher } : {}),
      ...(form.ku ? { kindleUnlimited: form.ku === "yes" } : {}),
    });
  }
  if (form.audible_asin || form.narrators) {
    editions.push({
      format: "audiobook",
      ...(form.audible_asin ? { audibleAsin: form.audible_asin } : {}),
      ...(form.narrators ? { narrators: splitList(form.narrators) } : {}),
    });
  }
  const candidate = {
    title: form.title ?? "",
    subtitle: form.subtitle || undefined,
    authors: splitList(form.authors).map((name) => ({ name })),
    series: form.series ? { name: form.series, position: optionalNumber(form.position) } : undefined,
    primaryGenre: form.genre || undefined,
    tags: splitList(form.tags).map((slug) => ({ slug })),
    crunchLevel: optionalNumber(form.crunch),
    romanceLevel: optionalNumber(form.romance),
    harem: form.harem || undefined,
    firstPublished: form.published || undefined,
    pageCount: optionalNumber(form.pages),
    blurb: form.blurb || undefined,
    editions: editions.length ? editions : undefined,
    links: (form.links ?? "").split(/\s+/).filter(Boolean),
    releases: form.release_date
      ? [{ kind: form.release_kind || "ebook", date: form.release_date }]
      : undefined,
  };
  const parsed = bookInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${issue?.path.join(".") || "form"}: ${issue?.message ?? "invalid"}` };
  }
  return { input: parsed.data };
}

/** Fields the owner can override from the book page, and how to read the typed value. */
export const OVERRIDABLE: Partial<Record<BookField, (raw: string) => unknown>> = {
  title: (v) => v.trim(),
  subtitle: (v) => v.trim() || null,
  seriesPosition: (v) => (v.trim() ? Number(v) : null),
  firstPublished: (v) => (v.trim() ? parseDate(v) : null),
  pageCount: (v) => (v.trim() ? Number(v) : null),
  pubStatus: (v) => v.trim(),
  primaryGenre: (v) => v.trim() || null,
  inScope: (v) => v.trim(),
  crunchLevel: (v) => (v.trim() ? Number(v) : null),
  romanceLevel: (v) => (v.trim() ? Number(v) : null),
  harem: (v) => v.trim(),
  contentFlags: (v) => splitList(v),
  isAiGenerated: (v) => v.trim(),
  blurbAuthor: (v) => v.trim() || null,
};
