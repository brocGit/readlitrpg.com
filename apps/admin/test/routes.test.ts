// Every file in src/pages needs an access rule in src/routes.ts, and every rule needs a page
// (DESIGN §15.4). A new page without a rule fails the build instead of shipping unguarded.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/routes";

const PAGES = join(import.meta.dirname, "../src/pages");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** src/pages/account/index.astro → /account; api/auth/[...all].ts → /api/auth/[...all] */
function routePattern(file: string): string {
  const path = relative(PAGES, file)
    .replace(/\.(astro|ts|js|md|mdx)$/, "")
    .replace(/(^|\/)index$/, "");
  return `/${path}`.replace(/\/$/, "") || "/";
}

describe("route registry", () => {
  const files = walk(PAGES).filter((f) => /\.(astro|ts|js|md|mdx)$/.test(f));
  const patterns = files.map(routePattern).sort();

  it("has a rule for every page and endpoint", () => {
    const missing = patterns.filter((p) => !(p in ROUTES));
    expect(missing).toEqual([]);
  });

  it("has no rules for pages that don't exist", () => {
    const stale = Object.keys(ROUTES).filter((p) => !patterns.includes(p));
    expect(stale).toEqual([]);
  });

  it("keeps console pages admin-only", () => {
    for (const page of ["/", "/inbox", "/automation", "/settings", "/audit"] as const) {
      expect(ROUTES[page].kind).toBe("admin");
    }
  });
});
