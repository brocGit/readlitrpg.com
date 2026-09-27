import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { addConfirmation, ingestBook } from "../src/catalog";
import { createDb, type Db } from "../src/db";
import { books, editorialQueue, media } from "../src/db/schema";
import {
  acceptImage,
  checkImage,
  dimensions,
  FETCHED_COVER_RULES,
  fetchOpenLibraryCovers,
  MediaError,
  processPendingMedia,
  rejectMedia,
  sniff,
  UPLOAD_COVER_RULES,
  variantKey,
} from "../src/media";
import { syncTaxonomy } from "../src/taxonomy";
import { createTestD1, TestR2 } from "../src/testing";

/** A minimal PNG header: enough for sniffing and dimensions. */
function png(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  for (let i = 33; i < b.length; i++) b[i] = i % 251;
  return b;
}

/** A minimal JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return b;
}

describe("image checks", () => {
  it("knows images by their bytes and reads their size", () => {
    expect(sniff(png(10, 20))).toBe("image/png");
    expect(sniff(jpeg(10, 20))).toBe("image/jpeg");
    expect(sniff(new TextEncoder().encode("<svg xmlns=...>"))).toBeNull();
    expect(dimensions(png(640, 960), "image/png")).toEqual({ width: 640, height: 960 });
    expect(dimensions(jpeg(333, 500), "image/jpeg")).toEqual({ width: 333, height: 500 });
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
    webp.set([0x7f, 0x02, 0x00, 0xbf, 0x03, 0x00], 24); // 640 × 960, stored minus one
    expect(sniff(webp)).toBe("image/webp");
    expect(dimensions(webp, "image/webp")).toEqual({ width: 640, height: 960 });
  });

  it("refuses the wrong type, size or shape", () => {
    expect(checkImage(png(640, 960), UPLOAD_COVER_RULES)).toMatchObject({ mime: "image/png", width: 640 });
    expect(() => checkImage(new TextEncoder().encode("GIF89a......"), UPLOAD_COVER_RULES)).toThrow(
      /JPEG, PNG and WebP/,
    );
    expect(() => checkImage(png(300, 450), UPLOAD_COVER_RULES)).toThrow(/at least 600×900/);
    expect(() => checkImage(png(900, 900), UPLOAD_COVER_RULES)).toThrow(/cover's shape/);
    expect(() => checkImage(png(7000, 9000), UPLOAD_COVER_RULES)).toThrow(/at most 6000/);
    expect(checkImage(jpeg(300, 450), FETCHED_COVER_RULES).width).toBe(300);
    expect(() => checkImage(jpeg(1, 1), FETCHED_COVER_RULES)).toThrow(MediaError);
  });
});

describe("the media pipeline", () => {
  let db: Db;
  let priv: TestR2;
  let pub: TestR2;
  const buckets = () => ({ private: priv.asR2(), media: pub.asR2() });
  const transform = async (bytes: Uint8Array, width: number) =>
    new TextEncoder().encode(`webp:${width}:${bytes.length}`);

  beforeEach(async () => {
    db = createDb(createTestD1().asD1());
    await syncTaxonomy(db);
    priv = new TestR2();
    pub = new TestR2();
  });

  async function aBook(title = "Covered", isbn = "9780593820247") {
    const { bookId } = await ingestBook(
      db,
      { title, authors: [{ name: "Ann" }], editions: [{ format: "ebook", isbn }] },
      { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    return bookId;
  }

  it("keeps the original private, publishes variants, attaches the cover and queues a review", async () => {
    const bookId = await aBook();
    const { id } = await acceptImage(
      db,
      buckets(),
      png(640, 960),
      { purpose: "cover", source: "upload", subjectType: "book", subjectId: bookId, uploadedBy: "owner" },
      UPLOAD_COVER_RULES,
    );
    expect([...priv.objects.keys()]).toEqual([`uploads/${id}`]);
    // The same file again is recognized, not stored twice.
    expect(
      (
        await acceptImage(
          db,
          buckets(),
          png(640, 960),
          { purpose: "cover", source: "upload", subjectType: "book", subjectId: bookId },
          UPLOAD_COVER_RULES,
        )
      ).duplicate,
    ).toBe(true);

    expect(await processPendingMedia(db, buckets(), { transform, mediaOrigin: "https://media.test" })).toBe(
      1,
    );
    const [row] = await db.select().from(media).where(eq(media.id, id));
    expect(row).toMatchObject({ bucket: "media", status: "approved", width: 640, height: 960 });
    expect([...pub.objects.keys()].sort()).toEqual(
      [160, 320, 640].map((w) => variantKey(row?.key ?? "", w)).sort(),
    );
    expect(pub.objects.get(variantKey(row?.key ?? "", 320))?.contentType).toBe("image/webp");
    const [book] = await db.select({ cover: books.coverMediaId }).from(books).where(eq(books.id, bookId));
    expect(book?.cover).toBe(id);
    const [review] = await db.select().from(editorialQueue).where(eq(editorialQueue.kind, "image_review"));
    expect(review?.payload).toMatchObject({
      url: `https://media.test/${variantKey(row?.key ?? "", 640)}`,
      purpose: "cover",
    });

    // An Open Library cover never replaces an uploaded one; a block takes the cover down.
    const ol = await acceptImage(
      db,
      buckets(),
      jpeg(400, 600),
      { purpose: "cover", source: "openlibrary", subjectType: "book", subjectId: bookId },
      FETCHED_COVER_RULES,
    );
    await processPendingMedia(db, buckets(), { transform, mediaOrigin: "https://media.test" });
    expect(
      (await db.select({ cover: books.coverMediaId }).from(books).where(eq(books.id, bookId)))[0]?.cover,
    ).toBe(id);
    await rejectMedia(db, id);
    expect(
      (await db.select({ cover: books.coverMediaId }).from(books).where(eq(books.id, bookId)))[0]?.cover,
    ).toBeNull();
    expect(ol.duplicate).toBe(false);
  });

  it("marks an image it can't process as rejected, with the reason", async () => {
    const bookId = await aBook();
    const { id } = await acceptImage(
      db,
      buckets(),
      png(640, 960),
      { purpose: "cover", source: "upload", subjectType: "book", subjectId: bookId },
      UPLOAD_COVER_RULES,
    );
    await processPendingMedia(db, buckets(), {
      transform: async () => {
        throw new Error("transform failed");
      },
      mediaOrigin: "https://media.test",
    });
    const [row] = await db.select().from(media).where(eq(media.id, id));
    expect(row).toMatchObject({ status: "rejected", error: "transform failed" });
  });

  it("fetches covers from Open Library by cover id, then ISBN, following its redirect", async () => {
    const bookId = await aBook("Open Covers");
    await addConfirmation(db, {
      subjectType: "book",
      subjectId: bookId,
      source: "openlibrary",
      sourceRef: "/works/OL1W",
      evidence: { coverId: 12345 },
    });
    const other = await aBook("No Cover Anywhere", "9781039400009");
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      if (url === "https://covers.openlibrary.org/b/id/12345-L.jpg")
        return new Response(null, {
          status: 302,
          headers: { location: "https://ia800.us.archive.org/view/12345.jpg" },
        });
      if (url.includes("archive.org")) return new Response(jpeg(400, 600), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const r = await fetchOpenLibraryCovers(db, buckets(), {
      fetch: fetcher,
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(r).toEqual({ checked: 2, found: 1 });
    const rows = await db.select().from(media);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "openlibrary", subjectId: bookId, status: "pending" });
    // Checked books wait a month before the next try.
    expect(
      (await fetchOpenLibraryCovers(db, buckets(), { fetch: fetcher, now: new Date("2026-10-02T00:00:00Z") }))
        .checked,
    ).toBe(0);
    expect(seen).toContain("https://covers.openlibrary.org/b/isbn/9781039400009-L.jpg?default=false");
    expect(other).not.toBe(bookId);
  });
});
