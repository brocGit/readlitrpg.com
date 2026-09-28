import { AppraisalError, appraisalQuestions, submitAppraisals } from "@rlr/core/catalog";
import { levelUp, refreshLevel } from "@rlr/core/readers";
import { books } from "@rlr/core/schema";
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withinLimit } from "../../../lib/match";
import { env, getDb } from "../../../lib/runtime";

async function publishedBook(slug: string) {
  const [book] = await getDb()
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.slug, slug), eq(books.visibility, "published")));
  return book ?? null;
}

/** The Appraise questions for a book: its hidden and lowest-confidence stats and dials (DESIGN §6.7). */
export const GET: APIRoute = async ({ params }) => {
  const book = await publishedBook(params.slug ?? "");
  if (!book) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ questions: await appraisalQuestions(getDb(), book.id) });
};

const answersSchema = z.object({
  answers: z
    .array(
      z.object({ key: z.string().max(40), answer: z.enum(["less", "right", "more", "yes", "mixed", "no"]) }),
    )
    .min(1)
    .max(12),
  shown: z.record(z.string().max(40), z.number().min(0).max(10).nullable()).optional(),
});

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
  const actor = await locals.actor();
  if (actor.kind !== "user") return Response.json({ error: "sign_in" }, { status: 401 });
  if (!(await withinLimit(env.RL_WRITE, "appraise", request, clientAddress))) {
    return Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const book = await publishedBook(params.slug ?? "");
  if (!book) return Response.json({ error: "not_found" }, { status: 404 });
  const parsed = answersSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    const result = await submitAppraisals(getDb(), {
      userId: actor.userId,
      bookId: book.id,
      answers: parsed.data.answers,
      shown: parsed.data.shown,
      minAppraisals: (await locals.settings())["stats.display_min_appraisals"],
    });
    // Appraising counts toward the reader's profile level (level 5 is "Appraiser").
    const level = await refreshLevel(getDb(), actor.userId);
    return Response.json({ ok: true, ...result, levelUp: levelUp(level.level, level.previousLevel) });
  } catch (error) {
    if (error instanceof AppraisalError) {
      return Response.json({ error: error.reason, message: error.message }, { status: 403 });
    }
    throw error;
  }
};
