---
name: editorial-post-draft
description: Draft a ReadLitRPG guide ("What is Dungeon Core? Where to start") from catalog data during an editorial run, naming books only by shortcode so nothing can be invented. Use for queue items of kind "post_draft".
---

# Guide draft

Skill version: 1

At most once a week the queue asks for a guide to one genre or premise tag (DESIGN §14.1 "Editorial
draft"). It's published as "Written with AI assistance", waits three days for the owner's veto, and
takes the Wednesday guide slot. The server's validator (§14.4) refuses anything that could carry an
invented fact.

Run `pnpm editorial brief post_draft` for the format.

- **Only `input.books`.** Every book you show goes in a section's `book_ids`; in prose, a book
  appears only as `[[book:ID]]`, never as a plain title. Book cards on the page show titles,
  series, dates and covers live from the catalog.
- **Say why, not what.** The prose explains what the tag is (use `input.tag.description`, in your
  own words) and why each group of books fits a reader: "if you like base-building", "finished
  series", "shorter reads". Leave out facts the input doesn't give you: plot details, sales,
  awards, dates.
- **Numbers:** only ones that appear in the input. Easiest is to use none.
- **Shape:** 2 to 8 sections with short headings; each section 1 to 3 sentences and 1 to 15
  books; at least 5 books in total; a one-line outro.
- **Tone:** the friendly System announcer (QUIZZES §5), dry and genre-literate, clear first.
- `topic_key` is `input.topic_key`, unchanged.
