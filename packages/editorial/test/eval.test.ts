import { describe, expect, it } from "vitest";
import {
  evalWorkItems,
  type GoldenEntry,
  gate,
  lintGolden,
  parseGolden,
  scoreEval,
  toBaseline,
} from "../src/eval";

const golden: GoldenEntry[] = [
  {
    id: "g001",
    book: { title: "Harem Quest", authors: ["A"] },
    labels: {
      in_scope: "yes",
      primary_genre: "litrpg",
      tags: ["system-apocalypse", "male-mc"],
      crunch_level: 2,
      romance_level: 3,
      harem: "harem",
      content_flags: ["explicit-sex"],
      dials: { pacing: 7, romance: 7 },
    },
  },
  {
    id: "g002",
    book: { title: "Cozy Farm", authors: ["B"] },
    labels: {
      in_scope: "yes",
      primary_genre: "cultivation",
      tags: ["cozy", "farming"],
      crunch_level: 0,
      romance_level: 1,
      harem: "none",
      content_flags: [],
      dials: { pacing: 2 },
    },
  },
];

const answer = (id: string, over: Record<string, unknown>) => ({
  kind: "classify",
  item_id: `eval-${id}`,
  book_id: id,
  in_scope: "yes",
  primary_genre: "litrpg",
  tags: [],
  crunch_level: { value: "unknown", confidence: "low" },
  romance_level: { value: "unknown", confidence: "low" },
  harem: { value: "unknown", confidence: "low" },
  known_work: "yes",
  dials: {},
  stats: {},
  content_flags: [],
  summary: null,
  hook: null,
  anomalies: [],
  ...over,
});

describe("the eval harness", () => {
  it("scores tags, exclusions, ordinals and dials", () => {
    const report = scoreEval(golden, [
      answer("g001", {
        tags: [
          { slug: "system-apocalypse", confidence: "high", evidence: "e" },
          { slug: "vrmmo", confidence: "medium", evidence: "e" },
        ],
        crunch_level: { value: 2, confidence: "high" },
        romance_level: { value: 3, confidence: "medium" },
        harem: { value: "harem", confidence: "high" },
        dials: { pacing: { value: 5, confidence: "medium" }, romance: { value: 7, confidence: "medium" } },
      }),
      answer("g002", {
        primary_genre: "cultivation",
        tags: [
          { slug: "cozy", confidence: "high", evidence: "e" },
          { slug: "farming", confidence: "low", evidence: "e" },
        ],
        harem: { value: "none", confidence: "high" },
        dials: { pacing: { value: 3, confidence: "low" } },
      }),
    ]);
    expect(report.answered).toBe(2);
    expect(report.primary_genre_accuracy).toBe(1);
    expect(report.harem_accuracy).toBe(1);
    // harem ✓, romance ≥3 ✓, explicit-sex ✗
    expect(report.exclusion).toMatchObject({
      positives: 3,
      recall: 0.667,
      missed: ["g001 flag:explicit-sex"],
    });
    expect(report.facets.premise).toMatchObject({ precision: 0.5, recall: 1 });
    // farming was only "low": not shown, so it's a miss for the activity facet.
    expect(report.facets.activity?.recall).toBe(0);
    expect(report.dial_mae.pacing).toEqual({ mae: 1.5, n: 2 });
    expect(report.ordinal_mae.crunch_level).toBe(0);
  });

  it("gates on exclusion recall, macro-F1 and dial error", () => {
    const good = scoreEval(golden, [
      answer("g001", {
        tags: [{ slug: "system-apocalypse", confidence: "high", evidence: "e" }],
        romance_level: { value: 3, confidence: "medium" },
        harem: { value: "harem", confidence: "high" },
        content_flags: ["explicit-sex"],
        dials: { pacing: { value: 7, confidence: "medium" } },
      }),
    ]);
    const baseline = toBaseline(good);
    expect(gate(good, baseline)).toEqual([]);
    const worse = scoreEval(golden, [
      answer("g001", {
        tags: [{ slug: "system-apocalypse", confidence: "high", evidence: "e" }],
        harem: { value: "none", confidence: "high" },
        dials: { pacing: { value: 1, confidence: "medium" } },
      }),
    ]);
    const failures = gate(worse, baseline);
    expect(failures.join("\n")).toMatch(/exclusion recall/);
    expect(failures.join("\n")).toMatch(/pacing dial error/);
  });

  it("checks the golden set and builds blind inputs", () => {
    const text = golden.map((g) => JSON.stringify(g)).join("\n");
    expect(parseGolden(text)).toHaveLength(2);
    expect(() => parseGolden(`${text}\n${JSON.stringify(golden[0])}`)).toThrow(/twice/);
    expect(lintGolden(golden)).toEqual([]);
    const broken = { ...golden[1], labels: { ...golden[1]?.labels, tags: ["not-a-tag"] } } as GoldenEntry;
    expect(lintGolden([broken])).toEqual(["g002: unknown tag not-a-tag"]);
    const [item] = evalWorkItems(golden);
    expect(item).toMatchObject({
      item_id: "eval-g001",
      input: { book: { id: "g001", title: "Harem Quest" } },
    });
    expect(JSON.stringify(item)).not.toContain('harem"');
  });
});
