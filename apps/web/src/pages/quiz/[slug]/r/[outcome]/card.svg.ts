import { quizCardText } from "@rlr/core/media";
import { getOutcome, getQuiz, isLive } from "@rlr/core/quiz";
import { cardSvg } from "@rlr/ui/cards";
import type { APIRoute } from "astro";
import { svgResponse } from "../../../../../lib/cards";
import { getDb } from "../../../../../lib/runtime";

/** The share card for a quiz result (QUIZZES §3.2): the outcome in the brand's colors. */
export const GET: APIRoute = async ({ params }) => {
  const quiz = getQuiz(params.slug ?? "");
  const outcome = quiz ? getOutcome(quiz, params.outcome ?? "") : undefined;
  if (!quiz || !outcome || !(await isLive(getDb(), quiz.slug)))
    return new Response("Not found", { status: 404 });
  return svgResponse(cardSvg(quizCardText(quiz, outcome)));
};
