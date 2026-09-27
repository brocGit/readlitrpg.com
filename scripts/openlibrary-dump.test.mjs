// node --test scripts/openlibrary-dump.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { extract, workToRow } from "./openlibrary-dump.mjs";

const line = (type, key, json) => [type, key, "1", "2026-01-01T00:00:00", JSON.stringify(json)].join("\t");

test("maps in-scope works to import rows with an Open Library confirmation", () => {
  const row = workToRow(
    {
      key: "/works/OL1W",
      title: "The Primal Hunter",
      subjects: ["Fantasy", "LitRPG", "System Apocalypse", "Harem"],
      first_publish_date: "March 2022",
    },
    ["Zogarth"],
  );
  assert.deepEqual(row, {
    input: {
      title: "The Primal Hunter",
      authors: [{ name: "Zogarth" }],
      primaryGenre: "litrpg",
      tags: [{ slug: "system-apocalypse", confidence: 0.6 }],
      firstPublished: "2022",
    },
    confirmation: { source: "openlibrary", ref: "/works/OL1W" },
  });
});

test("skips out-of-scope works and works without authors", () => {
  assert.equal(workToRow({ title: "Pride and Prejudice", subjects: ["Romance"] }, ["Jane Austen"]), null);
  assert.equal(workToRow({ title: "Mystery LitRPG", subjects: ["LitRPG"] }, []), null);
});

test("streams both dumps and writes NDJSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ol-"));
  const works = join(dir, "works.txt.gz");
  const authors = join(dir, "authors.txt.gz");
  const out = join(dir, "out.ndjson");
  writeFileSync(
    works,
    gzipSync(
      [
        line("/type/work", "/works/OL1W", {
          key: "/works/OL1W",
          title: "Unsouled",
          subjects: ["Cultivation", "Xianxia"],
          authors: [{ author: { key: "/authors/OL9A" } }],
        }),
        line("/type/work", "/works/OL2W", { key: "/works/OL2W", title: "Cookbook", subjects: ["Cooking"] }),
        "garbage line",
      ].join("\n"),
    ),
  );
  writeFileSync(
    authors,
    gzipSync(
      [
        line("/type/author", "/authors/OL9A", { key: "/authors/OL9A", name: "Will Wight" }),
        line("/type/author", "/authors/OL8A", { key: "/authors/OL8A", name: "Someone Else" }),
      ].join("\n"),
    ),
  );
  const result = await extract({ works, authors, out });
  assert.deepEqual(result, { scanned: 2, matched: 1, written: 1 });
  const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].input.title, "Unsouled");
  assert.deepEqual(rows[0].input.authors, [{ name: "Will Wight" }]);
  assert.equal(rows[0].input.primaryGenre, "cultivation");
});
