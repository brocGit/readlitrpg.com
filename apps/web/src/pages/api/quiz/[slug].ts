import {
  getOutcome,
  getQuiz,
  isLive,
  QuizAnswerError,
  recordTake,
  takeOutcome,
  takeQuiz,
} from "@rlr/core/quiz";
import type { APIRoute } from "astro";
import { z } from "zod";
import { withinLimit } from "../../../lib/match";
import { booksForOutcome, partyFor, publicOutcome } from "../../../lib/quiz";
import { env, getDb } from "../../../lib/runtime";

const takeSchema = z.object({
  answers: z.array(z.string().max(8)).min(1).max(30),
  source: z.enum(["share", "search", "community", "author", "onsite", "newsletter"]).optional(),
  party: z.string().max(40).optional(),
});

/** Score a quiz take on the server, store it anonymously, and return the result (QUIZZES §3.2). */
export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
  if (!(await withinLimit(env.RL_WRITE, "quiz", request, clientAddress))) {
    return Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const db = getDb();
  const quiz = getQuiz(params.slug ?? "");
  if (!quiz || !(await isLive(db, quiz.slug))) return Response.json({ error: "not_found" }, { status: 404 });
  const parsed = takeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_answers" }, { status: 400 });
  const settings = await locals.settings();
  let result: ReturnType<typeof takeQuiz>;
  try {
    result = takeQuiz(quiz, parsed.data.answers, settings["quiz.fun_effect_importance"]);
  } catch (error) {
    if (error instanceof QuizAnswerError) return Response.json({ error: "invalid_answers" }, { status: 400 });
    throw error;
  }
  const inviter = parsed.data.party ? await takeOutcome(db, parsed.data.party) : null;
  const partyRef = inviter?.quizSlug === quiz.slug ? (parsed.data.party ?? null) : null;
  const take = await recordTake(db, {
    quiz,
    answers: parsed.data.answers,
    outcomeKey: result.outcome.key,
    score: result.score,
    source: parsed.data.source,
    partyRef,
  });
  const theirs = inviter && partyRef ? getOutcome(quiz, inviter.outcomeKey) : undefined;
  return Response.json({
    take,
    outcome: publicOutcome(result.outcome),
    score: result.score ?? null,
    total: result.total ?? null,
    // Trivia: after the whole quiz, show what was right and why.
    review:
      quiz.kind === "trivia"
        ? quiz.questions.map((q, i) => ({
            id: q.id,
            yours: parsed.data.answers[i],
            correct: q.options.find((o) => o.correct)?.id ?? null,
            explain: q.explain ?? null,
          }))
        : null,
    resultUrl: `/quiz/${quiz.slug}/r/${result.outcome.key}`,
    books: await booksForOutcome(result.outcome, settings),
    party: theirs ? await partyFor(result.outcome, theirs, settings) : null,
  });
};
