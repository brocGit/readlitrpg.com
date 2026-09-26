# Quizzes: Drafts, Lead Generation and Onboarding

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Last updated** | 2026-09-26 |
| **Design context** | [`DESIGN.md` §9.3](./DESIGN.md#93-fun-quizzes-lead-magnets-that-double-as-matching) (fun quizzes), [§9.1](./DESIGN.md#91-match-engine-the-headline-feature) (Match Quiz), [§7.16](./DESIGN.md#716-quiz-factory) (quiz factory) |
| **Quiz content** | `data/quizzes/*.json` is the source of truth. Readable previews are generated in [`docs/quizzes/`](./quizzes/) |
| **Checker** | `node scripts/quiz-tool.mjs check` validates every quiz and runs the balance simulation. `render` also rewrites the previews |

Quizzes do three jobs at once:

1. **Lead magnet.** Personality quizzes are among the most shared formats online.
2. **Taste signal.** Every answer secretly nudges the reader's dials, must-have stats and tags.
3. **Onboarding.** A quiz is the friendliest possible first step into a taste profile.

**Every quiz ends in books.**

---

## 1. The lineup

| Quiz | Role | Length | Results | Status |
|---|---|---|---|---|
| [What's Your LitRPG Class?](./quizzes/whats-your-litrpg-class.md) | **Flagship lead magnet.** Its results are the site-wide reader classes | 10 questions, ~90 s | 12 reader classes | Draft, balanced |
| [Which LitRPG MC Are You?](./quizzes/which-litrpg-mc-are-you.md) | Second lead magnet; strong share hook | 8 questions, ~75 s | 8 MC archetypes | Draft, balanced |
| [What Would Your System Be Like?](./quizzes/what-would-your-system-be-like.md) | Tone, crunch and lore signal disguised as a joke | 6 questions, ~60 s | 6 System personalities | Draft, balanced |
| [Would You Survive the Tutorial?](./quizzes/would-you-survive-the-tutorial.md) | Humor-first; pace, danger and strategy signal | 6 questions, ~60 s | 6 fates | Draft, balanced |
| Match Quiz | Precision tool, not a personality quiz ([`DESIGN.md` §9.1](./DESIGN.md#91-match-engine-the-headline-feature)) | 9 steps, skippable | Ranked matches | Specified |
| [How Well Do You Know LitRPG?](./quizzes/how-well-do-you-know-litrpg.md) | **Trivia.** Genre lingo and history, with shareable rank tiers | 10 questions, ~90 s | 4 rank tiers | Draft, checked |
| Series fan quizzes: DCC, He Who Fights With Monsters, Cradle | Unofficial fan quizzes (§6) | ~8 questions each | Characters / essences / Paths | In progress: waiting on research factsheets |

**Backlog ideas** (for the quiz factory once the launch set proves out):

- *What's your starting skill in the System Apocalypse?*
- *Which dungeon floor would you die on?*
- *What cultivation realm are you stuck at?*
- *Pick a loot table and we'll pick your next read.*
- *Which snarky System announcement are you?*
- Seasonal quizzes: *Build your Halloween dungeon*, *What's in your holiday loot box?*

---

## 2. How results and profiles are computed

### 2.1 Picking the result

- Each answer awards **personality points**: ★ = 2 points to its primary result, ☆ = 1 point to a secondary result.
- The result with the most points wins. **Ties** break on:
  1. how many chosen answers had that result as their primary;
  2. the latest question whose chosen answer points at one of the tied results. The final question is the "soul" question, so it matters most.
  3. If still tied, list order.
- **Quality bar**, enforced by `scripts/quiz-tool.mjs`:
  - Every result is the primary of at least 3 answers.
  - Every result is **reachable** by always picking its most favorable answers.
  - A **balance simulation** of 10,000 random quiz-takers keeps every result between 0.24× and 2× an even share. For 8 results that's 3%–25%. For the class quiz's 12 results, 2%–16.7%.

  The four drafts currently land between 6.5% and 18.3%, close to even. Balance numbers are in each preview.

### 2.2 Reader classes are site-wide

The 12 reader classes in [`data/quizzes/reader-classes.json`](../data/quizzes/reader-classes.json) aren't just quiz results. They are used for:

- the **reader class card** that any match profile maps to ([`DESIGN.md` §7.8](./DESIGN.md#78-match-engine-similarity-and-recommendations)): the nearest class to the reader's dials and stats;
- the reader's profile and the weekly digest header ("This week for The Min-Maxer");
- aggregate insights on book pages: "Most loved by: The Min-Maxer 41% · The Underdog 22%". This is shown only when at least 20 readers are in the aggregate.

Each class has a **starting profile** (dial targets, must-have stat floors, tag affinities) and 1–2 **calibration books**, chosen by us, that define the class. Calibration is automatic from there:

1. **When the catalog has dials:** a nightly job compares each class's starting profile with its calibration books' dial and stat values. It moves the seed halfway toward them and logs the change, which can be undone.
2. **Once readers arrive:** each class profile is re-fit monthly to the real profiles of readers assigned to it, so classes describe actual readers rather than our guesses.

Calibration books are never shown to readers as-is; the match engine picks live recommendations. No owner input is needed.

### 2.3 From answers to a taste profile

Each answer carries **effects**:

- **Dial nudges:** −2 to +2.
- **Must-have signals** on book stats: +1 or +2.
- **Tag affinities:** −1 to +3.

After the quiz:

```
Dials:  s_d        = sum of nudges for dial d
        target_d   = clamp(5 + 1.25 · s_d, 0, 10)
        importance = min(1, |s_d| / 4) · 0.3          # 0.3 = quiz.fun_effect_importance

Stats:  floor_s    = min(8, 5 + 1.5 · sum of signals)
        importance = min(1, sum / 3) · 0.3

Tags:   affinity_t = sum of answer affinities + result seed affinities

Blend with the result's starting profile:
        target = average of seed and answers where both exist
        importance = max(answer importance, 0.3 · seed importance)
```

Fun-quiz signal is deliberately **low importance**, because people answer in character. Anything stronger overrides it right away: rated books, the Match Quiz, marks, appraisals. The profile stores each signal with its source, so nothing is lost when better data arrives.

---

## 3. Lead-gen funnel

```mermaid
flowchart TD
  subgraph Sources
    S1[Shared result cards]
    S2[Search: quiz pages]
    S3[Communities, posted by the owner within rules]
    S4[Fan communities: series fan quizzes]
    S5[On-site: homepage, book pages, 404, house ads]
  end
  S1 & S2 & S3 & S4 & S5 --> L[Quiz landing page]
  L --> Q[Questions: one per screen, XP-bar progress]
  Q --> R[Result: class card + 3 books]
  R --> SH[Share / Party up]
  SH -. new visitors .-> L
  R --> E[Email me my full reading list]
  R --> MQ[Sharpen my matches: Match Quiz, pre-filled]
  R --> NQ[Take another quiz]
  E --> DOI[Double opt-in confirm]
  DOI --> W[Welcome sequence: 4 emails]
  W --> D[Weekly digest: personalized matches]
  MQ --> E
  NQ --> R
```

### 3.1 Traffic sources

| Source | How | Rules |
|---|---|---|
| **Shared result cards** | Every result has its own URL (`/quiz/{slug}/r/{outcome}`) and OG image. Native share, copy link, download card | The card never contains personal data |
| **Party up** (viral loop) | "Invite your party" link. A friend who takes the quiz sees both classes, a **party composition** ("Min-Maxer + Party Main: the planner and the heart") and a **party reading list** of books both profiles score highly | Only the two results are compared, never answers |
| **Search** | Quiz landing pages target "what LitRPG class am I", "which LitRPG MC are you", and later "which DCC character are you" | Indexable, fast, no interstitials |
| **Communities** | The owner posts quizzes in r/litrpg, r/ProgressionFantasy, Discords and Facebook groups **only where rules allow** (fun-flair days, self-promo threads) | Never automated. Participate as a reader first |
| **Fans and authors** | Series fan quizzes (§6) spread through fan communities for the big series. Authors often share fan content on their own | Unofficial and clearly labeled; no permission step |
| **On-site** | A quiz row on the homepage ("Not sure what you like? Find your class in 90 seconds"); "Most loved by…" on book pages linking to the class quiz; the 404 page ("You've wandered off the map. Find your class while you're here"); **house ads** in unsold slots (DESIGN §11.9); the newsletter footer | No pop-ups, no exit-intent tricks |
| **Existing subscribers** | New quizzes are announced in the digest. Each one adds signal | At most one quiz announcement a month |

### 3.2 Quiz page UX

- **Landing:** title, a one-line promise, a big **Start** button with the time estimate, and a count of adventurers classified so far. **No signup** to start or to see the result.
- **Questions:**
  - One per screen, with the System-notification flavor line (`[AMBUSH!]`).
  - Tap to advance; a back button.
  - Progress shown as an XP bar.
  - Works with a keyboard and a screen reader.
  - Under 2 minutes.
- **Result page, top to bottom:**
  1. **Class card**, styled as a status screen, with the tagline and description.
  2. **You'll love / Watch out for.**
  3. **3 books for your class**, picked live by the match engine from the quiz profile. Each gets a mini status screen and buy links. At most one is a Sponsored Match, and only if it scores ≥ 70% for this profile.
  4. **Share** · **Party up** · **Email me my full reading list** · **Sharpen my matches (2 min)** · **Take another quiz**.

### 3.3 Email capture

- **Button:** "Email me my full reading list".
- **Form:** one email field plus Turnstile. The text under it: *"We'll send your {Class} reading list and a weekly email of new matches. One click to unsubscribe. We never share your email."* A small link offers **"Just the list, no weekly email"** instead.
- **Double opt-in:** the confirmation subject is *"Confirm to get your {Class} reading list"*.
- **While they wait**, the confirmation page says: *"Check your inbox. While you wait: rate 3 books you've read and your list gets better."* This is the Match Quiz's step 1, the single most valuable signal.
- **Consent record:** `source = quiz:{slug}:{outcome}` (DESIGN §13.3). Rate limits and Turnstile as in DESIGN §15.9.

### 3.4 Welcome sequence (fully automated)

| # | When | Subject (draft) | Content | Signal it asks for |
|---|---|---|---|---|
| E0 | Immediately | Confirm to get your {Class} reading list | Double opt-in link | Confirmation |
| E1 | On confirm | Your {Class} reading list is here | 10 books picked for **their** profile, not just the class: 3 best bets with status screens, then 7 more. Each book has one-click *Read it / Loved it / Not for me* | Book marks |
| E2 | Day 2 | Your class is a starting point | "Rate 12 classics in 60 seconds and your matches get much sharper" (Match Quiz step 1) | Rated books, the biggest profile gain |
| E3 | Day 5 | New and upcoming for {Class} | New & upcoming books matching the profile, "Follow a series you love", and one other quiz (the quiz ladder) | Follows, a second quiz |
| E4 | Day 9 | Your first weekly matches | The reader joins the weekly digest. Explains the preferences page and one-click unsubscribe | — |

- **Skip rules:** if the reader already did what an email asks (took the Match Quiz, followed a series), that email's call to action is swapped for the next useful one.
- **Low engagement:** readers with no clicks on E1–E3 get the digest every other week until they click.
- **One-click email choices** ("Loved it") open a page with the choice pre-selected and a confirm tap. Email link scanners can't record choices (DESIGN §15.2).
- The "Just the list" option gets E0 and E1 only.

### 3.5 Targets (starting points; tune after 1,000 completions per quiz)

| Step | Target |
|---|---|
| Landing → start | ≥ 60% |
| Start → completed | ≥ 75% |
| Completed → shared | ≥ 8% |
| Completed → email submitted | ≥ 15% |
| Email → confirmed | ≥ 65% |
| E1 click rate | ≥ 40% |
| E2 → rated ≥ 5 books | ≥ 25% |
| 30-day active subscribers | ≥ 35% |

The quiz factory's weekly report (DESIGN §7.16) tracks these per quiz, plus drop-off per question. **A/B tests** of CTA copy and result layout are picked automatically once a variant clearly wins after ≥ 500 completions per arm. Results go into the owner's weekly summary.

---

## 4. Onboarding integration

### 4.1 One profile, many front doors

Every entry point produces the same kind of taste profile and a reader class:

| Front door | What we learn | Starting profile level |
|---|---|---|
| Fun quiz → email | Class + low-importance partial profile | 2 |
| Books you loved → save | 1–5 loved (and bounced-off) books | 3 |
| Match Quiz → save | Rated books, dials, must-haves, hard no's | 4 |
| Goodreads / StoryGraph import | Ratings and shelves | 4, or 5 with ≥ 20 rated books |
| Plain newsletter signup | Nothing yet | 1. The first email offers the class quiz |

### 4.2 Profile levels (progressive profiling, LitRPG-style)

The reader's profile has a level and an XP bar, and **each level visibly improves their matches**. Each email and page asks for **at most one** next step.

| Level | Title earned | How to reach it | What improves |
|---|---|---|---|
| 1 | *Unclassified* | Email only | Generic "popular this week" picks |
| 2 | *Classified* | Any quiz | Class-based picks |
| 3 | *Well-Read* | Rate or mark ≥ 5 books | Real personalized matches |
| 4 | *Fine-Tuned* | Set must-haves and hard no's | Heads-ups and precise filtering |
| 5 | *Appraiser* | Appraise ≥ 3 books, or import ≥ 20 rated books | Best matches, and you're helping everyone else's |

A "match confidence" meter on the results page and the profile page shows the benefit ("Level 3: matches are 2× more accurate than Level 1", measured by the offline eval, DESIGN §7.14).

### 4.3 Carrying quiz results into an account

- **No account needed to take a quiz.** A random take ID is kept in the browser's local storage. It's functional storage for the reader's own results, not analytics, and nothing is sent to third parties.
- When the reader gives their email or signs in **on the same browser**, their takes attach to their profile (`quiz_takes.user_id`). They can see and delete them in their account.
- Takes that are never attached are reduced to aggregates after 90 days (DESIGN §16.2).
- **Retakes** are allowed. The latest take's effects replace the earlier ones from the same quiz; history is kept for the reader.

### 4.4 Where quizzes show up in the product

- **Signup:** after email confirmation, "How should we learn your taste?" offers **Quick quiz (90 s)** · **Rate books (60 s)** · **Import Goodreads** · **Skip**.
- **Profile page:** class card, profile level and XP bar, quizzes taken, and "Retake".
- **Weekly digest:** a "This week for {Class}" header. One house slot promotes a quiz of the month until paid ads fill it.
- **Match results:** the reader class card is generated from any profile, so Match Quiz users get a class without taking the class quiz.
- **Book pages:** "Most loved by" class breakdown (aggregate, k ≥ 20), linking to the class quiz.

### 4.5 Privacy

- Quiz answers are **never** shown to authors or advertisers.
- Aggregates such as class breakdowns are shown only when at least 20 readers are included.
- No third-party pixels on quiz pages. Share cards contain the result only.
- Everything above follows DESIGN §16.

---

## 5. Voice

This voice is set here, applies to quizzes, result pages, emails and site copy, and is final unless reader data says otherwise. The quiz factory's prompts include this section verbatim.

**Who's talking:** a friendly System announcer who has read every LitRPG ever published and is delighted you showed up. Dry, playful, genre-literate. It teases the situation, never the reader.

**Rules:**

- **Short lines.** Most sentences are under 15 words. Answers are at most 90 characters (the checker enforces this).
- **Welcoming jokes.** Genre in-jokes are welcome (status screens, notifications, tutorials, loot, "number go up"), but every joke must land for someone reading their first LitRPG.
- **Flavor lines.** One System-notification flavor line in brackets per question (`[AMBUSH!]`, `[REWARD AVAILABLE]`), never mid-sentence.
- **Flattering results.** Written in second person, and every result is one you'd be happy to share. Even "Died Immediately" is a compliment.
- **Specific over generic.** "A very lazy cat" beats "a pet".
- **Restraint.** No hype words ("epic journey", "unleash your potential"), at most one exclamation mark per result, no emojis in quiz text.
- **No meanness.** Teasing targets situations and the System, never readers, authors or other books.
- **Fairness.** No gendered assumptions and no real-world politics. Fun quizzes never ask about gender; the Match Quiz handles MC-gender preference.
- **Spoilers.** None in general quizzes. Series quizzes state their spoiler boundary at the top and never cross it.

| Instead of | Write |
|---|---|
| "Discover your ultimate LitRPG destiny!" | "Ten questions. One class. A reading list built for your build." |
| "You are a strategic person who enjoys planning." | "You've read the stat screen three times and already found the exploit." |
| "Oops! You died! 😅" | "You pressed the glowing button. Of course you did." |
| "Our amazing curated recommendations" | "3 books for your class" |

**Email and site copy** use the same voice turned down a notch: clear first, funny second.

**Structure rules:**

- 6–10 questions with 3–6 answers each.
- Every result is the primary of at least 3 answers, with secondaries spread around.
- The final question is the "soul" question used in tie-breaks.
- Every answer carries at least one taste effect, and effects match the answer's vibe. A cozy answer never nudges `danger` up.
- Every answer should be tempting; avoid an obviously "correct" one.

## 6. Series fan quizzes and the quiz catalog

Some very large sites were built on pop-culture quizzes: "Which *Harry Potter* house are you?", "How well do you know *The Office*?". We run the same playbook for LitRPG, a fandom-heavy genre that nobody serves with quizzes today.

### 6.1 Policy: unofficial fan quizzes, no permission step

We publish series quizzes as **unofficial fan quizzes** without asking first, following the guardrails in DESIGN §16.5:

- our own words, with no official art or quotes beyond a few words;
- a spoiler boundary stated at the top;
- an "Unofficial fan quiz, not affiliated with or endorsed by {author/publisher}" line on the quiz page and result card;
- prominent (disclosed) links to buy the books.

If an author or rights holder asks for a change or removal, the quiz is **unpublished immediately** (inbox item `rights_request`, DESIGN §8.2). An **Official** version exists only when an author comes to us (DESIGN §11.2).

**Accuracy is non-negotiable, because fans notice everything:**

- Every series quiz is written from a research factsheet with cited sources.
- It uses only facts inside its spoiler boundary.
- It passes an independent accuracy review (a second model checks every result and answer against the factsheet) before publishing.

### 6.2 Formats

| Format | Example | Notes |
|---|---|---|
| **Personality** | "Which DCC character are you?" | Points pick a result. The strongest taste signal |
| **Sorting / build** | "What would your essences be?", "What's your Path?" | The result is an in-world build: a character sheet readers love to share |
| **Trivia** | "How well do you know LitRPG?", "How well do you know DCC? (books 1–2)" | The score picks a rank tier. The checker rejects quizzes where random guessers reach the top tier more than 1% of the time |
| **This or that** | "Donut or Mordecai?", "Crunchy or narrative?" | One-tap polls with live aggregate results. Cheap engagement; results become blog content |
| **Tier lists** | "Tier-rank the LitRPG classes" | Community tier lists aggregate into a living post |

### 6.3 Cadence

- **1–2 new quizzes a week** from the quiz factory (DESIGN §7.16): factsheet → draft → checker → accuracy review → inbox. The default is to publish after 48 hours unless the owner vetoes.
- **Release-week tie-ins:** when our release data shows a big series has a new book coming, the factory drafts a quiz for that series two weeks ahead. It goes live for the release-week search spike, with the spoiler boundary set at the previous book.
- **Seasonal:** Halloween dungeons, holiday loot boxes, "summer reading class".

### 6.4 Catalog plan

Within six months, the top ~25 series by reader follows each get at least one personality or sorting quiz and one trivia quiz. Start order and concepts (each is researched before drafting):

| Series | Quiz concepts |
|---|---|
| *Dungeon Crawler Carl* | Which DCC character are you? *(drafted)* · How well do you know DCC? |
| *He Who Fights With Monsters* | What would your essences be? *(drafted)* · trivia |
| *Cradle* | What's your Path? *(drafted)* · trivia |
| *The Primal Hunter* | What would your class and profession be? · trivia |
| *Defiance of the Fall* | Which Dao would you walk? · trivia |
| *The Wandering Inn* | What would your [Class] be? · trivia |
| *Mother of Learning* | Could you survive the time loop? · trivia |
| *Beware of Chicken* | Which Fa Ram resident are you? · trivia |
| *Solo Leveling* | What rank Hunter would you be? · trivia |
| *Chrysalis* | What would you evolve into? · trivia |
| *Arcane Ascension* | What would your attunement be? · trivia |
| *Azarinth Healer*, *Super Supportive*, *Mark of the Fool*, *Dungeon Born*, *Delve*, *The Completionist Chronicles*, *Heretical Fishing* | Concepts chosen by the quiz factory from each series' factsheet |

### 6.5 Drafted series quizzes

In progress. The first three (DCC, He Who Fights With Monsters, Cradle) are being written from research factsheets with cited sources.

## 7. Implementation notes

- **Format:** each quiz is one JSON file in `data/quizzes/`: `slug`, `title`, `dek`, `kind`, `status`, `spoiler_boundary`, and `questions[].options[]`.
  - **Personality** quizzes (`kind: "fun"`) give each option `points` and `effects`, plus `outcomes` (or `"outcomes_from": "reader-classes"`).
  - **Trivia** quizzes (`kind: "trivia"`) mark one option per question `correct`, add an `explain` line, and use rank tiers with `min_score`. This maps one-to-one onto the `quizzes`, `quiz_items` and `quiz_outcomes` tables (DESIGN §5.6). M1 seeds them from these files.
- **Checker:** `scripts/quiz-tool.mjs` validates keys against the dial and stat lists and against `TAXONOMY.md`, checks reachability and runs the balance simulation. The quiz factory (DESIGN §7.16) reuses the same rules before any quiz reaches the owner's inbox.
- **Build placement:**
  - **M3:** quiz engine, result pages, share cards, Party up, the four launch quizzes.
  - **M5:** email capture, the welcome sequence, profile levels.
  - **M7:** quiz analytics in the owner's weekly report.
