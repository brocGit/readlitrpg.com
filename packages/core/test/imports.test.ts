import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createImport,
  parseCatalogCsv,
  parseCsv,
  parseNdjson,
  parseSeedFile,
  processImportChunk,
  type SeedFile,
} from "../src/catalog";
import { createDb, type Db } from "../src/db";
import {
  books,
  catalogConfirmations,
  catalogImportRows,
  catalogImports,
  editions,
  series,
} from "../src/db/schema";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

describe("CSV parsing", () => {
  it("handles quotes, commas, newlines, CRLF and a BOM", () => {
    const text = '﻿title,notes\r\n"Unsouled, Book 1","He said ""go""\nthen left"\r\nSoulsmith,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["title", "notes"],
      ["Unsouled, Book 1", 'He said "go"\nthen left'],
      ["Soulsmith", ""],
    ]);
  });

  it("maps flexible headers onto book input", () => {
    const csv = [
      "Title,Author,Series,Book,Genre,Tags,Crunch,Harem,Published,ASIN,Narrator,KU,Links,Random Column",
      "Unsouled,Will Wight,Cradle,1,progression-fantasy,cultivation; academy,0,none,2016-04-01,B01EHRFSEC,Travis Baldree,yes,https://www.royalroad.com/fiction/1234,x",
    ].join("\n");
    const parsed = parseCatalogCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.notes).toEqual(["ignored columns: Random Column"]);
    expect(parsed.rows[0]).toMatchObject({
      rowNum: 2,
      row: {
        input: {
          title: "Unsouled",
          authors: [{ name: "Will Wight" }],
          series: { name: "Cradle", position: 1 },
          primaryGenre: "progression-fantasy",
          tags: [{ slug: "cultivation" }, { slug: "academy" }],
          crunchLevel: 0,
          harem: "none",
          firstPublished: "2016-04-01",
          editions: [
            { format: "ebook", asin: "B01EHRFSEC", kindleUnlimited: true },
            { format: "audiobook", narrators: ["Travis Baldree"] },
          ],
          links: ["https://www.royalroad.com/fiction/1234"],
        },
      },
    });
  });

  it("reports bad rows by spreadsheet row number", () => {
    const parsed = parseCatalogCsv("title,authors,crunch\nGood,Someone,1\n,Nobody,1\nBad Crunch,X,9\n");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors.map((e) => e.rowNum)).toEqual([3, 4]);
  });

  it("requires title and author columns", () => {
    expect(parseCatalogCsv("name,writer\nx,y").errors[0]?.message).toMatch(/title and an author/);
  });
});

const seedFile: SeedFile = {
  format: "readlitrpg-seed",
  version: 1,
  generated_by: "test",
  entries: [
    {
      name: "Cradle",
      authors: ["Will Wight"],
      status: "complete",
      genre: "progression-fantasy",
      tags: ["cultivation", "weak-to-strong"],
      tag_confidence: "high",
      crunch: 0,
      romance: 1,
      harem: "none",
      confidence: "high",
      books: [
        { position: 1, title: "Unsouled", year: 2016 },
        { position: 2, title: "Soulsmith", year: 2016 },
        { position: 3, title: "Probably Wrong Title", confidence: "low" },
      ],
    },
  ],
};

describe("seed files", () => {
  it("turns series entries into books and leaves low-confidence titles out", () => {
    const parsed = parseSeedFile(JSON.stringify(seedFile));
    expect(parsed.errors).toEqual([]);
    expect(parsed.notes).toEqual(["1 low-confidence book(s) left out"]);
    expect(parsed.rows.map((r) => r.row.input.title)).toEqual(["Unsouled", "Soulsmith"]);
    expect(parsed.rows[0]?.row.input).toMatchObject({
      series: { name: "Cradle", position: 1, status: "complete" },
      tags: [
        { slug: "cultivation", confidence: 0.85 },
        { slug: "weak-to-strong", confidence: 0.85 },
      ],
      firstPublished: "2016",
      confidence: 0.85,
    });
  });

  it("rejects malformed files with the path of the problem", () => {
    const bad = { ...seedFile, entries: [{ ...seedFile.entries[0], authors: [] }] };
    const parsed = parseSeedFile(JSON.stringify(bad));
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]?.message).toMatch(/entries\.0\.authors/);
    expect(parseSeedFile("{nope").errors[0]?.message).toBe("not valid JSON");
  });
});

describe("NDJSON extracts", () => {
  it("carries a confirmation per row", () => {
    const line = JSON.stringify({
      input: { title: "Unsouled", authors: [{ name: "Will Wight" }] },
      confirmation: { source: "openlibrary", ref: "/works/OL1W" },
    });
    const parsed = parseNdjson(`${line}\n\nnot json\n`);
    expect(parsed.rows[0]?.row.confirmation).toEqual({ source: "openlibrary", ref: "/works/OL1W" });
    expect(parsed.errors).toEqual([{ rowNum: 3, message: "not valid JSON" }]);
  });
});

describe("processing imports in chunks", () => {
  const opts = { chunkSize: 2, fuzzyMin: 0.6, crowdMinVotes: 8 };

  it("ingests a seed import chunk by chunk and keeps seeds unconfirmed", async () => {
    const parsed = parseSeedFile(JSON.stringify(seedFile));
    const id = await createImport(db, {
      kind: "seed",
      filename: "seed.json",
      fieldSource: "ai",
      origin: "ai_seed",
      createdBy: "owner",
      rows: parsed.rows,
    });
    const first = await processImportChunk(db, opts);
    expect(first).toEqual({ importId: id, processed: 2, remaining: 0 });
    const [job] = await db.select().from(catalogImports);
    expect(job).toMatchObject({ status: "done", total: 2, processed: 2, created: 2, failed: 0 });
    const rows = await db.select().from(books);
    expect(rows.every((b) => b.origin === "ai_seed" && b.confirmedAt === null)).toBe(true);
    expect((await db.select().from(series))[0]?.status).toBe("complete");
    // Nothing left to do.
    expect(await processImportChunk(db, opts)).toEqual({ importId: null, processed: 0, remaining: 0 });
  });

  it("the owner's CSV confirms its rows, and re-imports only match", async () => {
    const csv =
      "title,authors,asin\nUnsouled,Will Wight,B01EHRFSEC\nSoulsmith,Will Wight,\nBlackflame,Will Wight,\n";
    const parsed = parseCatalogCsv(csv);
    await createImport(db, {
      kind: "csv",
      filename: "a.csv",
      fieldSource: "admin",
      origin: "admin",
      createdBy: "owner",
      rows: parsed.rows,
    });
    const a = await processImportChunk(db, opts);
    expect(a).toMatchObject({ processed: 2, remaining: 1 });
    const b = await processImportChunk(db, opts);
    expect(b).toMatchObject({ processed: 1, remaining: 0 });
    expect((await db.select().from(catalogConfirmations)).map((c) => c.source)).toEqual([
      "owner_check",
      "owner_check",
      "owner_check",
    ]);
    expect(await db.select().from(editions)).toHaveLength(1);

    await createImport(db, {
      kind: "csv",
      filename: "again.csv",
      fieldSource: "admin",
      origin: "admin",
      createdBy: "owner",
      rows: parsed.rows,
    });
    await processImportChunk(db, { ...opts, chunkSize: 10 });
    const [, second] = await db.select().from(catalogImports).orderBy(catalogImports.createdAt);
    expect(second).toMatchObject({ created: 0, matched: 3 });
    expect(await db.select().from(books)).toHaveLength(3);
  });

  it("records row failures without stopping the import", async () => {
    const id = await createImport(db, {
      kind: "csv",
      filename: "x.csv",
      fieldSource: "admin",
      origin: "admin",
      createdBy: "owner",
      rows: [
        { rowNum: 2, row: { input: { title: "???", authors: [{ name: "X" }] } } },
        { rowNum: 3, row: { input: { title: "Fine", authors: [{ name: "X" }] } } },
      ],
    });
    await processImportChunk(db, { ...opts, chunkSize: 10 });
    const rows = await db
      .select()
      .from(catalogImportRows)
      .where(eq(catalogImportRows.importId, id))
      .orderBy(catalogImportRows.rowNum);
    expect(rows.map((r) => r.status)).toEqual(["error", "done"]);
    expect((rows[0]?.result as { error: string }).error).toMatch(/no letters or numbers/);
    const [job] = await db.select().from(catalogImports);
    expect(job).toMatchObject({ status: "done", failed: 1, created: 1 });
  });
});
