import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCsp, reroutesToErrorPage, securityHeaders, verifyAccessJwt } from "../src/security";

const TEAM = "https://readlitrpg.cloudflareaccess.com";
const AUD = "aud-tag-123";

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

async function token(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; aud?: string; iss?: string; exp?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

const request = (jwt?: string) =>
  new Request("https://admin.readlitrpg.com/", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });

const verify = (jwt?: string) => verifyAccessJwt(request(jwt), { teamDomain: TEAM, audience: AUD, keys });

describe("Cloudflare Access JWT", () => {
  it("accepts a valid user token", async () => {
    const result = await verify(await token({ email: "Owner@Example.com", sub: "u1" }));
    expect(result).toEqual({ ok: true, identity: { kind: "user", email: "owner@example.com", sub: "u1" } });
  });

  it("accepts a service token", async () => {
    const result = await verify(await token({ common_name: "client-id.access", sub: "" }));
    expect(result).toMatchObject({ ok: true, identity: { kind: "service", clientId: "client-id.access" } });
  });

  it("rejects missing, wrong audience, wrong issuer, expired and forged tokens", async () => {
    expect(await verify()).toEqual({ ok: false, reason: "missing_assertion" });
    expect((await verify(await token({ email: "a@b.c" }, { aud: "other" }))).ok).toBe(false);
    expect(
      (await verify(await token({ email: "a@b.c" }, { iss: "https://evil.cloudflareaccess.com" }))).ok,
    ).toBe(false);
    expect((await verify(await token({ email: "a@b.c" }, { exp: "-10m" }))).ok).toBe(false);
    expect((await verify(await token({ email: "a@b.c" }, { key: otherKey }))).ok).toBe(false);
    expect((await verify("not.a.jwt")).ok).toBe(false);
  });

  it("fails closed when misconfigured", async () => {
    const jwt = await token({ email: "a@b.c" });
    expect(await verifyAccessJwt(request(jwt), { teamDomain: TEAM, audience: "", keys })).toEqual({
      ok: false,
      reason: "misconfigured",
    });
    expect(
      await verifyAccessJwt(request(jwt), { teamDomain: "https://evil.test", audience: AUD, keys }),
    ).toEqual({
      ok: false,
      reason: "misconfigured",
    });
  });
});

describe("security headers", () => {
  it("production CSP is strict", () => {
    const csp = buildCsp({ nonce: "abc", mediaOrigin: "https://media.readlitrpg.com", turnstile: true });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-abc' https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: https://media.readlitrpg.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("dev CSP allows HMR but never ships nonces alongside unsafe-inline", () => {
    const csp = buildCsp({ nonce: "abc", dev: true });
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("ws:");
  });

  it("sets HSTS only when asked", () => {
    expect(securityHeaders({ hsts: true })["Strict-Transport-Security"]).toContain("max-age=63072000");
    expect(securityHeaders()["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ noReferrer: true })["Referrer-Policy"]).toBe("no-referrer");
  });

  it("knows which responses Astro replaces with the error page", () => {
    expect(reroutesToErrorPage(new Response(null, { status: 404 }))).toBe(true);
    expect(reroutesToErrorPage(new Response(null, { status: 500 }))).toBe(true);
    // A body means the handler answered itself (an API's JSON 404), and a 403 is never replaced.
    expect(reroutesToErrorPage(Response.json({ error: "not_found" }, { status: 404 }))).toBe(false);
    expect(reroutesToErrorPage(new Response(null, { status: 403 }))).toBe(false);
  });
});
