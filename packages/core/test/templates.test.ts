import { describe, expect, it } from "vitest";
import { lostSeparatorSpaces } from "../src/testing";

describe("lostSeparatorSpaces", () => {
  it("finds separators that would render glued to a tag", () => {
    const src = [
      "---",
      "const x = 1; // · not the template",
      "---",
      '<p><a href="/a">A</a> ·',
      '  <a href="/b">B</a></p>',
      "<p>{count}",
      "  · words</p>",
      '<p><a href="/a">A</a> ·{" "}',
      '  <a href="/b">B</a></p>',
      '<span class="muted">',
      "  · inside a span</span>",
    ].join("\n");
    expect(lostSeparatorSpaces(src)).toEqual([4, 7]);
  });
});
