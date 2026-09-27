import { describe, expect, it } from "vitest";
import { applyResolutions, mergePasses } from "../src/golden";

const inputs = [{ item_id: "eval-g001", input: { book: { id: "g001", title: "Book One", authors: ["A"] } } }];

const pass = (over: Record<string, unknown>) => ({
  kind: "classify",
  item_id: "eval-g001",
  book_id: "g001",
  in_scope: "yes",
  primary_genre: "litrpg",
  tags: [],
  crunch_level: { value: 2, confidence: "medium" },
  romance_level: { value: 1, confidence: "medium" },
  harem: { value: "none", confidence: "high" },
  known_work: "yes",
  dials: {},
  stats: {},
  content_flags: [],
  summary: null,
  hook: null,
  anomalies: [],
  ...over,
});

describe("merging two labeling passes", () => {
  it("keeps agreements, averages close dials, and lists disagreements", () => {
    const a = pass({
      tags: [
        { slug: "male-mc", confidence: "high", evidence: "Jake." },
        { slug: "cozy", confidence: "medium", evidence: "Low stakes." },
        { slug: "humorous", confidence: "low", evidence: "Jokes." },
      ],
      dials: { pacing: { value: 6, confidence: "medium" }, lore: { value: 2, confidence: "low" } },
      content_flags: ["graphic-violence"],
    });
    const b = pass({
      tags: [
        { slug: "male-mc", confidence: "medium", evidence: "Jake is the MC." },
        { slug: "cozy", confidence: "low", evidence: "Some downtime." },
      ],
      harem: { value: "implied", confidence: "low" },
      dials: { pacing: { value: 8, confidence: "medium" }, lore: { value: 9, confidence: "medium" } },
    });
    const merged = mergePasses(inputs, [a], [b]);
    const entry = merged.entries[0];
    expect(entry?.labels.tags).toEqual(["male-mc"]);
    expect(entry?.labels.dials).toEqual({ pacing: 7 });
    expect(merged.conflicts.map((c) => c.field).sort()).toEqual([
      "dial:lore",
      "flag:graphic-violence",
      "harem",
      "tag:cozy",
    ]);

    const { golden, open } = applyResolutions(merged, [
      { id: "g001", field: "harem", value: "none", reason: "Single love interest." },
      { id: "g001", field: "tag:cozy", value: true, reason: "Mostly low stakes." },
      { id: "g001", field: "flag:graphic-violence", value: false, reason: "Fights aren't graphic." },
    ]);
    expect(open.map((o) => o.field)).toEqual(["dial:lore"]);
    expect(golden[0]?.labels).toMatchObject({ harem: "none", tags: ["cozy", "male-mc"], content_flags: [] });
    expect(golden[0]?.evidence?.["tag:cozy"]).toMatch(/adjudicated/);
  });

  it("never drops an exclusion tag without adjudication", () => {
    const a = pass({ tags: [{ slug: "grimdark", confidence: "low", evidence: "Bleak world." }] });
    const merged = mergePasses(inputs, [a], [pass({})]);
    expect(merged.conflicts.map((c) => c.field)).toContain("tag:grimdark");
  });
});
