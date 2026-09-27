// Living lists (DESIGN §9.2): a saved search plus a short intro. They update themselves as the
// catalog changes and double as the blog's evergreen backbone. Intros are plain and factual; the
// list itself is always computed from the data.

import type { FindQuery } from "./find";

export interface LivingList {
  slug: string;
  title: string;
  intro: string;
  query: Partial<FindQuery>;
}

export const LIVING_LISTS: readonly LivingList[] = [
  {
    slug: "litrpg-with-no-harem",
    title: "LitRPG with no harem",
    intro:
      "LitRPG and progression fantasy where the romance, if any, stays with one partner at a time. Books we can't yet rule out are left off: the list is conservative on purpose.",
    query: { include: ["litrpg"], noes: ["harem"], sort: "quality" },
  },
  {
    slug: "completed-litrpg-series-with-audiobooks",
    title: "Completed LitRPG series with audiobooks",
    intro: "Finished series you can listen to from start to end, with no waiting on the next book.",
    query: { include: ["litrpg"], status: "complete", formats: ["audiobook"], sort: "quality" },
  },
  {
    slug: "cozy-litrpg",
    title: "Cozy LitRPG and progression fantasy",
    intro:
      "Low stakes, warm casts and plenty of downtime: crafting, farming, shops and slow afternoons, with levels on the side.",
    query: { include: ["cozy"], sort: "quality" },
  },
  {
    slug: "crunchy-litrpg",
    title: "Crunchy LitRPG: stat blocks and build math",
    intro:
      "For readers who study the status screen: frequent stat blocks, meaningful build choices and numbers that matter.",
    query: { dials: { crunch: [7, 10] }, sort: "dial:crunch:desc" },
  },
  {
    slug: "progression-fantasy-without-a-system",
    title: "Progression fantasy without a visible system",
    intro:
      "The climb to power without status screens: cultivation, magic academies and hard-won growth told in prose.",
    query: { include: ["progression-fantasy"], dials: { crunch: [0, 2] }, sort: "quality" },
  },
  {
    slug: "dungeon-core-books",
    title: "Dungeon core books",
    intro:
      "Stories where the protagonist is the dungeon, or bonded to one, and builds its floors, monsters and traps.",
    query: { include: ["dungeon-core"], sort: "quality" },
  },
  {
    slug: "system-apocalypse-books",
    title: "System apocalypse books",
    intro: "The System arrives on Earth and nothing is the same: survival, leveling and rebuilding.",
    query: { include: ["system-apocalypse"], sort: "quality" },
  },
  {
    slug: "cultivation-with-a-system",
    title: "Cultivation with a visible system",
    intro: "Realms, qi and sects, with status screens and notifications on the page.",
    query: { include: ["cultivation", "litrpg"], sort: "quality" },
  },
  {
    slug: "litrpg-with-a-female-mc",
    title: "LitRPG with a female protagonist",
    intro: "LitRPG and progression fantasy led by a female main character.",
    query: { include: ["female-mc"], sort: "quality" },
  },
  {
    slug: "fast-paced-litrpg",
    title: "Fast-paced LitRPG",
    intro: "Relentless escalation: action and power gains nearly every chapter.",
    query: { dials: { pacing: [8, 10] }, sort: "dial:pacing:desc" },
  },
];

export function getList(slug: string): LivingList | undefined {
  return LIVING_LISTS.find((l) => l.slug === slug);
}
