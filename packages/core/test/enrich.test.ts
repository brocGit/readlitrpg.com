import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { booksToEnrich, enrichBook, ingestBook, pickMatch, publicationGate } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { books, catalogConfirmations } from "../src/db/schema";
import { checkUrl, SafeFetchError, safeFetch } from "../src/net/safe-fetch";
import { createTestD1 } from "../src/testing";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const seed = { source: "ai" as const, origin: "ai_seed" as const, fuzzyMin: 0.6, crowdMinVotes: 8 };

let db: Db;
beforeEach(() => {
  db = createDb(createTestD1().asD1());
});

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, respond] of Object.entries(routes)) if (url.startsWith(prefix)) return respond();
    return new Response("not found", { status: 404 });
  };
  return Object.assign(fn as typeof fetch, { calls });
}

describe("safeFetch", () => {
  it("allows only named https hosts", () => {
    expect(checkUrl("https://openlibrary.org/search.json", ["openlibrary.org"]).hostname).toBe(
      "openlibrary.org",
    );
    for (const bad of [
      "http://openlibrary.org/",
      "https://evil.test/",
      "https://127.0.0.1/",
      "https://localhost/",
      "https://openlibrary.org:8443/",
      "https://www.amazon.com/dp/B000",
      "https://user:pw@openlibrary.org/",
    ]) {
      expect(() => checkUrl(bad, ["openlibrary.org", "amazon.com"]), bad).toThrow(SafeFetchError);
    }
  });

  it("re-checks every redirect", async () => {
    const f = fakeFetch({
      "https://openlibrary.org/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
      "https://openlibrary.org/b": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
    });
    await expect(
      safeFetch("https://openlibrary.org/a", { allowHosts: ["openlibrary.org"], fetch: f }),
    ).rejects.toThrow(/not allowed/);
    expect(f.calls).toEqual(["https://openlibrary.org/a", "https://openlibrary.org/b"]);
  });

  it("caps the body size", async () => {
    const f = fakeFetch({ "https://openlibrary.org/": () => new Response("x".repeat(2000)) });
    await expect(
      safeFetch("https://openlibrary.org/", { allowHosts: ["openlibrary.org"], fetch: f, maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("matching API results", () => {
  const candidate = (title: string, authors: string[], isbns: string[] = []) => ({
    source: "openlibrary" as const,
    ref: "x",
    title,
    authors,
    pageCount: null,
    published: null,
    isbns,
  });
  it("needs a shared author and the same title or ISBN", () => {
    const book = { title: "Unsouled (Cradle Book 1)", authorNames: ["Will Wight"], isbns: [] };
    expect(pickMatch(book, [candidate("Unsouled", ["Somebody"])])).toBeNull();
    expect(pickMatch(book, [candidate("Unsouled (Cradle, #1)", ["Will Wight"])])?.title).toBe(
      "Unsouled (Cradle, #1)",
    );
    expect(pickMatch(book, [candidate("Soulsmith", ["Will Wight"])])).toBeNull();
    expect(
      pickMatch({ ...book, isbns: ["9780989671767"] }, [
        candidate("Different", ["Will Wight"], ["9780989671767"]),
      ]),
    ).not.toBeNull();
    expect(
      pickMatch({ title: "Delve", authorNames: ["SenescentSoul"], isbns: [] }, [
        candidate("Delve 2", ["SenescentSoul"]),
      ]),
    ).toBeNull();
  });
});

describe("enrichBook", () => {
  it("confirms a seed from Open Library and adds API facts", async () => {
    const { bookId } = await ingestBook(
      db,
      { title: "The Primal Hunter", authors: [{ name: "Zogarth" }] },
      seed,
    );
    const f = fakeFetch({
      "https://openlibrary.org/search.json": () => new Response(fixture("openlibrary-primal-hunter.json")),
    });
    expect(await enrichBook(db, bookId, { fetch: f })).toEqual({
      status: "matched",
      sources: ["openlibrary"],
    });
    const [b] = await db.select().from(books).where(eq(books.id, bookId));
    expect(b).toMatchObject({
      enrichStatus: "matched",
      pageCount: 704,
      firstPublished: "2022-01-01",
      firstPublishedPrecision: "year",
    });
    expect(publicationGate(b as NonNullable<typeof b>)).toEqual({ ok: true });
    const [c] = await db.select().from(catalogConfirmations);
    expect(c).toMatchObject({ source: "openlibrary", sourceRef: "/works/OL27998383W" });
    expect(new URL(f.calls[0] ?? "").searchParams.get("author")).toBe("Zogarth");
  });

  it("uses Google Books too when a key is configured", async () => {
    const { bookId } = await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    const f = fakeFetch({
      "https://openlibrary.org/": () => Response.json({ docs: [] }),
      "https://www.googleapis.com/books/v1/volumes": () => new Response(fixture("googlebooks-unsouled.json")),
    });
    expect(await enrichBook(db, bookId, { fetch: f, googleBooksKey: "k" })).toEqual({
      status: "matched",
      sources: ["google_books"],
    });
    const [b] = await db.select().from(books).where(eq(books.id, bookId));
    expect(b).toMatchObject({ pageCount: 286, firstPublished: "2016-04-01", firstPublishedPrecision: "day" });
  });

  it("records misses and errors so they're retried later", async () => {
    const miss = await ingestBook(db, { title: "Not A Real Book", authors: [{ name: "Nobody" }] }, seed);
    const down = await ingestBook(db, { title: "Another", authors: [{ name: "Someone" }] }, seed);
    expect(
      await enrichBook(db, miss.bookId, {
        fetch: fakeFetch({ "https://openlibrary.org/": () => Response.json({ docs: [] }) }),
      }),
    ).toEqual({
      status: "no_match",
    });
    expect(
      await enrichBook(db, down.bookId, {
        fetch: fakeFetch({ "https://openlibrary.org/": () => new Response("", { status: 503 }) }),
      }),
    ).toEqual({
      status: "error",
    });
    // Neither is due again until the retry window passes.
    expect(await booksToEnrich(db, 10, 30)).toEqual([]);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect((await booksToEnrich(db, 10, 30, later)).sort()).toEqual([miss.bookId, down.bookId].sort());
  });
});
