// The one shape every catalog source is converted into before ingest: the owner's quick-add form,
// CSV rows, seed files, API results and (later) author submissions.

import { z } from "zod";
import { FORMATS, HAREM, IN_SCOPE, NARRATION, PUB_STATUS, RELEASE_KINDS, SERIES_STATUS } from "../db/schema";

const name = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const editionInputSchema = z.object({
  format: z.enum(FORMATS),
  asin: z.string().trim().max(20).optional(),
  isbn: z.string().trim().max(20).optional(),
  audibleAsin: z.string().trim().max(20).optional(),
  publisher: name.optional(),
  narrators: z.array(name).max(20).optional(),
  narrationType: z.enum(NARRATION).optional(),
  durationMinutes: z.number().int().min(1).max(10_000).optional(),
  kindleUnlimited: z.boolean().optional(),
  audiblePlus: z.boolean().optional(),
});

export const bookInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  subtitle: optionalText(300),
  authors: z
    .array(z.object({ name, role: z.enum(["author", "coauthor", "with"]).optional() }))
    .min(1)
    .max(10),
  series: z
    .object({
      name,
      position: z.number().min(0).max(1000).optional(),
      status: z.enum(SERIES_STATUS).optional(),
    })
    .optional(),
  primaryGenre: z.string().trim().max(60).optional(),
  tags: z
    .array(
      z.object({ slug: z.string().trim().min(1).max(80), confidence: z.number().min(0).max(1).optional() }),
    )
    .max(40)
    .optional(),
  crunchLevel: z.number().int().min(0).max(3).optional(),
  romanceLevel: z.number().int().min(0).max(4).optional(),
  harem: z.enum(HAREM).optional(),
  contentFlags: z.array(z.string().trim().max(40)).max(10).optional(),
  firstPublished: z.string().trim().max(40).optional(),
  pageCount: z.number().int().min(1).max(20_000).optional(),
  wordCountEst: z.number().int().min(1_000).max(10_000_000).optional(),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}$/)
    .optional(),
  pubStatus: z.enum(PUB_STATUS).optional(),
  inScope: z.enum(IN_SCOPE).optional(),
  isAiGenerated: z.enum(["human", "ai_assisted", "ai_generated", "unknown"]).optional(),
  blurb: optionalText(5_000),
  editions: z.array(editionInputSchema).max(10).optional(),
  links: z.array(z.string().trim().max(2_000)).max(20).optional(),
  releases: z
    .array(
      z.object({
        kind: z.enum(RELEASE_KINDS),
        date: z.string().trim().max(40),
        region: z.string().max(2).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** Overall confidence for model-sourced records (seeds); scales tag and field confidence. */
  confidence: z.number().min(0).max(1).optional(),
});

export type BookInput = z.infer<typeof bookInputSchema>;
export type EditionInput = z.infer<typeof editionInputSchema>;
