// The quiz player only ever gets prompts and labels: points, effects and correct answers stay on
// the server, which scores every take (QUIZZES §3.2). A leak would let anyone pick their result.

import { getQuiz, QUIZZES } from "@rlr/core/quiz";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/runtime", () => ({ env: {}, getDb: () => null }));
const { playable, publicOutcome } = await import("../src/lib/quiz");

describe("what the quiz player receives", () => {
  it("has no points, effects or correct answers for any quiz", () => {
    for (const quiz of QUIZZES) {
      const text = JSON.stringify(playable(quiz));
      expect(text).not.toMatch(/"points"|"effects"|"correct"|"explain"|profile_seed/);
      expect(playable(quiz).questions).toHaveLength(quiz.questions.length);
    }
  });

  it("marks series quizzes as unofficial unless the author took part", () => {
    const dcc = getQuiz("which-dcc-character-are-you");
    if (!dcc) throw new Error("missing quiz");
    expect(playable(dcc).disclaimer).toMatch(/unofficial/i);
    const general = getQuiz("whats-your-litrpg-class");
    if (!general) throw new Error("missing quiz");
    expect(playable(general).disclaimer).toBeNull();
  });

  it("shares a result without its scoring data", () => {
    const quiz = getQuiz("whats-your-litrpg-class");
    const outcome = quiz?.outcomes[0];
    if (!outcome) throw new Error("missing outcome");
    expect(JSON.stringify(publicOutcome(outcome))).not.toMatch(/profile_seed|min_score|calibration/);
  });
});
