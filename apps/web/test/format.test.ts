import { describe, expect, it } from "vitest";
import { authorLine } from "../src/lib/format";

describe("authorLine", () => {
  it("lists a few authors in full and counts the rest", () => {
    expect(authorLine([])).toBe("");
    expect(authorLine(["Ann"])).toBe("Ann");
    expect(authorLine(["Ann", "Bo", "Cy"])).toBe("Ann, Bo, Cy");
    expect(authorLine(["Ann", "Bo", "Cy", "Di"])).toBe("Ann, Bo and 2 more");
    expect(authorLine(["Ann", "Bo", "Cy", "Di"], 1)).toBe("Ann and 3 more");
  });
});
