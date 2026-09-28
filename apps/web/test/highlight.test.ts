import { describe, expect, it } from "vitest";
import { highlight } from "../src/lib/highlight";

describe("highlight", () => {
  it("marks each word of the search, ignoring case", () => {
    expect(highlight("The Tower Ledger", "tower LEDGER")).toEqual([
      { text: "The ", hit: false },
      { text: "Tower", hit: true },
      { text: " ", hit: false },
      { text: "Ledger", hit: true },
    ]);
  });

  it("leaves text alone when nothing usable was searched", () => {
    expect(highlight("Dungeon Core", "a")).toEqual([{ text: "Dungeon Core", hit: false }]);
    expect(highlight("Dungeon Core", "zzz")).toEqual([{ text: "Dungeon Core", hit: false }]);
  });

  it("treats regex characters in a search as text", () => {
    expect(highlight("He Who Fights (Book 2)", "(book")).toEqual([
      { text: "He Who Fights (", hit: false },
      { text: "Book", hit: true },
      { text: " 2)", hit: false },
    ]);
    expect(highlight("C++ Mage", "c++").some((p) => p.hit)).toBe(false);
  });
});
