// Truth tables for field precedence (DESIGN §6.4) and tag scoring (DESIGN §6.2).

import { describe, expect, it } from "vitest";
import {
  resolveField,
  resolveTagScore,
  type SourcedValue,
  type TagEvidence,
} from "../src/catalog/provenance";
import type { FieldSource } from "../src/db/schema";

let seq = 0;
const v = (source: FieldSource, value: unknown, minute = 0): SourcedValue => ({
  source,
  value,
  createdAt: `2026-09-27T10:${String(minute).padStart(2, "0")}:00.000Z`,
  id: String(seq++).padStart(4, "0"),
});

describe("facts", () => {
  const cases: [string, SourcedValue[], unknown, FieldSource | null][] = [
    ["nothing", [], undefined, null],
    ["AI only", [v("ai", 300)], 300, "ai"],
    ["API beats AI", [v("ai", 300), v("api", 312)], 312, "api"],
    ["unverified author loses to API", [v("api", 312), v("author", 350, 5)], 312, "api"],
    ["verified author beats API", [v("api", 312), v("author_verified", 350)], 350, "author_verified"],
    ["admin beats everyone", [v("author_verified", 350), v("admin", 360), v("api", 312, 9)], 360, "admin"],
    ["newest within a rank", [v("api", 312, 1), v("api", 318, 2)], 318, "api"],
    ["reader suggestion is last", [v("reader", 999), v("ai", 300)], 300, "ai"],
    ["cited research ranks with the API", [v("author", 1), v("research", 2)], 2, "research"],
  ];
  for (const [name, rows, value, source] of cases) {
    it(name, () => expect(resolveField("pageCount", rows)).toEqual({ value, source }));
  }
});

describe("blurb", () => {
  it("only a verified author or the owner", () => {
    expect(resolveField("blurbAuthor", [v("ai", "copied?"), v("author", "unverified")])).toEqual({
      value: undefined,
      source: null,
    });
    expect(resolveField("blurbAuthor", [v("author_verified", "licensed")]).value).toBe("licensed");
    expect(resolveField("blurbAuthor", [v("author_verified", "a"), v("admin", "b")]).value).toBe("b");
  });
});

describe("subjective fields", () => {
  it("AI alone", () => expect(resolveField("crunchLevel", [v("ai", 3)])).toEqual({ value: 3, source: "ai" }));
  it("author blended 70/30 with the AI", () => {
    // 0.7 * 1 + 0.3 * 3 = 1.6 → 2
    expect(resolveField("crunchLevel", [v("ai", 3), v("author", 1)])).toEqual({ value: 2, source: "author" });
  });
  it("crowd beats the author", () => {
    expect(resolveField("romanceLevel", [v("author", 0), v("crowd", 2)])).toEqual({
      value: 2,
      source: "crowd",
    });
  });
  it("admin beats the crowd", () => {
    expect(resolveField("romanceLevel", [v("crowd", 2), v("admin", 1)])).toEqual({
      value: 1,
      source: "admin",
    });
  });
  it("non-numeric subjective values: author over AI", () => {
    expect(resolveField("primaryGenre", [v("ai", "gamelit"), v("author", "litrpg")]).value).toBe("litrpg");
  });
});

describe("harem (conservative exclusion filter)", () => {
  it("the most cautious of author and AI wins", () => {
    expect(resolveField("harem", [v("author", "none"), v("ai", "harem")])).toEqual({
      value: "harem",
      source: "ai",
    });
    expect(resolveField("harem", [v("author", "implied"), v("ai", "none")])).toEqual({
      value: "implied",
      source: "author",
    });
  });
  it("crowd and admin decide above that", () => {
    expect(resolveField("harem", [v("ai", "harem"), v("crowd", "none")]).value).toBe("none");
    expect(resolveField("harem", [v("crowd", "harem"), v("admin", "none")]).value).toBe("none");
  });
  it("unknown answers don't mask real ones", () => {
    expect(resolveField("harem", [v("ai", "unknown"), v("author", "none")]).value).toBe("none");
  });
});

describe("content flags (most cautious wins)", () => {
  it("unions every source", () => {
    expect(
      resolveField("contentFlags", [v("author", ["gore"]), v("ai", ["heavy-profanity", "gore"])]).value,
    ).toEqual(["gore", "heavy-profanity"]);
  });
  it("uses each source's latest answer", () => {
    expect(resolveField("contentFlags", [v("ai", ["gore"], 1), v("ai", [], 2)]).value).toEqual([]);
  });
  it("admin overrides", () => {
    expect(resolveField("contentFlags", [v("ai", ["gore"]), v("admin", [])]).value).toEqual([]);
  });
});

describe("AI-use attestation", () => {
  it("the AI can never set it", () => {
    expect(resolveField("isAiGenerated", [v("ai", "ai_generated")])).toEqual({
      value: undefined,
      source: null,
    });
  });
  it("author attestation, then admin", () => {
    expect(resolveField("isAiGenerated", [v("author", "human")]).value).toBe("human");
    expect(resolveField("isAiGenerated", [v("author", "human"), v("crowd", "ai_generated")]).value).toBe(
      "human",
    );
    expect(resolveField("isAiGenerated", [v("author", "human"), v("admin", "ai_assisted")]).value).toBe(
      "ai_assisted",
    );
  });
});

describe("tag scores", () => {
  const e = (x: Partial<TagEvidence>): TagEvidence => ({
    adminLocked: false,
    adminValue: null,
    aiConfidence: null,
    authorAsserted: null,
    crowdUp: 0,
    crowdDown: 0,
    ...x,
  });
  const cases: [string, Partial<TagEvidence>, number][] = [
    ["no evidence", {}, 0],
    ["AI only", { aiConfidence: 0.8 }, 0.8],
    ["author yes, no AI", { authorAsserted: true }, 0.9],
    ["author yes blended with AI", { authorAsserted: true, aiConfidence: 0.5 }, 0.78],
    ["author no blended with AI", { authorAsserted: false, aiConfidence: 0.9 }, 0.34],
    ["few crowd votes don't count yet", { aiConfidence: 0.8, crowdUp: 0, crowdDown: 5 }, 0.8],
    ["crowd takes over at the threshold", { aiConfidence: 0.8, crowdUp: 0, crowdDown: 8 }, 0.267],
    ["crowd agrees", { aiConfidence: 0.6, crowdUp: 10, crowdDown: 0 }, 0.886],
    ["admin lock wins", { adminLocked: true, adminValue: 0, aiConfidence: 0.99, crowdUp: 50 }, 0],
  ];
  for (const [name, evidence, score] of cases) {
    it(name, () => expect(resolveTagScore(e(evidence), 8)).toBeCloseTo(score, 3));
  }
});
