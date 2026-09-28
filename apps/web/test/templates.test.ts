// Separators keep their spaces: Astro drops a line break's whitespace next to a tag, so "·" at a
// line's end renders glued to the next link (see lostSeparatorSpaces).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lostSeparatorSpaces } from "@rlr/core/testing";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".astro") ? [full] : [];
  });
}

describe("templates", () => {
  it("keep the spaces around · separators", () => {
    const glued = walk(SRC).flatMap((file) =>
      lostSeparatorSpaces(readFileSync(file, "utf8")).map((line) => `${relative(SRC, file)}:${line}`),
    );
    expect(glued).toEqual([]);
  });
});
