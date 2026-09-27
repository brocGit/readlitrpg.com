// Link-preview images (DESIGN §7.10): the site card, the 12 reader classes, every outcome of every
// live quiz, and one card per published book. Rendered once into MEDIA under keys derived from the
// card's content (@rlr/core/media og.ts), so pages can point at them directly.

import {
  bookOgKey,
  classCardText,
  classOgKey,
  OG_VERSION,
  quizCardText,
  quizOgKey,
  siteCardText,
  siteOgKey,
} from "@rlr/core/media";
import { liveQuizzes, QUIZ_HASH, READER_CLASSES } from "@rlr/core/quiz";
import { authors, bookAuthors, books, media, series } from "@rlr/core/schema";
import { bookNumber } from "@rlr/core/site";
import { getTag } from "@rlr/core/taxonomy";
import { bookCardSvg, cardSvg } from "@rlr/ui/cards";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Rasterizer } from "../og/rasterizer";
import type { JobContext } from "./types";

const BOOKS_PER_RUN = 15;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function put(ctx: JobContext, key: string, png: Uint8Array) {
  await ctx.env.MEDIA.put(key, png, {
    httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
  });
}

/** Cards that only change with a deploy: one KV marker per group and content version. */
async function once(ctx: JobContext, marker: string, draw: () => Promise<number>): Promise<number> {
  const key = `og:done:${marker}`;
  if (await ctx.env.CONFIG.get(key)) return 0;
  const n = await draw();
  await ctx.env.CONFIG.put(key, new Date().toISOString());
  return n;
}

/** A small PNG of the cover for the card: resvg reads PNG and JPEG, and originals may be WebP. */
async function coverThumbnail(ctx: JobContext, originalKey: string): Promise<Uint8Array | null> {
  try {
    const original = await ctx.env.PRIVATE.get(originalKey);
    if (!original) return null;
    const result = await ctx.env.IMAGES.input(original.body)
      .transform({ width: 400, fit: "scale-down" })
      .output({ format: "image/png" });
    return new Uint8Array(await result.response().arrayBuffer());
  } catch (error) {
    ctx.log.warn("og.cover_failed", { originalKey, error });
    return null;
  }
}

async function drawBooks(ctx: JobContext, rasterize: Rasterizer): Promise<number> {
  const { db } = ctx;
  const now = ctx.now.toISOString();
  const due = await db
    .select({
      id: books.id,
      title: books.title,
      hook: books.hookAi,
      genre: books.primaryGenre,
      position: books.seriesPosition,
      seriesName: series.name,
      ogImageKey: books.ogImageKey,
      coverKey: media.key,
      coverOriginal: media.originalKey,
      coverWidth: media.width,
      coverHeight: media.height,
    })
    .from(books)
    .leftJoin(series, eq(series.id, books.seriesId))
    .leftJoin(media, and(eq(media.id, books.coverMediaId), eq(media.status, "approved")))
    .where(
      and(
        eq(books.visibility, "published"),
        isNull(books.redirectTo),
        or(isNull(books.ogRenderedAt), gt(books.updatedAt, books.ogRenderedAt)),
      ),
    )
    .orderBy(asc(books.updatedAt))
    .limit(BOOKS_PER_RUN);
  if (due.length === 0) return 0;
  const names = await db
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(
      inArray(
        bookAuthors.bookId,
        due.map((b) => b.id),
      ),
    )
    .orderBy(asc(bookAuthors.position));
  let drawn = 0;
  for (const b of due) {
    const authorNames = names.filter((n) => n.bookId === b.id).map((n) => n.name);
    const genre = b.genre ? (getTag(b.genre)?.name ?? null) : null;
    const input = {
      id: b.id,
      title: b.title,
      authors: authorNames,
      series: b.seriesName ? { name: b.seriesName, position: b.position } : null,
      hook: b.hook,
      genre,
      coverKey: b.coverKey,
    };
    const key = await bookOgKey(input);
    if (key !== b.ogImageKey) {
      const thumb = b.coverOriginal ? await coverThumbnail(ctx, b.coverOriginal) : null;
      const number = bookNumber(b.position);
      const svg = bookCardSvg({
        kicker: b.seriesName ? `${b.seriesName}${number ? ` · ${number}` : ""}` : (genre ?? "LitRPG"),
        title: b.title,
        byline: authorNames.length ? `by ${authorNames.join(", ")}` : "",
        hook: b.hook,
        cover:
          thumb && b.coverWidth && b.coverHeight
            ? { href: `data:image/png;base64,${base64(thumb)}`, width: b.coverWidth, height: b.coverHeight }
            : null,
      });
      await put(ctx, key, await rasterize(svg));
      drawn++;
    }
    await db.update(books).set({ ogImageKey: key, ogRenderedAt: now }).where(eq(books.id, b.id));
  }
  return drawn;
}

export async function renderShareImages(ctx: JobContext): Promise<number> {
  const rasterize = ctx.rasterize ?? (await import("../og/binaries")).workerRasterizer();
  const png = async (text: Parameters<typeof cardSvg>[0]) => rasterize(cardSvg(text));
  let drawn = 0;
  drawn += await once(ctx, `site:${OG_VERSION}`, async () => {
    await put(ctx, siteOgKey(), await png(siteCardText()));
    return 1;
  });
  drawn += await once(ctx, `classes:${QUIZ_HASH}-${OG_VERSION}`, async () => {
    for (const cls of READER_CLASSES) await put(ctx, classOgKey(cls.key), await png(classCardText(cls)));
    return READER_CLASSES.length;
  });
  for (const quiz of await liveQuizzes(ctx.db)) {
    drawn += await once(ctx, `quiz:${QUIZ_HASH}-${OG_VERSION}:${quiz.slug}`, async () => {
      for (const o of quiz.outcomes)
        await put(ctx, quizOgKey(quiz.slug, o.key), await png(quizCardText(quiz, o)));
      return quiz.outcomes.length;
    });
  }
  drawn += await drawBooks(ctx, rasterize);
  if (drawn) ctx.log.info("og.rendered", { drawn });
  return drawn;
}
