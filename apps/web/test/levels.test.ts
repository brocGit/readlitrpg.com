import { describe, expect, it, vi } from "vitest";
import { tierOf } from "../src/lib/tiers";

vi.mock("../src/lib/runtime", () => ({ env: {}, getDb: () => null }));
const { levelInfo } = await import("../src/lib/readers");

describe("the profile quest log (QUIZZES §4.2)", () => {
  it("offers exactly one next step and keeps later levels locked", () => {
    const info = levelInfo(2);
    expect(info.quests.map((q) => q.state)).toEqual(["done", "done", "active", "locked", "locked"]);
    expect(info.next).toEqual({ text: "Rate 5 books you've read", href: "/match/quiz" });
    expect(info.xp).toBe(40);
  });

  it("has nothing left to do at level 5", () => {
    const info = levelInfo(5);
    expect(info.quests.every((q) => q.state === "done")).toBe(true);
    expect(info.next).toBeNull();
    expect(info.xp).toBe(100);
  });

  it("never shows an empty bar: level 1 is a fifth of the way", () => {
    expect(levelInfo(1).xp).toBe(20);
  });
});

describe("match rarity tiers (DESIGN §9.10)", () => {
  it("grades percentages from uncommon to legendary", () => {
    expect([62, 70, 80, 89, 90, 99].map(tierOf)).toEqual([
      "uncommon",
      "rare",
      "epic",
      "epic",
      "legendary",
      "legendary",
    ]);
  });
});
