---
name: quiz-factory
description: Draft a new ReadLitRPG quiz (personality, sorting or trivia) from the brief backlog — research a cited factsheet, write the quiz JSON in the house voice, pass the balance checker and an independent accuracy review, and open a pull request. Use for the weekly quiz-factory routine or when asked to "make a quiz".
---

# Quiz factory

Skill version: 1

Quizzes bring new readers in and double as taste signal for matching (DESIGN §7.16, QUIZZES.md).
You draft one quiz per run and hand it over as a pull request. After the owner merges it and it
deploys, the `quiz.announce` job opens an inbox item. The quiz goes live after
`quiz.auto_publish_hours` (48 by default) unless the owner retires it first. Never set a quiz
live yourself, and never change engine code in a quiz run.

## 1. Pick the brief

1. Open `data/quizzes/BRIEFS.md` and take the first unchecked line.
2. If the list is empty, take the next undrafted concept from the catalog plan in QUIZZES.md §6.4, or
   a release-week tie-in (a big series with a book due in about two weeks, spoiler boundary at the
   previous book).
3. Choose a slug that reads like the title (`which-primal-hunter-class-are-you`). Check that
   `data/quizzes/<slug>.json` doesn't exist.
4. Work on a branch named `quiz-factory/<slug>` from the default branch.

## 2. Research a factsheet (series quizzes)

A series quiz is written from facts you can cite, inside its spoiler boundary. Fans notice everything.

- Write the factsheet to `data/quizzes/factsheets/<slug>.md`. For each fact, give where it first
  appears (book number) and a source URL.
- **Sources:** use web search. Author and publisher sites, fan wikis and interviews are fine.
  Never fetch Amazon, Audible, Goodreads or Royal Road pages (DESIGN §7.15), even to check a fact.
- **Spoiler boundary:** only facts from inside it. When you can't tell where something is first
  revealed, leave it out. The launch quizzes dropped a Path because its name only appears in book 8.
- **Our words only.** Don't copy wiki text. Quote at most a few words of the books.
- **No canon collisions.** For build and sorting quizzes, don't hand a reader a named character's
  exact build unless the result says it is that character's (see QUIZZES §6.5 for how the essences
  quiz handled this).

General-genre quizzes (no series) need no factsheet. Keep them spoiler-free.

## 3. Draft the quiz

- Copy the shape of an existing file of the same kind:
  - personality: `data/quizzes/which-dcc-character-are-you.json`;
  - sorting: `what-would-your-essences-be.json`;
  - trivia: `how-well-do-you-know-litrpg.json`.
- Required fields for a series quiz:
  - `series`, `series_author`, `spoiler_boundary`;
  - `sources` (the factsheet's URLs);
  - `is_official: false`;
  - `status: "draft"`. The file's status never changes to live; the console decides that.
- **Voice:** follow QUIZZES.md §5 exactly: the friendly System announcer, short lines, one bracketed
  flavor line per question, flattering results, no emojis, no gendered or political questions.
- **Structure:**
  - 6–10 questions of 3–6 answers, with answers at most 90 characters.
  - Every result is the primary of at least 3 answers.
  - The last question is the "soul" question.
- **Effects:** every answer carries a taste effect that fits its vibe. Use only the dial and stat keys
  in `data/taxonomy.yaml` and active tag slugs. Outcomes get a `profile_seed` the same way.
- **Trivia:** exactly one `correct` option per question, an `explain` line, and rank tiers with
  `min_score`.

## 4. Check, render, build

```sh
node scripts/quiz-tool.mjs check    # keys, reachability, balance (10,000 simulated takers)
node scripts/quiz-tool.mjs render   # writes the readable preview to docs/quizzes/<slug>.md
node scripts/quiz-tool.mjs build    # regenerates packages/core/src/quiz/quizzes.gen.ts
```

- If the balance fails, change the points, not the rules.
- If an outcome wins too often, move one of its primaries to a result that wins too rarely.

## 5. Independent accuracy review

Start a fresh subagent that hasn't seen your drafting. Give it only the factsheet and the rendered
preview, and ask it to:

- check every answer, correct option and result description against the factsheet;
- flag anything past the spoiler boundary, any fact not in the factsheet, and any canon collision;
- flag voice problems: meanness, hype words, gendered assumptions.

Fix or cut everything it flags, then re-run step 4. Keep a short list of the calls it made; they go
in the pull request.

## 6. Hand it over

1. Tick the brief in `BRIEFS.md`.
2. Mark the concept *(drafted)* in QUIZZES.md §6.4 if it's listed there.
3. Run `pnpm check`. It must pass.
4. Commit only these files:
   - `data/quizzes/<slug>.json` and its factsheet;
   - `docs/quizzes/<slug>.md`;
   - `quizzes.gen.ts`;
   - `BRIEFS.md` and the QUIZZES.md line.
5. Push the branch and open a pull request titled `Quiz: <title>`. The body gives:
   - the brief and spoiler boundary;
   - a link to the preview;
   - the balance numbers from `check`;
   - the reviewer's calls and what you changed.
6. Don't merge it. The owner merges; the inbox does the rest.

If you can't make the facts hold inside the boundary, don't force it. Write a line under the brief
in `BRIEFS.md` saying why it's parked, and take the next brief.
