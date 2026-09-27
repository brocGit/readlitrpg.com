// Every seed file in data/seed must parse, use only real tags and genres, and not repeat a series.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createImport, nameKey, parseSeedFile, processImportChunk, seedFileSchema } from "../src/catalog";
import { createDb } from "../src/db";
import { books, catalogImports, inboxItems, series } from "../src/db/schema";
import { ACTIVE_TAG_SLUGS, GENRE_SLUGS, syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

const DIR = join(import.meta.dirname, "../../../data/seed");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("seed data", () => {
  it("exists", () => expect(files.length).toBeGreaterThan(0));

  const seen = new Map<string, string>();
  for (const file of files) {
    it(`${file} is valid`, () => {
      const text = readFileSync(join(DIR, file), "utf8");
      const parsed = parseSeedFile(text);
      expect(parsed.errors).toEqual([]);
      const data = seedFileSchema.parse(JSON.parse(text));
      for (const entry of data.entries) {
        const label = `${file}: ${entry.name ?? entry.books[0]?.title}`;
        expect(GENRE_SLUGS.has(entry.genre), `${label} genre ${entry.genre}`).toBe(true);
        for (const tag of entry.tags) expect(ACTIVE_TAG_SLUGS.has(tag), `${label} tag ${tag}`).toBe(true);
        const key = `${nameKey(entry.name ?? entry.books[0]?.title ?? "")}|${nameKey(entry.authors[0] ?? "")}`;
        expect(seen.get(key), `${label} is also in ${seen.get(key)}`).toBeUndefined();
        seen.set(key, file);
        const positions = entry.books.map((b) => b.position).filter((p) => p !== undefined);
        expect(new Set(positions).size, `${label} repeats a position`).toBe(positions.length);
      }
    });
  }
});

describe("seed import", () => {
  it("every seed file ingests without failures, duplicates or unknown tags", async () => {
    const db = createDb(createTestD1().asD1());
    await syncTaxonomy(db);
    let expected = 0;
    for (const file of files) {
      const parsed = parseSeedFile(readFileSync(join(DIR, file), "utf8"));
      expected += parsed.rows.length;
      await createImport(db, {
        kind: "seed",
        filename: file,
        fieldSource: "ai",
        origin: "ai_seed",
        createdBy: "test",
        rows: parsed.rows,
      });
    }
    for (let i = 0; i < 100; i++) {
      const r = await processImportChunk(db, { chunkSize: 40, fuzzyMin: 0.6, crowdMinVotes: 8 });
      if (!r.importId) break;
    }
    const imports = await db.select().from(catalogImports);
    expect(imports.every((i) => i.status === "done" && i.failed === 0)).toBe(true);
    const created = imports.reduce((n, i) => n + i.created, 0);
    expect(created).toBe(expected);
    expect(await db.select().from(books)).toHaveLength(expected);
    expect(await db.select().from(inboxItems)).toEqual([]);
    const rows = await db.select().from(books);
    expect(
      rows.every((b) => b.visibility === "draft" && b.confirmedAt === null && b.origin === "ai_seed"),
    ).toBe(true);
    expect((await db.select().from(series)).length).toBeGreaterThan(90);
  }, 60_000);
});
