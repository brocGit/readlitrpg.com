// Normalization for catalog input (DESIGN §7.3 step 1, §15.6). Everything that enters the catalog
// passes through here first: text cleanup, matching keys, identifiers, links and dates. All pure.

// ---------------------------------------------------------------------------------------------
// Text

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFKC, no control or zero-width characters, straight quotes, single spaces. For display text. */
export function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, " ")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, no accents, letters and digits only. The base for every matching key. */
function foldForKey(value: string): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Matching key for people and series names. Runs of initials are joined, so "J. R. R. Tolkien",
 * "J.R.R. Tolkien" and "JRR Tolkien" all become "jrr tolkien".
 */
export function nameKey(value: string): string {
  const tokens = foldForKey(value.replace(/\./g, ". ")).split(" ").filter(Boolean);
  const out: string[] = [];
  let initials = "";
  for (const token of tokens) {
    if (token.length === 1 && /\p{L}/u.test(token)) {
      initials += token;
      continue;
    }
    if (initials) {
      out.push(initials);
      initials = "";
    }
    out.push(token);
  }
  if (initials) out.push(initials);
  return out.join(" ");
}

const MARKETING = String.raw`litrpg|lit rpg|gamelit|progression fantasy|progression|cultivation|xianxia|wuxia|dungeon core|system apocalypse|isekai|portal fantasy|epic fantasy|fantasy|sci-fi|scifi|science fiction|novel|adventure|saga|series|epic|story|harem`;
const MARKETING_RE = new RegExp(`\\b(${MARKETING})\\b`, "i");
const VOLUME_WORDS = String.raw`book|volume|vol|part|episode|arc`;

/**
 * Matching key for book titles. Removes what retailers bolt on ("(The Primal Hunter Book 2)",
 * ": A LitRPG Adventure") but keeps volume numbers that belong to the title ("The Primal Hunter 2",
 * "The Wandering Inn: Volume 1"), because those tell sibling books apart.
 */
export function titleKey(title: string): string {
  let t = cleanText(title);
  // Parenthetical or bracketed series and marketing tags.
  t = t.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner: string) =>
    MARKETING_RE.test(inner) || new RegExp(`\\b(${VOLUME_WORDS})\\b\\.?\\s*[\\divxlc]+`, "i").test(inner)
      ? " "
      : whole,
  );
  // Marketing subtitles after a colon or dash: ": A LitRPG Adventure", " - A Progression Fantasy Epic".
  t = t.replace(/\s*(?::|\s[-–—]\s)\s*([^:–—]*)$/u, (whole, sub: string) =>
    MARKETING_RE.test(sub) && !new RegExp(`\\b(${VOLUME_WORDS})\\b`, "i").test(sub) ? "" : whole,
  );
  const key = foldForKey(t);
  return key.replace(/^(the|a|an) /, "");
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/**
 * The volume number a title carries, if any: "(Cradle Book 3)", "Volume 2", "Book Four",
 * or a bare trailing number ("The Primal Hunter 2"). Used for series position and to keep
 * fuzzy matching from confusing siblings.
 */
export function extractVolume(title: string): number | null {
  const t = cleanText(title).toLowerCase();
  const explicit = new RegExp(`\\b(?:${VOLUME_WORDS})\\.?\\s*#?\\s*(\\d+(?:\\.\\d+)?|[a-z]+)\\b`, "g");
  let last: number | null = null;
  for (const m of t.matchAll(explicit)) {
    const raw = m[1] ?? "";
    const n = /^\d/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? null);
    if (n !== null && Number.isFinite(n)) last = n;
  }
  if (last !== null) return last;
  const hash = /#\s*(\d+(?:\.\d+)?)\b/.exec(t);
  if (hash?.[1]) return Number(hash[1]);
  const trailing = /\s(\d{1,3})(?:\s*[:\-–—(].*)?$/.exec(titleKeyish(t));
  return trailing?.[1] ? Number(trailing[1]) : null;
}

/** Title without parenthetical tags, lowercased; used by extractVolume for bare trailing numbers. */
function titleKeyish(t: string): string {
  return t
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Titles that mix scripts inside one word (Latin with Cyrillic or Greek) are a classic homoglyph
 * spoof of famous titles and names (DESIGN §15.6). Flag them for review.
 */
export function hasMixedScripts(value: string): boolean {
  for (const word of cleanText(value).split(/\s+/)) {
    const latin = /\p{Script=Latin}/u.test(word);
    const other = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word);
    if (latin && other) return true;
  }
  return false;
}

/** URL slug: ASCII, lowercase, hyphens, at most 80 characters, cut at a word boundary. */
export function slugify(value: string, max = 80): string {
  const slug = foldForKey(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  if (slug.length <= max) return slug || "untitled";
  const cut = slug.slice(0, max);
  return cut.slice(0, cut.lastIndexOf("-") > 20 ? cut.lastIndexOf("-") : max).replace(/-+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Fuzzy matching

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of character trigrams, 0–1 (the pg_trgm definition). */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------------------------------------
// Identifiers

function isbn13Valid(d: string): boolean {
  if (!/^97[89]\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

function isbn10Valid(d: string): boolean {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (d[i] === "X" ? 10 : Number(d[i]));
  return sum % 11 === 0;
}

function isbn10To13(d: string): string {
  const core = `978${d.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** Any ISBN-10 or ISBN-13, with or without hyphens, as a checksum-valid ISBN-13. */
export function normalizeIsbn(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = value.toUpperCase().replace(/[^0-9X]/g, "");
  if (d.length === 13) return isbn13Valid(d) ? d : null;
  if (d.length === 10) return isbn10Valid(d) ? isbn10To13(d) : null;
  return null;
}

/** Kindle and Audible ASINs start with B and are 10 characters. */
export function normalizeAsin(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  return /^B[0-9A-Z]{9}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Links (DESIGN §7.3: allowlisted retail and platform domains; parsed, never fetched)

export const LINK_KINDS = [
  "amazon",
  "audible",
  "royalroad",
  "scribblehub",
  "kobo",
  "apple",
  "google",
  "bn",
  "books2read",
  "author_site",
  "patreon",
  "bookfunnel",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface ParsedLink {
  kind: LinkKind | "other";
  url: string;
  region: string | null;
  asin?: string;
  royalRoadId?: string;
}

export type LinkResult = { ok: true; link: ParsedLink } | { ok: false; reason: string };

const TRACKING_PARAMS =
  /^(utm_\w+|ref|ref_|tag|psc|qid|sr|keywords|crid|sprefix|linkcode|linkid|fbclid|gclid|mc_cid|mc_eid|_encoding|pd_rd_\w+|pf_rd_\w+|th|content-id|dib|dib_tag|source|srsltid)$/i;

const AMAZON_REGIONS: Record<string, string> = {
  com: "US",
  "co.uk": "GB",
  ca: "CA",
  "com.au": "AU",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  "co.jp": "JP",
  in: "IN",
  "com.br": "BR",
  "com.mx": "MX",
  nl: "NL",
};
const AUDIBLE_REGIONS: Record<string, string> = {
  com: "US",
  "co.uk": "GB",
  ca: "CA",
  "com.au": "AU",
  de: "DE",
  fr: "FR",
  it: "IT",
  "co.jp": "JP",
  in: "IN",
};
const SHORTENERS = new Set(["amzn.to", "a.co", "amzn.com", "adbl.co", "bit.ly", "tinyurl.com", "geni.us"]);

function stripTracking(url: URL): void {
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.hash = "";
}

/** Parse, clean and classify an outbound link. Nothing is fetched. */
export function parseLink(raw: string): LinkResult {
  let url: URL;
  try {
    url = new URL(cleanText(raw));
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "only web links" };
  url.protocol = "https:";
  url.username = "";
  url.password = "";
  const host = url.hostname.toLowerCase().replace(/^(www|m|smile)\./, "");
  if (SHORTENERS.has(host)) return { ok: false, reason: "shortened link: use the full address" };
  stripTracking(url);

  const amazon = /^amazon\.(.+)$/.exec(host);
  if (amazon?.[1] && AMAZON_REGIONS[amazon[1]]) {
    const asin = /\/(?:dp|gp\/product|product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1];
    if (!asin) return { ok: false, reason: "Amazon link without a product ID" };
    const a = asin.toUpperCase();
    return {
      ok: true,
      link: {
        kind: "amazon",
        url: `https://www.amazon.${amazon[1]}/dp/${a}`,
        region: AMAZON_REGIONS[amazon[1]] ?? null,
        asin: a,
      },
    };
  }
  const audible = /^audible\.(.+)$/.exec(host);
  if (audible?.[1] && AUDIBLE_REGIONS[audible[1]]) {
    const asin = url.pathname
      .split("/")
      .reverse()
      .find((p) => /^[A-Z0-9]{10}$/i.test(p));
    if (!asin) return { ok: false, reason: "Audible link without a product ID" };
    const a = asin.toUpperCase();
    return {
      ok: true,
      link: {
        kind: "audible",
        url: `https://www.audible.${audible[1]}/pd/${a}`,
        region: AUDIBLE_REGIONS[audible[1]] ?? null,
        asin: a,
      },
    };
  }
  if (host === "royalroad.com") {
    const id = /^\/fiction\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) return { ok: false, reason: "Royal Road link that isn't a fiction page" };
    return {
      ok: true,
      link: {
        kind: "royalroad",
        url: `https://www.royalroad.com/fiction/${id}`,
        region: null,
        royalRoadId: id,
      },
    };
  }
  if (host === "scribblehub.com") {
    const id = /^\/series\/(\d+)/.exec(url.pathname)?.[1];
    if (!id) return { ok: false, reason: "Scribble Hub link that isn't a series page" };
    return {
      ok: true,
      link: { kind: "scribblehub", url: `https://www.scribblehub.com/series/${id}/`, region: null },
    };
  }
  const simple: [RegExp, LinkKind][] = [
    [/^kobo\.com$/, "kobo"],
    [/^books\.apple\.com$/, "apple"],
    [/^play\.google\.com$/, "google"],
    [/^barnesandnoble\.com$/, "bn"],
    [/^books2read\.com$/, "books2read"],
    [/^patreon\.com$/, "patreon"],
    [/^(dl\.)?bookfunnel\.com$/, "bookfunnel"],
  ];
  for (const [pattern, kind] of simple) {
    if (pattern.test(host)) {
      if (kind === "google" && !url.pathname.startsWith("/store/books")) break;
      return { ok: true, link: { kind, url: url.toString(), region: null } };
    }
  }
  return { ok: true, link: { kind: "other", url: url.toString(), region: null } };
}

/** Hosts we never fetch, except through their official APIs (DESIGN §15.8). */
export const DO_NOT_FETCH = [
  /(^|\.)amazon\./,
  /(^|\.)audible\./,
  /(^|\.)royalroad\.com$/,
  /(^|\.)goodreads\.com$/,
];

// ---------------------------------------------------------------------------------------------
// Dates (DESIGN §5.1: YYYY-MM-DD plus a precision)

export type DatePrecision = "day" | "month" | "quarter" | "year" | "tba";
export interface PreciseDate {
  date: string | null;
  precision: DatePrecision;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function validDay(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "2026-03-14", "2026-03", "2026", "Q1 2027", "March 14, 2026", "Mar 2026", "TBA". Null if unreadable. */
export function parseDate(raw: string | null | undefined): PreciseDate | null {
  const v = cleanText(raw ?? "").toLowerCase();
  if (!v || /^(tba|tbd|tbc|coming soon|unknown)$/.test(v)) return { date: null, precision: "tba" };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:t.*)?$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? { date: `${y}-${pad(mo)}-${pad(d)}`, precision: "day" } : null;
  }
  m = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (m) {
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? { date: `${m[1]}-${pad(mo)}-01`, precision: "month" } : null;
  }
  m = /^(\d{4})$/.exec(v);
  if (m) return { date: `${m[1]}-01-01`, precision: "year" };
  m = /^q([1-4])[\s-]*(\d{4})$/.exec(v) ?? /^(\d{4})[\s-]*q([1-4])$/.exec(v);
  if (m) {
    const [q, y] = v.startsWith("q") ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    return { date: `${y}-${pad((q - 1) * 3 + 1)}-01`, precision: "quarter" };
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v);
  if (m) {
    const mo = MONTHS.indexOf((m[1] ?? "").slice(0, 3)) + 1;
    const [d, y] = [Number(m[2]), Number(m[3])];
    return mo > 0 && validDay(y, mo, d) ? { date: `${y}-${pad(mo)}-${pad(d)}`, precision: "day" } : null;
  }
  m = /^([a-z]+)\.?,?\s+(\d{4})$/.exec(v);
  if (m) {
    const mo = MONTHS.indexOf((m[1] ?? "").slice(0, 3)) + 1;
    return mo > 0 ? { date: `${m[2]}-${pad(mo)}-01`, precision: "month" } : null;
  }
  return null;
}
