# Classification golden set

`golden.jsonl` holds books with adjudicated labels: scope, primary genre, tags, crunch and romance levels, harem, content flags and dials. `pnpm eval:classify <proposals>` scores an editorial run's classifications against it (DESIGN §7.14).

## Scoring a run

```sh
pnpm editorial eval-input                     # the golden books as a blind work file (no labels)
# classify that file following .claude/skills/editorial-classify/SKILL.md, without reading this folder
pnpm eval:classify .editorial/work/<your proposals>.json
```

The report covers:

- per-facet precision and recall, for tags shown at medium confidence or higher;
- **recall on exclusion signals**: commonly excluded tags, harem, romance ≥ 3, content flags. These count at any confidence, as the exclude filters do;
- scope, genre and harem accuracy;
- mean absolute error on the crunch and romance levels and on each dial.

**The gate** compares against `baseline.json`:

- exclusion recall may not drop at all;
- macro-F1 may drop by at most 2 points;
- no dial's error may rise by more than 0.5.

Run it before changing the classify skill, and monthly. Record a new baseline only when a change is meant to move it:

```sh
pnpm eval:classify <proposals> --update-baseline --notes "why"
```

`pnpm eval:classify` with no file only checks the set against the taxonomy. `pnpm check` and CI run that.

## How the set is made

No owner time is needed:

1. Two labeling passes classify every book independently (separate sessions, the same skill).
2. `pnpm editorial golden-merge` keeps what they agree on:
   - tags both listed at medium or higher;
   - dials within 2 points (averaged);
   - identical levels and values.
3. Every disagreement goes to a third, adjudicating pass. Its answers carry a reason, which lands in each entry's `evidence`.
4. Exclusion tags and content flags are never dropped without adjudication.

```sh
pnpm editorial golden-merge --inputs <work.json> --a <pass-a files> --b <pass-b files> \
  [--resolve <resolutions.json>] --out data/eval/golden.jsonl
```

The set deliberately includes hard cases: harem and harem-adjacent books, cultivation vs. LitRPG, cozy vs. slice of life, and borderline and out-of-scope books.

**Current slice:** 74 well-known books, labeled from model knowledge in September 2026. The design target is about 200. Later slices add books, and research runs can add citations to the evidence.
