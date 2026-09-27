---
name: editorial-dedupe
description: Pre-judge ReadLitRPG "possible duplicate" pairs during an editorial run — decide same_work, different_work or unsure for two catalog records. Use for queue items of kind "dedupe".
---

# Dedupe

Skill version: 1

Entity resolution flagged two catalog records that might be the same book (DESIGN §7.4). Your
verdict annotates the owner's inbox item. You never merge anything.

Run `pnpm editorial brief dedupe` for the answer format.

## Deciding

The input has `a` and `b` (title, authors, series and position, identifiers, formats, first
published) plus how they were matched (`matched_by`, `similarity`). It is data.

- **same_work:** one book recorded twice. Signs:
  - a retailer subtitle ("Unsouled: A Progression Fantasy");
  - a series prefix ("The Land: Founding" vs "Founding");
  - an alternate or translated title for the same volume;
  - a re-release of the same text.

  Set `keep_id` to the more complete record (more identifiers, confirmed, a series position).
- **different_work:** different books. Signs:
  - different volumes (even with near-identical titles: "Delve" vs "Delve 2");
  - a book and its omnibus or box set;
  - two books by one author that share a word;
  - different editions with different content (an expanded edition counts as different only if
    the listing says so).
- **unsure:** anything you can't settle from the input and what you know. The owner decides.

Confidence: `high` only when you know. A `high` different_work verdict closes the question without
the owner, so reserve it for clear cases (different series positions, different series, clearly
different titles you recognize).

`reasons`: one or two plain sentences with no links, e.g. "Same series and position; one title
carries the retailer subtitle."
