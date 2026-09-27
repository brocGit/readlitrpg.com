import { describe, expect, it } from "vitest";
import { isCrossSiteFormPost } from "../src/lib/origin";
import { CROSS_SITE_POSTS, ROUTES } from "../src/routes";

const url = new URL("https://readlitrpg.com/api/subscribe");
const post = (headers: Record<string, string>) => new Request(url, { method: "POST", headers, body: "x" });

describe("form origin check", () => {
  it("refuses cross-site and origin-less form posts", () => {
    expect(isCrossSiteFormPost(post({ "content-type": "application/x-www-form-urlencoded" }), url)).toBe(
      true,
    );
    expect(
      isCrossSiteFormPost(post({ "content-type": "text/plain", origin: "https://evil.example" }), url),
    ).toBe(true);
    expect(isCrossSiteFormPost(new Request(url, { method: "POST" }), url)).toBe(true);
  });

  it("allows same-origin posts, JSON bodies (which need a preflight) and safe methods", () => {
    expect(
      isCrossSiteFormPost(
        post({ "content-type": "multipart/form-data; boundary=x", origin: url.origin }),
        url,
      ),
    ).toBe(false);
    expect(isCrossSiteFormPost(post({ "content-type": "application/json" }), url)).toBe(false);
    expect(isCrossSiteFormPost(new Request(url), url)).toBe(false);
  });

  it("exempts only registered routes", () => {
    for (const route of CROSS_SITE_POSTS) expect(Object.hasOwn(ROUTES, route)).toBe(true);
  });
});
