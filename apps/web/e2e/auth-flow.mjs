// End-to-end sign-in test in a real browser against `astro preview` (workerd):
// email link → confirm page → account → add a passkey → sign out → sign in with the passkey.
// Fails on any CSP violation or page error.
//
//   pnpm --filter @rlr/web build && pnpm --filter @rlr/web preview --port 4321 &
//   pnpm --filter @rlr/web e2e
//
// Uses a Chrome DevTools virtual authenticator, so no real passkey is needed.

import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4321";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const problems = [];
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E check failed: ${message}`);
  console.log(`✓ ${message}`);
};

function latestSigninLink() {
  const logs = execSync("npx astro preview logs", { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  return (logs.match(/http:\/\/localhost:\d+\/signin\/confirm\S+/g) ?? []).at(-1);
}

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("astro-island")].every((i) => !i.hasAttribute("ssr")),
    );
  const path = () => new URL(page.url()).pathname;

  const email = `e2e-${Date.now()}@example.com`;
  await page.goto(`${BASE}/signin`);
  await page.fill("#email", email);
  await page.click('button:has-text("Email me a sign-in link")');
  await page.waitForURL(/sent=1/);
  check(
    await page.isVisible("text=Check your email"),
    "link request shows the same answer for every address",
  );

  await new Promise((r) => setTimeout(r, 500));
  const link = latestSigninLink();
  check(Boolean(link), "a sign-in link was delivered (dev console)");
  await page.goto(link);
  check(
    (await page.textContent("h1"))?.includes("e***@example.com"),
    "confirm page names the masked address",
  );

  await page.click('button:has-text("Yes, sign me in")');
  await page.waitForURL((u) => u.pathname === "/account");
  check(await page.isVisible("text=New character created"), "new readers land on the welcome screen");

  await hydrated();
  await page.click('button:has-text("Add a passkey")');
  await page.waitForSelector("li:has-text('added')");
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  check(credentials.length === 1, "a passkey was registered");

  await page.click('button:has-text("Sign out")');
  await page.waitForURL((u) => u.pathname === "/");
  const me = await (await page.request.get(`${BASE}/api/me`)).json();
  check(me.signedIn === false, "signing out ends the session");

  await page.goto(`${BASE}/signin?next=/account`);
  await hydrated();
  await page.click('button:has-text("Sign in with a passkey")');
  await page.waitForURL((u) => u.pathname === "/account");
  check(path() === "/account" && (await page.isVisible(`text=${email}`)), "passkey sign-in works");

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
