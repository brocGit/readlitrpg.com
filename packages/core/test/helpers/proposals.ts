// A valid classification to start from in tests; override what the test is about.

import type { ClassifyProposal } from "../../src/editorial";

export function classification(bookId: string, itemId: string, over: Partial<ClassifyProposal> = {}) {
  return {
    kind: "classify",
    item_id: itemId,
    book_id: bookId,
    in_scope: "yes",
    primary_genre: "litrpg",
    tags: [
      {
        slug: "system-apocalypse",
        confidence: "high",
        evidence: "The System arrives on Earth in chapter one.",
      },
      { slug: "male-mc", confidence: "high", evidence: "Jake is the protagonist." },
      { slug: "humorous", confidence: "low", evidence: "Some banter." },
    ],
    crunch_level: { value: 2, confidence: "medium" },
    romance_level: { value: 0, confidence: "medium" },
    harem: { value: "none", confidence: "high" },
    known_work: "yes",
    dials: {
      crunch: { value: 6, confidence: "medium" },
      pacing: { value: 7, confidence: "medium" },
      romance: { value: 0, confidence: "medium" },
      lore: { value: "unknown", confidence: "low" },
    },
    stats: {
      number_go_up: { value: 9, confidence: "medium" },
      competent_mc: { value: 7, confidence: "low" },
    },
    content_flags: ["graphic-violence"],
    summary: "A hunter wakes up in a tutorial world and has to survive a system that rewards the ruthless.",
    hook: "Survive the tutorial, then outgrow it.",
    anomalies: [],
    ...over,
  };
}
