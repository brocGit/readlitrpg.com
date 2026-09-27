# Seed files

Series-level records written from model knowledge in editorial runs (DESIGN §7.15). Upload them in the owner console under **Catalog → Import → Seed file**. Nothing here is published on the model's word: every book stays a private draft until Open Library, Google Books, a cited source, the author or the owner confirms it.

## Rules for writing entries

- **Series first.** Each entry is a series (or a standalone with no `name`). List a volume only when its title is known with confidence.
- **Omit what you're unsure of.** A field left out is better than a wrong one. Mark a doubtful volume `"confidence": "low"` and it is dropped at import.
- **No upcoming releases.** Model knowledge stops at its training cutoff; future dates come from authors and publishers.
- **Tags and genres come from `data/taxonomy.yaml`.** `pnpm test` fails on any unknown slug or duplicate series.
- **Harem only when sure.** It's an exclusion filter; leave it out rather than guess `none`.

## Format

```jsonc
{
  "format": "readlitrpg-seed",
  "version": 1,
  "generated_by": "who made this file and when",
  "entries": [
    {
      "name": "Cradle",                      // series name; omit for a standalone
      "authors": ["Will Wight"],
      "status": "complete",                  // optional: ongoing, complete, hiatus, no_recent_releases
      "genre": "progression-fantasy",        // a genre-facet slug
      "tags": ["cultivation", "weak-to-strong"],
      "tag_confidence": "high",              // high, medium or low (default medium)
      "crunch": 0,                           // optional, 0–3
      "romance": 1,                          // optional, 0–4
      "harem": "none",                       // optional
      "in_scope": "borderline",              // optional
      "confidence": "high",                  // the entry overall
      "books": [
        { "position": 1, "title": "Unsouled", "year": 2016 },
        { "position": 2, "title": "Soulsmith", "confidence": "medium" }
      ]
    }
  ]
}
```

Confidence becomes the tag score and the provenance confidence: high 0.85, medium 0.65, low (dropped for titles) 0.45.
