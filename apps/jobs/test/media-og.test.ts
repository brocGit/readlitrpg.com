import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { addConfirmation, ingestBook, setVisibility, writeBookFields } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import {
  acceptImage,
  classOgKey,
  dimensions,
  quizOgKey,
  siteOgKey,
  UPLOAD_COVER_RULES,
  variantKey,
} from "@rlr/core/media";
import { READER_CLASSES, setQuizStatus } from "@rlr/core/quiz";
import { books, media } from "@rlr/core/schema";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV, TestR2 } from "@rlr/core/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processMedia } from "../src/jobs/media";
import { renderShareImages } from "../src/jobs/og";
import type { JobContext } from "../src/jobs/types";
import { createRasterizer, type Rasterizer } from "../src/og/rasterizer";

const require = createRequire(import.meta.url);
const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

// The real renderer, loaded the Node way: the same WebAssembly and fonts the Worker bundles.
let rasterize: Rasterizer;
beforeAll(() => {
  const wasm = readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"));
  const fontDir = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
  const fonts = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf"].map(
    (f) => new Uint8Array(readFileSync(join(fontDir, f))),
  );
  rasterize = createRasterizer(wasm, fonts);
});

/** A fake Images binding: "re-encodes" by tagging the bytes, so tests can see it ran. */
const images = {
  input(stream: ReadableStream<Uint8Array>) {
    const steps: string[] = [];
    const t = {
      transform(o: { width?: number }) {
        steps.push(`w${o.width}`);
        return t;
      },
      async output(o: { format: string }) {
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        return {
          response: () =>
            new Response(new Blob([bytes, new TextEncoder().encode(`|${steps.join(",")}|${o.format}`)])),
        };
      },
    };
    return t;
  },
};

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

let db: Db;
let ctx: JobContext & { env: Env & { MEDIA: TestR2; PRIVATE: TestR2; CONFIG: TestKV } };

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1.asD1());
  await syncTaxonomy(db);
  ctx = {
    db,
    log,
    now: new Date(),
    env: {
      DB: d1.asD1(),
      CONFIG: new TestKV(),
      MEDIA: new TestR2(),
      PRIVATE: new TestR2(),
      IMAGES: images,
      PUBLIC_MEDIA_ORIGIN: "https://media.test",
    } as unknown as JobContext["env"] & { MEDIA: TestR2; PRIVATE: TestR2; CONFIG: TestKV },
  };
  ctx.rasterize = rasterize;
});

async function publishedBook(title: string) {
  const { bookId } = await ingestBook(
    db,
    {
      title,
      authors: [{ name: "Ann Writer" }],
      series: { name: "The Tower", position: 2 },
      primaryGenre: "litrpg",
    },
    { source: "admin", origin: "admin", fuzzyMin: 0.6, crowdMinVotes: 8 },
  );
  await addConfirmation(db, { subjectType: "book", subjectId: bookId, source: "owner_check" });
  await setVisibility(db, bookId, "published");
  return bookId;
}

const isCard = (bytes: Uint8Array | undefined) => (bytes ? dimensions(bytes, "image/png") : null);

describe("media.process", () => {
  it("re-encodes a pending upload through the Images binding into every variant", async () => {
    const bookId = await publishedBook("Covered");
    const { id } = await acceptImage(
      db,
      { private: ctx.env.PRIVATE as unknown as R2Bucket },
      png(640, 960),
      { purpose: "cover", source: "upload", subjectType: "book", subjectId: bookId },
      UPLOAD_COVER_RULES,
    );
    expect(await processMedia(ctx)).toBe(1);
    const [row] = await db.select().from(media).where(eq(media.id, id));
    const variant = ctx.env.MEDIA.objects.get(variantKey(row?.key ?? "", 320));
    expect(new TextDecoder().decode(variant?.bytes).endsWith("|w320|image/webp")).toBe(true);
  });
});

describe("og.render", () => {
  it("draws the site card, reader classes, live quiz results and books as 1200×630 PNGs, once", async () => {
    const bookId = await publishedBook("The Crunchy Tower");
    await setQuizStatus(db, "whats-your-litrpg-class", "live", "owner");
    const drawn = await renderShareImages(ctx);
    expect(drawn).toBe(1 + READER_CLASSES.length + 12 + 1);
    expect(isCard(ctx.env.MEDIA.objects.get(siteOgKey())?.bytes)).toEqual({ width: 1200, height: 630 });
    expect(isCard(ctx.env.MEDIA.objects.get(classOgKey(READER_CLASSES[0]?.key ?? ""))?.bytes)).toEqual({
      width: 1200,
      height: 630,
    });
    expect(
      ctx.env.MEDIA.objects.has(quizOgKey("whats-your-litrpg-class", READER_CLASSES[0]?.key ?? "")),
    ).toBe(true);
    const [b] = await db.select({ key: books.ogImageKey }).from(books).where(eq(books.id, bookId));
    expect(b?.key).toMatch(/^og\/book\/.+\.png$/);
    expect(isCard(ctx.env.MEDIA.objects.get(b?.key ?? "")?.bytes)).toEqual({ width: 1200, height: 630 });

    // Nothing changed: nothing is drawn again.
    expect(await renderShareImages(ctx)).toBe(0);

    // A new title is a new card, under a new key.
    await writeBookFields(db, bookId, [{ field: "title", value: "The Crunchier Tower" }], {
      source: "admin",
    });
    ctx.now = new Date(Date.now() + 1000);
    expect(await renderShareImages(ctx)).toBe(1);
    const [after] = await db.select({ key: books.ogImageKey }).from(books).where(eq(books.id, bookId));
    expect(after?.key).not.toBe(b?.key);
  });
});
