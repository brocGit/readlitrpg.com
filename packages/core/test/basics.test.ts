import { describe, expect, it } from "vitest";
import { maskEmail } from "../src/auth";
import { hashIp, randomToken, sha256Hex, timingSafeEqual } from "../src/crypto";
import { isUlid, ulid, ulidTime } from "../src/ids";
import { redact } from "../src/log";
import { safeRedirectPath } from "../src/security";

describe("ulid", () => {
  it("is 26 Crockford base32 chars and encodes the time", () => {
    const t = Date.UTC(2026, 8, 26, 12);
    const id = ulid(t);
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBe(t);
  });

  it("sorts by time", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });
});

describe("crypto", () => {
  it("sha256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("random tokens are 256-bit and URL-safe", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("timing-safe compare", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("IP hashes change daily and hide the IP", async () => {
    const a = await hashIp("203.0.113.9", "seed", "2026-09-26");
    const b = await hashIp("203.0.113.9", "seed", "2026-09-27");
    expect(a).not.toBe(b);
    expect(a).not.toContain("203");
    expect(a).toHaveLength(32);
  });
});

describe("log redaction", () => {
  it("drops sensitive keys and scrubs values", () => {
    const out = redact({
      email: "a@b.com",
      token: "t",
      headers: { authorization: "Bearer abc", cookie: "x" },
      note: "mail jane@example.com from 198.51.100.7",
      email_hash: "keep",
      user_id: "keep",
    }) as Record<string, unknown>;
    expect(out.email).toBe("[redacted]");
    expect(out.token).toBe("[redacted]");
    expect(out.headers).toEqual({ authorization: "[redacted]", cookie: "[redacted]" });
    expect(out.note).toBe("mail [email] from [ip]");
    expect(out.email_hash).toBe("keep");
    expect(out.user_id).toBe("keep");
  });
});

describe("safe redirects", () => {
  it("keeps same-site paths", () => {
    expect(safeRedirectPath("/account?tab=1#x")).toBe("/account?tab=1#x");
  });

  it("rejects anything that leaves the site", () => {
    for (const bad of ["https://evil.test/", "//evil.test", "/\\evil.test", "javascript:alert(1)", "evil"]) {
      expect(safeRedirectPath(bad, "/")).toBe("/");
    }
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("jane.doe@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("nope")).toBe("***");
  });
});
