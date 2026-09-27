import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type BookInput,
  booksToEmbed,
  cosine,
  decodeVector,
  EMBED_DIMS,
  type Embedder,
  embedBooks,
  embeddingDuplicates,
  embeddingText,
  encodeVector,
  type IngestContext,
  ingestBook,
  isScorePublic,
  keywordTags,
  resolveScore,
  suggestTags,
  suggestTagsForBook,
  workersAiEmbedder,
  writeAiScores,
} from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { bookEmbeddings, bookScores, books, inboxItems } from "../src/db/schema";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(async () => {
  db = createDb(createTestD1().asD1());
  await syncTaxonomy(db);
});

const seed: IngestContext = { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 };
const ingest = async (input: BookInput) => (await ingestBook(db, input, seed)).bookId;

describe("dial and stat scores", () => {
  it("starts from the AI, lets authors nudge, and lets readers take over", () => {
    expect(
      resolveScore({ aiValue: 6, aiConfidence: 0.65, authorValue: null, crowdMean: null, crowdN: 0 }),
    ).toEqual({
      value: 6,
      confidence: 0.65,
    });
    expect(
      resolveScore({ aiValue: 6, aiConfidence: 0.65, authorValue: 10, crowdMean: null, crowdN: 0 }).value,
    ).toBe(6.8);
    const crowd = resolveScore({
      aiValue: 6,
      aiConfidence: 0.65,
      authorValue: null,
      crowdMean: 2,
      crowdN: 10,
    });
    expect(crowd.value).toBeCloseTo(3.3);
    expect(crowd.confidence).toBeGreaterThan(0.85);
    expect(
      resolveScore({ aiValue: null, aiConfidence: null, authorValue: null, crowdMean: null, crowdN: 0 })
        .value,
    ).toBeNull();
  });

  it("shows judgment stats only after enough appraisals", () => {
    const estimate = { value: 8, confidence: 0.65 };
    expect(isScorePublic("dial", "pacing", estimate, 0, 5)).toBe(true);
    expect(isScorePublic("stat", "number_go_up", estimate, 0, 5)).toBe(true);
    expect(isScorePublic("stat", "number_go_up", { value: 8, confidence: 0.45 }, 0, 5)).toBe(false);
    expect(isScorePublic("stat", "competent_mc", estimate, 4, 5)).toBe(false);
    expect(isScorePublic("stat", "competent_mc", estimate, 5, 5)).toBe(true);
  });

  it("keeps an admin-locked value when the AI changes its mind", async () => {
    const id = await ingest({ title: "Locked", authors: [{ name: "A" }] });
    await db
      .insert(bookScores)
      .values({ bookId: id, key: "pacing", kind: "dial", value: 3, adminLocked: true });
    await writeAiScores(db, id, [{ key: "pacing", value: 9, confidence: 0.85 }], 5);
    const [row] = await db.select().from(bookScores).where(eq(bookScores.bookId, id));
    expect(row).toMatchObject({ value: 3, aiValue: 9, adminLocked: true });
  });
});

describe("deterministic tag suggestions (§10.3)", () => {
  it("matches names and synonyms as whole phrases", () => {
    const found = keywordTags("A xianxia tale: he climbs the Tower, builds a dungeon core and levels up.");
    expect(found.get("cultivation")).toBe("xianxia");
    expect(found.has("dungeon-core")).toBe(true);
    expect(keywordTags("Towering heroes").has("tower-climbing")).toBe(false);
  });

  it("suggests the series' tags first, then the author's, then keywords", async () => {
    const series = { name: "The Hunt", status: "ongoing" as const };
    await ingest({
      title: "Hunt One",
      authors: [{ name: "Ann Writer" }],
      series: { ...series, position: 1 },
      tags: [{ slug: "system-apocalypse" }, { slug: "male-mc" }],
      confidence: 0.85,
    });
    await ingest({
      title: "Hunt Two",
      authors: [{ name: "Ann Writer" }],
      series: { ...series, position: 2 },
      tags: [{ slug: "system-apocalypse" }],
      confidence: 0.85,
    });
    await ingest({
      title: "Other Thing",
      authors: [{ name: "Ann Writer" }],
      tags: [{ slug: "crafting" }],
      confidence: 0.85,
    });
    const three = await ingest({
      title: "Hunt Three",
      authors: [{ name: "Ann Writer" }],
      series: { ...series, position: 3 },
    });
    const [book] = await db.select().from(books).where(eq(books.id, three));
    const out = await suggestTags(db, {
      bookId: three,
      seriesId: book?.seriesId,
      authorIds: [],
      text: "Now with more cultivation.",
    });
    expect(out[0]).toMatchObject({ slug: "system-apocalypse", score: 0.9 });
    expect(out.find((s) => s.slug === "male-mc")?.score).toBeCloseTo(0.45);
    expect(out.find((s) => s.slug === "cultivation")?.reasons[0]).toMatch(/mentions/);
    const forBook = await suggestTagsForBook(db, three, 0.6);
    expect(forBook.map((s) => s.slug)).toContain("crafting");
  });
});

describe("embeddings", () => {
  const fakeEmbedder =
    (vectors: Record<string, number[]>): Embedder =>
    async (texts) =>
      texts.map((t) => {
        const key = Object.keys(vectors).find((k) => t.includes(k));
        const base = key ? (vectors[key] ?? []) : [1];
        return Array.from({ length: EMBED_DIMS }, (_, i) => base[i % base.length] ?? 0);
      });

  it("round-trips vectors and measures similarity", () => {
    const v = [0.25, -1, 3.5];
    expect([...decodeVector(encodeVector(v))]).toEqual(v);
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("embeds our own words, never a blurb", () => {
    const text = embeddingText({
      title: "Unsouled",
      seriesName: "Cradle",
      seriesPosition: 1,
      authorNames: ["Will Wight"],
      primaryGenre: "progression-fantasy",
      tagNames: ["Cultivation"],
      summary: "A boy without a soul path.",
    });
    expect(text).toBe(
      "Unsouled. Cradle book 1. by Will Wight. Genre: progression fantasy. Tags: Cultivation. A boy without a soul path.",
    );
  });

  it("embeds new and changed books once, and flags near-identical books by one author", async () => {
    const a = await ingest({
      title: "Iron Prince",
      authors: [{ name: "Bryce O'Connor" }],
      series: { name: "Warformed", position: 1 },
    });
    const b = await ingest({ title: "Warformed: Stormweaver", authors: [{ name: "Bryce O'Connor" }] });
    const c = await ingest({
      title: "Iron Prince 2",
      authors: [{ name: "Bryce O'Connor" }],
      series: { name: "Warformed", position: 2 },
    });
    const same = [1, 2, 3];
    const embedder = fakeEmbedder({ "Iron Prince": same, Stormweaver: same });
    const ids = await booksToEmbed(db, 10);
    expect(ids.sort()).toEqual([a, b, c].sort());
    expect((await embedBooks(db, ids, embedder)).sort()).toEqual(ids.sort());
    expect(await db.select().from(bookEmbeddings)).toHaveLength(3);
    // Nothing changed: nothing to embed.
    expect(await booksToEmbed(db, 10)).toEqual([]);

    // All three embed identically. The standalone record pairs with both volumes; volumes 1 and 2
    // claim different places in the series, so they are never compared.
    expect(await embeddingDuplicates(db, [a, b, c], 0.92)).toBe(2);
    const pairs = (await db.select().from(inboxItems)).map((i) => {
      const p = i.payload as { bookId: string; otherId: string; reason: string };
      expect(p.reason).toBe("embedding");
      return [p.bookId, p.otherId].sort().join("+");
    });
    expect(pairs.sort()).toEqual([[a, b].sort().join("+"), [b, c].sort().join("+")].sort());
  });

  it("calls the Workers AI endpoint with the scoped token", async () => {
    let seen: { url: string; auth: string | null; body: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) };
      return Response.json({ result: { data: [Array(EMBED_DIMS).fill(0.1)] }, success: true });
    }) as unknown as typeof fetch;
    const embed = workersAiEmbedder({
      accountId: "0123456789abcdef0123456789abcdef",
      token: "t0k",
      fetch: fetchImpl,
    });
    const out = await embed(["hello"]);
    expect(out[0]).toHaveLength(EMBED_DIMS);
    expect(seen).toMatchObject({
      url: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/baai/bge-base-en-v1.5",
      auth: "Bearer t0k",
      body: JSON.stringify({ text: ["hello"] }),
    });
    expect(() => workersAiEmbedder({ accountId: "../../x", token: "t" })).toThrow(/hex/);
  });
});
