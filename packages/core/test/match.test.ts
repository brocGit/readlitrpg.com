import { describe, expect, it } from "vitest";
import {
  assembleMatrix,
  buildProfile,
  DEFAULT_MATCH_OPTIONS,
  decodeInputs,
  decodeMatrix,
  dial,
  encodeInputs,
  encodeMatrix,
  explain,
  findBooks,
  findParams,
  harem,
  hasFlag,
  headsUps,
  indexOfBook,
  match,
  parseFindParams,
  readerClass,
  recallAtK,
  reduceEmbedding,
  renderExplanation,
  renderHeadsUp,
  similarTo,
  stat,
  tagsOf,
} from "../src/match";
import { book, catalog } from "./helpers/matrix";

const m = catalog();
const idx = indexOfBook(m);
const at = (slug: string) => idx.get(slug) as number;
const slugs = (list: { i: number }[]) => list.map((s) => m.slugs[s.i]);
const all = (r: ReturnType<typeof match>) => [...r.bestBets, ...r.more];

describe("the feature matrix", () => {
  it("round-trips through its binary encoding", () => {
    const back = decodeMatrix(encodeMatrix(m));
    expect(back.n).toBe(m.n);
    expect(back.slugs).toEqual(m.slugs);
    expect(dial(back, at("delve-1"), back.dials.indexOf("crunch"))).toEqual({ value: 9, conf: 0.85 });
    expect(stat(back, at("delve-1"), back.stats.indexOf("build_payoff"))).toMatchObject({
      value: 9,
      public: true,
    });
    // Hidden judgment stats count at half confidence.
    expect(stat(back, at("delve-1"), back.stats.indexOf("competent_mc")).conf).toBeCloseTo(0.43, 1);
    expect(harem(back, at("harem-crunch"))).toBe("harem");
    expect(hasFlag(back, at("grim-1"), "gore")).toBe(true);
    expect(tagsOf(back, at("cozy-1")).get(back.tags.indexOf("cozy"))).toBeCloseTo(0.9);
  });

  it("reduces embeddings to unit vectors that keep neighbors close", () => {
    const base = Array.from({ length: 768 }, (_, k) => Math.sin(k));
    const near = base.map((x, k) => x + (k % 7 === 0 ? 0.05 : 0));
    const far = Array.from({ length: 768 }, (_, k) => Math.cos(k * 3));
    const a = reduceEmbedding(base);
    const cos = (x: Int8Array, y: Int8Array) => {
      let d = 0;
      let nx = 0;
      let ny = 0;
      x.forEach((v, k) => {
        d += v * (y[k] ?? 0);
        nx += v * v;
        ny += (y[k] ?? 0) ** 2;
      });
      return d / Math.sqrt(nx * ny);
    };
    expect(cos(a, reduceEmbedding(near))).toBeGreaterThan(0.95);
    expect(Math.abs(cos(a, reduceEmbedding(far)))).toBeLessThan(0.5);
  });
});

describe("taste profiles", () => {
  it("learns dial targets and what the loved books agree on", () => {
    const p = buildProfile(m, { loved: ["delve-1", "crawler-1"] });
    expect(p.dials.crunch?.target).toBe(9);
    // Both loved books are crunchy: crunch matters. Humor differs a lot: it barely matters.
    expect(p.dials.crunch?.importance).toBeGreaterThan((p.dials.humor?.importance ?? 0) * 2);
    expect(p.stats.build_payoff?.floor).toBeCloseTo(7.5, 0);
    expect(p.tags["dungeon-crawler"]).toBeGreaterThan(0);
    expect(p.loved).toHaveLength(2);
  });

  it("turns Match Quiz answers into targets, floors and filters", () => {
    const p = buildProfile(m, {
      noes: ["harem", "explicit", "grimdark"],
      crunch: 3,
      musts: ["competent_mc"],
      subgenres: ["dungeon-core"],
      mc: ["planner"],
      tone: 8,
    });
    expect(p.exclude).toMatchObject({ harem: true, flags: ["explicit-sex"], tags: ["grimdark"] });
    expect(p.dials.crunch).toEqual({ target: 9, importance: 0.9 });
    expect(p.dials.strategy?.target).toBe(8);
    expect(p.stats.competent_mc).toEqual({ floor: 7, importance: 1 });
    expect(p.tags["dungeon-core"]).toBe(3);
  });

  it("uses dislike reasons as targeted signal, and sliders override everything", () => {
    const p = buildProfile(m, {
      bounced: [{ book: "cozy-1", reasons: ["too_slow", "harem_romance"] }],
      pacing: 3,
      tune: { pacing: 9 },
    });
    expect(p.dials.pacing?.target).toBeGreaterThan(8.5);
    expect(p.exclude.harem).toBe(true);
    expect(p.bounced).toEqual([at("cozy-1")]);
  });

  it("round-trips inputs through a share link and refuses junk", () => {
    const inputs = { loved: ["delve-1"], noes: ["harem" as const], crunch: 2 };
    expect(decodeInputs(encodeInputs(inputs))).toEqual(inputs);
    expect(decodeInputs("not base64!")).toBeNull();
    expect(decodeInputs(encodeInputs({ loved: ["x"] }).slice(0, 3))).toBeNull();
    expect(decodeInputs(btoa(JSON.stringify({ evil: true })))).toBeNull();
  });
});

describe("matching", () => {
  it("ranks similar books first, one per series, starting where the series starts", () => {
    const r = match(m, buildProfile(m, { loved: ["crawler-1"] }));
    const ranked = slugs(all(r));
    expect(ranked[0]).toBe("delve-1");
    expect(ranked).not.toContain("delve-2");
    expect(ranked).not.toContain("crawler-1");
    expect(r.bestBets[0]?.isMatch).toBe(true);
    expect(r.bestBets[0]?.percent).toBeGreaterThanOrEqual(60);
  });

  it("points at book 1 even when a later volume scores higher", () => {
    const p = buildProfile(m, { loved: ["crawler-1"] });
    const r = match(m, { ...p, read: [] });
    expect(slugs(all(r)).filter((s) => s?.startsWith("delve"))).toEqual(["delve-1"]);
  });

  it("applies hard filters conservatively", () => {
    const p = buildProfile(m, { loved: ["delve-1"], noes: ["harem", "gore", "ai_generated"] });
    const r = match(m, p);
    const ranked = slugs(all(r));
    expect(ranked).not.toContain("harem-crunch");
    // A harem the classifier couldn't rule out is excluded too.
    expect(ranked).not.toContain("unknown-harem");
    expect(ranked).not.toContain("grim-1");
    expect(r.filtered).toMatchObject({ harem: 2 });
    const audio = match(m, buildProfile(m, { loved: ["delve-1"], formats: ["audiobook"] }));
    expect(slugs(all(audio)).every((s) => s === "crawler-1" || s === "cozy-1")).toBe(true);
    const finished = match(m, buildProfile(m, { loved: ["crawler-1"], noes: ["unfinished"] }));
    expect(slugs(all(finished))).not.toContain("delve-1");
  });

  it("keeps an author to two books", () => {
    const r = match(m, buildProfile(m, { loved: ["crawler-1"] }));
    const byAuthor = all(r).filter((s) => ["delve-1", "delve-2", "min-max"].includes(m.slugs[s.i] ?? ""));
    expect(byAuthor.length).toBeLessThanOrEqual(2);
  });

  it("pushes down books like the ones the reader bounced off", () => {
    const base = match(m, buildProfile(m, { subgenres: ["crafting"] }));
    const bounced = match(m, buildProfile(m, { subgenres: ["crafting"], bounced: [{ book: "cozy-1" }] }));
    const rank = (r: ReturnType<typeof match>, s: string) => slugs(all(r)).indexOf(s);
    expect(rank(bounced, "cozy-2")).toBe(-1); // the series of a bounced book isn't suggested again
    expect(rank(bounced, "shop")).toBeGreaterThanOrEqual(rank(base, "shop"));
  });

  it("picks a wildcard from a premise the reader hasn't tried that meets their floors", () => {
    const r = match(m, buildProfile(m, { loved: ["crawler-1", "delve-1"] }));
    if (r.wildcard) {
      const premise = [...tagsOf(m, r.wildcard.i).keys()].map((t) => m.tags[t]);
      expect(premise).not.toContain("dungeon-crawler");
    }
  });
});

describe("heads-ups and explanations", () => {
  it("warns about a must-have below the floor, a far dial and a slow start, unless relaxed", () => {
    const p = buildProfile(m, { loved: ["delve-1"], musts: ["competent_mc"], pacing: 5 });
    const hs = headsUps(m, at("min-max"), p, DEFAULT_MATCH_OPTIONS);
    const keys = hs.map((h) => h.key);
    expect(keys).toContain("stat:competent_mc");
    expect(hs.map(renderHeadsUp)).toContain("Readers rate the MC's decisions lower than you usually like");
    const relaxed = buildProfile(m, {
      loved: ["delve-1"],
      musts: ["competent_mc"],
      relax: ["stat:competent_mc"],
    });
    expect(headsUps(m, at("min-max"), relaxed, DEFAULT_MATCH_OPTIONS).map((h) => h.key)).not.toContain(
      "stat:competent_mc",
    );
  });

  it("flags a disliked tag the book might have without hiding it", () => {
    const p = buildProfile(m, { loved: ["cozy-1"], noes: ["grimdark"] });
    const r = match(m, p);
    expect(slugs(all(r))).toContain("shop"); // grimdark 0.25 is under the exclusion threshold
    expect(headsUps(m, at("shop"), p, DEFAULT_MATCH_OPTIONS).map(renderHeadsUp)).toContain(
      "Possible grimdark; readers are split",
    );
  });

  it("explains a match from the data, naming the loved book", () => {
    const p = buildProfile(m, { loved: ["crawler-1"], noes: ["harem"] });
    const e = explain(m, at("delve-1"), p);
    const text = renderExplanation(e, (i) => (i === at("crawler-1") ? "Crawler" : undefined));
    expect(text.why).toMatch(/^Same .+ as Crawler\.$/);
    expect(text.notes).toContain("No harem.");
    expect(text.differs).toMatch(/Where it differs: .*more serious/);
  });
});

describe("reader classes", () => {
  it("maps profiles to the nearest archetype", () => {
    expect(readerClass(buildProfile(m, { loved: ["delve-1", "min-max"] })).cls.key).toBe("min-maxer");
    expect(
      readerClass(buildProfile(m, { subgenres: ["crafting"], tone: 9, humor: 6, pacing: 2 })).cls.key,
    ).toBe("cozy-crafter");
  });
});

describe("find, similar books and the offline eval", () => {
  it("filters by tags, dial ranges and hard no's, and sorts by a dial", () => {
    const q = parseFindParams(new URLSearchParams("inc=litrpg&d.crunch=7-10&no=harem&sort=dial:pacing:desc"));
    expect(findParams(q).toString()).toBe("inc=litrpg&d.crunch=7-10&no=harem&sort=dial%3Apacing%3Adesc");
    const { hits } = findBooks(m, q);
    expect(hits.map((h) => m.slugs[h.i])[0]).toBe("min-max");
    expect(hits.map((h) => m.slugs[h.i])).not.toContain("harem-crunch");
    expect(hits.map((h) => m.slugs[h.i])).not.toContain("sparse");
  });

  it("sorts by a stat using only values readers can see", () => {
    const { hits } = findBooks(m, parseFindParams(new URLSearchParams("sort=stat:build_payoff")));
    expect(m.slugs[hits[0]?.i ?? -1]).toBe("delve-1");
    expect(hits[1]?.value).toBeNull();
  });

  it("finds books like X without other volumes of X", () => {
    const like = similarTo(m, at("delve-1"), 5);
    expect(like.map((s) => m.slugs[s.i])).not.toContain("delve-2");
    expect(m.slugs[like[0]?.i ?? -1]).toMatch(/crawler-1|min-max|harem-crunch|unknown-harem/);
    expect(like[0]?.dials.length).toBeGreaterThan(0);
  });

  it("measures recall@10 on held-out loved books", () => {
    const report = recallAtK(m, [["delve-1", "crawler-1", "min-max", "harem-crunch"], ["cozy-1"]], 10);
    expect(report.readers).toBe(1);
    expect(report.trials).toBe(4);
    expect(report.recall).toBeGreaterThan(0.5);
  });

  it("copes with an empty catalog", () => {
    const empty = assembleMatrix([book({ id: "only" })].slice(0, 0), "empty");
    expect(match(empty, buildProfile(empty, { loved: ["x"] })).bestBets).toEqual([]);
  });
});
