import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { tags } from "../src/db/schema";
import {
  ACTIVE_TAG_SLUGS,
  canonicalTagSlug,
  crunchLevelFromDial,
  DIAL_KEYS,
  findTag,
  GENRE_SLUGS,
  romanceLevelFromDial,
  STAT_KEYS,
  syncTaxonomy,
  TAGS,
} from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(() => {
  db = createDb(createTestD1().asD1());
});

describe("taxonomy", () => {
  it("has the vocabulary the design promises", () => {
    expect(DIAL_KEYS.size).toBe(17);
    expect(STAT_KEYS.size).toBe(12);
    expect(GENRE_SLUGS.has("litrpg")).toBe(true);
    expect(ACTIVE_TAG_SLUGS.has("dungeon-core")).toBe(true);
    expect(TAGS.length).toBeGreaterThan(100);
  });

  it("finds tags by slug, name or synonym", () => {
    expect(findTag("Xianxia")?.slug).toBe("cultivation");
    expect(findTag("LitRPG")?.slug).toBe("litrpg");
    expect(findTag("dungeon core")?.slug).toBe("dungeon-core");
    expect(findTag("Portal Fantasy")?.slug).toBe("isekai");
    expect(findTag("nonsense")).toBeUndefined();
    expect(canonicalTagSlug("isekai")).toBe("isekai");
    expect(canonicalTagSlug("no-such-tag")).toBeNull();
  });

  it("buckets dials into the facet levels (TAXONOMY §6, §7a)", () => {
    expect([0, 1, 2, 4, 5, 7, 8, 10].map(crunchLevelFromDial)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect([0, 1, 2, 3, 5, 6, 8, 9, 10].map(romanceLevelFromDial)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("syncs into the tags table idempotently", async () => {
    const first = await syncTaxonomy(db);
    expect(first.inserted).toBe(TAGS.length);
    const second = await syncTaxonomy(db);
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: TAGS.length });
    const rows = await db.select().from(tags);
    const cult = rows.find((r) => r.slug === "cultivation");
    expect(cult?.synonyms).toContain("xianxia");
    expect(cult?.facet).toBe("genre");
  });
});
