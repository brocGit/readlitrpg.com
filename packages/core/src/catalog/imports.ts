// Bulk imports (DESIGN §7.15): the owner's CSV files, seed files from editorial runs, and Open
// Library dump extracts. A file is validated in full first (nothing is stored if any row is bad),
// then stored as rows and ingested in chunks by the `catalog.import` job, because a Worker may run
// at most 1,000 D1 queries per invocation.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import {
  CONFIRMATION_SOURCES,
  type ConfirmationSource,
  catalogImportRows,
  catalogImports,
  type FieldSource,
  HAREM,
  IN_SCOPE,
  type Origin,
  SERIES_STATUS,
} from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";
import { type IngestContext, ingestBook } from "./ingest";
import { type BookInput, bookInputSchema } from "./input";
import { CONFIDENCE_VALUES } from "./provenance";

export const MAX_IMPORT_ROWS = 5_000;

export interface ImportRow {
  input: BookInput;
  confirmation?: { source: ConfirmationSource; ref?: string };
}

export interface ParsedFile {
  rows: { rowNum: number; row: ImportRow }[];
  errors: { rowNum: number; message: string }[];
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, CRLF or LF)

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Accepted CSV headers (case, spaces and underscores don't matter) and the field each fills. */
const CSV_COLUMNS: Record<string, string> = {
  title: "title",
  subtitle: "subtitle",
  author: "authors",
  authors: "authors",
  series: "series",
  seriesposition: "position",
  position: "position",
  book: "position",
  seriesstatus: "seriesStatus",
  genre: "genre",
  primarygenre: "genre",
  tags: "tags",
  crunch: "crunch",
  crunchlevel: "crunch",
  romance: "romance",
  romancelevel: "romance",
  harem: "harem",
  contentflags: "contentFlags",
  firstpublished: "published",
  published: "published",
  pages: "pages",
  pagecount: "pages",
  words: "words",
  wordcount: "words",
  language: "language",
  asin: "asin",
  isbn: "isbn",
  audibleasin: "audibleAsin",
  format: "format",
  narrator: "narrators",
  narrators: "narrators",
  publisher: "publisher",
  ku: "ku",
  kindleunlimited: "ku",
  links: "links",
  link: "links",
  url: "links",
  releasedate: "releaseDate",
  releasekind: "releaseKind",
  inscope: "inScope",
  blurb: "blurb",
  notes: "ignore",
};

const list = (v: string) =>
  v
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(/,/g, "")));
const bool = (v: string) => {
  const t = v.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(t)) return true;
  if (["no", "n", "false", "0"].includes(t)) return false;
  return undefined;
};

export function parseCatalogCsv(text: string): ParsedFile {
  const table = parseCsv(text);
  const [header, ...body] = table;
  const result: ParsedFile = { rows: [], errors: [], notes: [] };
  if (!header) {
    result.errors.push({ rowNum: 0, message: "the file is empty" });
    return result;
  }
  const columns = header.map((h) => CSV_COLUMNS[h.toLowerCase().replace(/[\s_-]+/g, "")] ?? null);
  const unknown = header.filter((_, i) => columns[i] === null);
  if (unknown.length) result.notes.push(`ignored columns: ${unknown.join(", ")}`);
  if (!columns.includes("title") || !columns.includes("authors")) {
    result.errors.push({ rowNum: 1, message: "needs at least a title and an author column" });
    return result;
  }
  if (body.length > MAX_IMPORT_ROWS) {
    result.errors.push({ rowNum: 0, message: `at most ${MAX_IMPORT_ROWS} rows per file` });
    return result;
  }
  for (const [i, cells] of body.entries()) {
    const rowNum = i + 2; // spreadsheet numbering: the header is row 1
    const get = (key: string) => {
      const index = columns.indexOf(key);
      return index >= 0 ? (cells[index] ?? "").trim() : "";
    };
    const asin = get("asin");
    const isbn = get("isbn");
    const audibleAsin = get("audibleAsin");
    const format = get("format").toLowerCase() || (isbn && !asin ? "paperback" : "ebook");
    const editions = [];
    if (asin || isbn || get("publisher") || get("ku")) {
      editions.push({
        format,
        ...(asin ? { asin } : {}),
        ...(isbn ? { isbn } : {}),
        ...(get("publisher") ? { publisher: get("publisher") } : {}),
        ...(bool(get("ku")) !== undefined ? { kindleUnlimited: bool(get("ku")) } : {}),
      });
    }
    if (audibleAsin || get("narrators")) {
      editions.push({
        format: "audiobook",
        ...(audibleAsin ? { audibleAsin } : {}),
        ...(get("narrators") ? { narrators: list(get("narrators")) } : {}),
      });
    }
    const candidate = {
      title: get("title"),
      subtitle: get("subtitle") || undefined,
      authors: list(get("authors")).map((name) => ({ name })),
      series: get("series")
        ? {
            name: get("series"),
            position: num(get("position")),
            status: get("seriesStatus") || undefined,
          }
        : undefined,
      primaryGenre: get("genre") || undefined,
      tags: get("tags")
        ? get("tags")
            .split(/[;,|]/)
            .map((t) => t.trim())
            .filter(Boolean)
            .map((slug) => ({ slug }))
        : undefined,
      crunchLevel: num(get("crunch")),
      romanceLevel: num(get("romance")),
      harem: get("harem").toLowerCase().replace(/\s+/g, "_") || undefined,
      contentFlags: get("contentFlags") ? list(get("contentFlags")) : undefined,
      firstPublished: get("published") || undefined,
      pageCount: num(get("pages")),
      wordCountEst: num(get("words")),
      language: get("language").toLowerCase() || undefined,
      inScope: get("inScope").toLowerCase() || undefined,
      blurb: get("blurb") || undefined,
      editions: editions.length ? editions : undefined,
      links: get("links")
        ? get("links")
            .split(/[\s;|]+/)
            .filter(Boolean)
        : undefined,
      releases: get("releaseDate")
        ? [{ kind: get("releaseKind").toLowerCase() || "ebook", date: get("releaseDate") }]
        : undefined,
    };
    const parsed = bookInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({
        rowNum,
        message: `${issue?.path.join(".") || "row"}: ${issue?.message ?? "invalid"}`,
      });
      continue;
    }
    result.rows.push({ rowNum, row: { input: parsed.data } });
  }
  return result;
}

export const CSV_TEMPLATE_HEADER =
  "title,authors,series,series_position,genre,tags,crunch,romance,harem,first_published,pages,asin,isbn,audible_asin,narrators,publisher,ku,links,release_date,release_kind";

// ---------------------------------------------------------------------------------------------
// Seed files (DESIGN §7.15 AI seed rules): series first, fields only when confident

const confidenceLabel = z.enum(["high", "medium", "low"]);

const seedBookSchema = z.object({
  position: z.number().min(0).max(1000).optional(),
  title: z.string().trim().min(1).max(300),
  year: z.number().int().min(1950).max(2100).optional(),
  confidence: confidenceLabel.optional(),
});

const seedEntrySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  authors: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  status: z.enum(SERIES_STATUS).optional(),
  genre: z.string().trim().max(60),
  tags: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
  tag_confidence: confidenceLabel.default("medium"),
  crunch: z.number().int().min(0).max(3).optional(),
  romance: z.number().int().min(0).max(4).optional(),
  harem: z.enum(HAREM).optional(),
  in_scope: z.enum(IN_SCOPE).optional(),
  confidence: confidenceLabel.default("medium"),
  books: z.array(seedBookSchema).min(1).max(100),
  links: z.array(z.string().url()).max(5).optional(),
  notes: z.string().max(500).optional(),
});

export const seedFileSchema = z.object({
  format: z.literal("readlitrpg-seed"),
  version: z.literal(1),
  generated_by: z.string().max(200),
  entries: z.array(seedEntrySchema).min(1).max(2_000),
});

export type SeedFile = z.infer<typeof seedFileSchema>;
export type SeedEntry = z.infer<typeof seedEntrySchema>;

/** Low-confidence book titles are left out entirely: better missing than wrong. */
export function seedEntryToInputs(entry: SeedEntry): BookInput[] {
  const overall = CONFIDENCE_VALUES[entry.confidence];
  const tagConfidence = CONFIDENCE_VALUES[entry.tag_confidence];
  const out: BookInput[] = [];
  for (const [i, b] of entry.books.entries()) {
    const bookConfidence = b.confidence ?? entry.confidence;
    if (bookConfidence === "low") continue;
    out.push({
      title: b.title,
      authors: entry.authors.map((name) => ({ name })),
      ...(entry.name
        ? {
            series: {
              name: entry.name,
              position: b.position ?? i + 1,
              ...(entry.status ? { status: entry.status } : {}),
            },
          }
        : {}),
      primaryGenre: entry.genre,
      tags: entry.tags.map((slug) => ({ slug, confidence: tagConfidence })),
      ...(entry.crunch !== undefined ? { crunchLevel: entry.crunch } : {}),
      ...(entry.romance !== undefined ? { romanceLevel: entry.romance } : {}),
      ...(entry.harem ? { harem: entry.harem } : {}),
      ...(entry.in_scope ? { inScope: entry.in_scope } : {}),
      ...(b.year ? { firstPublished: String(b.year) } : {}),
      ...(i === 0 && entry.links ? { links: entry.links } : {}),
      confidence: Math.min(overall, CONFIDENCE_VALUES[bookConfidence]),
    });
  }
  return out;
}

export function parseSeedFile(text: string): ParsedFile {
  const result: ParsedFile = { rows: [], errors: [], notes: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    result.errors.push({ rowNum: 0, message: "not valid JSON" });
    return result;
  }
  const parsed = seedFileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      const entry = issue.path[1];
      result.errors.push({
        rowNum: typeof entry === "number" ? entry + 1 : 0,
        message: `${issue.path.join(".")}: ${issue.message}`,
      });
    }
    return result;
  }
  let rowNum = 0;
  let skipped = 0;
  for (const entry of parsed.data.entries) {
    const inputs = seedEntryToInputs(entry);
    skipped += entry.books.length - inputs.length;
    for (const input of inputs) {
      const check = bookInputSchema.safeParse(input);
      rowNum++;
      if (check.success) result.rows.push({ rowNum, row: { input: check.data } });
      else result.errors.push({ rowNum, message: check.error.issues[0]?.message ?? "invalid" });
    }
  }
  if (skipped) result.notes.push(`${skipped} low-confidence book(s) left out`);
  if (result.rows.length > MAX_IMPORT_ROWS)
    result.errors.push({ rowNum: 0, message: `at most ${MAX_IMPORT_ROWS} books per file` });
  return result;
}

/** One NDJSON line per book: `{ "input": BookInput, "confirmation": {…} }` (the Open Library dump extract). */
export function parseNdjson(text: string): ParsedFile {
  const result: ParsedFile = { rows: [], errors: [], notes: [] };
  const rowSchema = z.object({
    input: bookInputSchema,
    confirmation: z
      .object({ source: z.enum(CONFIRMATION_SOURCES), ref: z.string().max(200).optional() })
      .optional(),
  });
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = rowSchema.safeParse(JSON.parse(line));
      if (parsed.success) result.rows.push({ rowNum: i + 1, row: parsed.data });
      else result.errors.push({ rowNum: i + 1, message: parsed.error.issues[0]?.message ?? "invalid" });
    } catch {
      result.errors.push({ rowNum: i + 1, message: "not valid JSON" });
    }
  }
  if (result.rows.length > MAX_IMPORT_ROWS)
    result.errors.push({ rowNum: 0, message: `at most ${MAX_IMPORT_ROWS} rows per file` });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Storing and processing

export async function createImport(
  db: Db,
  opts: {
    kind: "csv" | "seed" | "ol_dump";
    filename: string | null;
    fieldSource: FieldSource;
    origin: Origin;
    createdBy: string;
    rows: ParsedFile["rows"];
  },
): Promise<string> {
  const id = ulid();
  await db.insert(catalogImports).values({
    id,
    kind: opts.kind,
    filename: opts.filename,
    fieldSource: opts.fieldSource,
    origin: opts.origin,
    total: opts.rows.length,
    createdBy: opts.createdBy,
  });
  // 5 parameters per row and at most 100 per statement: 19 rows per insert, 25 inserts per batch.
  const statements = [];
  for (let i = 0; i < opts.rows.length; i += 19) {
    statements.push(
      db
        .insert(catalogImportRows)
        .values(opts.rows.slice(i, i + 19).map((r) => ({ importId: id, rowNum: r.rowNum, payload: r.row }))),
    );
  }
  for (let i = 0; i < statements.length; i += 25) {
    const batch = statements.slice(i, i + 25);
    await db.batch(batch as [(typeof batch)[number], ...typeof batch]);
  }
  return id;
}

export interface ChunkResult {
  importId: string | null;
  processed: number;
  remaining: number;
}

/** Ingest the next chunk of the oldest unfinished import. */
export async function processImportChunk(
  db: Db,
  opts: { chunkSize: number; fuzzyMin: number; crowdMinVotes: number },
): Promise<ChunkResult> {
  const [job] = await db
    .select()
    .from(catalogImports)
    .where(inArray(catalogImports.status, ["queued", "processing"]))
    .orderBy(asc(catalogImports.createdAt))
    .limit(1);
  if (!job) return { importId: null, processed: 0, remaining: 0 };
  if (job.status === "queued") {
    await db.update(catalogImports).set({ status: "processing" }).where(eq(catalogImports.id, job.id));
  }
  const rows = await db
    .select()
    .from(catalogImportRows)
    .where(and(eq(catalogImportRows.importId, job.id), eq(catalogImportRows.status, "pending")))
    .orderBy(asc(catalogImportRows.rowNum))
    .limit(opts.chunkSize);

  const counts = { created: 0, matched: 0, flagged: 0, failed: 0 };
  for (const r of rows) {
    const row = r.payload as ImportRow;
    const ctx: IngestContext = {
      source: job.fieldSource,
      origin: job.origin,
      sourceRef: `import:${job.id}:${r.rowNum}`,
      actorId: job.createdBy,
      fuzzyMin: opts.fuzzyMin,
      crowdMinVotes: opts.crowdMinVotes,
      // The owner's own file vouches for its rows; seeds and dumps need their own confirmation.
      confirmation: row.confirmation
        ? { source: row.confirmation.source, ref: row.confirmation.ref }
        : job.kind === "csv" && job.fieldSource === "admin"
          ? { source: "owner_check", ref: `import:${job.id}` }
          : undefined,
    };
    let status: "done" | "error" = "done";
    let result: unknown;
    try {
      const out = await ingestBook(db, bookInputSchema.parse(row.input), ctx);
      result = out;
      if (out.created) counts.created++;
      else counts.matched++;
      if (out.duplicates.length) counts.flagged++;
    } catch (error) {
      status = "error";
      result = { error: error instanceof Error ? error.message : String(error) };
      counts.failed++;
    }
    await db
      .update(catalogImportRows)
      .set({ status, result, processedAt: nowIso() })
      .where(and(eq(catalogImportRows.importId, job.id), eq(catalogImportRows.rowNum, r.rowNum)));
  }

  const [{ remaining } = { remaining: 0 }] = await db
    .select({ remaining: sql<number>`count(*)` })
    .from(catalogImportRows)
    .where(and(eq(catalogImportRows.importId, job.id), eq(catalogImportRows.status, "pending")));
  await db
    .update(catalogImports)
    .set({
      processed: sql`${catalogImports.processed} + ${rows.length}`,
      created: sql`${catalogImports.created} + ${counts.created}`,
      matched: sql`${catalogImports.matched} + ${counts.matched}`,
      flagged: sql`${catalogImports.flagged} + ${counts.flagged}`,
      failed: sql`${catalogImports.failed} + ${counts.failed}`,
      ...(remaining === 0 ? { status: "done" as const, finishedAt: nowIso() } : {}),
    })
    .where(eq(catalogImports.id, job.id));
  return { importId: job.id, processed: rows.length, remaining };
}
