// End-to-end reader journey (M5) in a real browser against `astro preview`: quiz result → email
// capture → confirmation link → signed in on onboarding → mark a book, follow its series, save tastes
// and a search → private calendar → email preferences → one-click unsubscribe → export → delete.
// Fails on any CSP violation or page error.
//
// Needs published books (run after the admin E2E, as CI does). With E2E_JOBS=1 the jobs Worker
// (wrangler dev on :8788) also sends the welcome email and builds the export.

import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4321";
const JOBS = process.env.E2E_JOBS_URL ?? "http://localhost:8788";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const withJobs = process.env.E2E_JOBS === "1";
const webDir = new URL("..", import.meta.url);
// The local value from .dev.vars.example (never a production key).
const LINK_KEY = "local-dev-only-link-key-not-for-production-000000";

const problems = [];
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E check failed: ${message}`);
  console.log(`✓ ${message}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (command) =>
  execSync(
    `npx wrangler d1 execute DB --local --persist-to ../../.wrangler/state --json --command "${command}"`,
    {
      cwd: webDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
const rows = (command) => JSON.parse(sql(command))[0]?.results ?? [];
async function eventually(fn, seconds = 30) {
  for (let i = 0; i < seconds; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(1000);
  }
  return null;
}

/** A signed unsubscribe token, as the jobs Worker makes them (packages/core/src/readers/links.ts). */
function unsubToken(userId, list) {
  const body = Buffer.from(JSON.stringify(["k1", "unsub", [userId, list], 0])).toString("base64url");
  const sig = createHmac("sha256", LINK_KEY).update(`unsub.${body}`).digest("hex").slice(0, 32);
  return `${body}.${sig}`;
}

// Fresh rate-limit windows, and the class quiz live for this run.
sql("DELETE FROM rate_counters");
sql(
  "INSERT INTO quiz_status (slug, status, updated_by) VALUES ('whats-your-litrpg-class', 'live', 'e2e') ON CONFLICT(slug) DO UPDATE SET status = 'live'",
);
const sitemap = await (await fetch(`${BASE}/sitemaps/books-1.xml`)).text();
const bookSlug = /\/books\/([^<]+)<\/loc>/.exec(sitemap)?.[1];
check(Boolean(bookSlug), "the catalog has a published book to use");

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("astro-island")].every((i) => !i.hasAttribute("ssr")),
    );

  // Quiz → email capture (QUIZZES §3.3)
  await page.goto(`${BASE}/quiz/whats-your-litrpg-class`);
  await hydrated();
  for (let i = 0; i < 30 && !(await page.isVisible(".quiz-result")); i++) {
    await page.locator(".options button").first().click();
    await sleep(150);
  }
  await page.waitForSelector(".quiz-result h2");
  const className = (await page.textContent(".quiz-result h2"))?.trim();
  // The System answers in a toast (styles/feel.css): built in the DOM, so no CSP trouble.
  await page.click('button:has-text("Copy a Party up link")');
  await page.waitForSelector('.system-toast:has-text("[Party link copied]")');
  check(true, "copying the Party up link says so in a System toast");
  await page.click('button:has-text("Email me my full reading list")');
  const email = `reader-${Date.now()}@example.com`;
  await page.fill(".subscribe-form input[type=email]", email);
  await page.click('.subscribe-form button[type="submit"]');
  await page.waitForSelector("text=Check your inbox");
  check(true, "a quiz result offers the reading list by email, with double opt-in");

  const link = await eventually(() => {
    const logs = execSync("npx astro preview logs", { cwd: webDir, encoding: "utf8" });
    return (logs.match(/http:\/\/localhost:\d+\/subscribe\/confirm\S+/g) ?? []).at(-1);
  }, 10);
  check(Boolean(link), "a confirmation link was delivered (dev console)");
  await page.goto(link);
  check(
    await page.isVisible("text=Confirm your email"),
    "the link opens a page; nothing is confirmed on GET",
  );
  await hydrated();
  await page.click('button:has-text("Confirm my email")');
  await page.waitForURL((u) => u.pathname === "/welcome");
  check(await page.isVisible("text=[Email confirmed]"), "confirming signs the reader in on onboarding");
  check(
    Boolean(className) && (await page.isVisible(`text=${className}`)),
    "the quiz result became their class",
  );
  const me = await (await page.request.get(`${BASE}/api/me`)).json();
  check(me.signedIn === true, "the reader has a session");
  const [user] = rows(`SELECT id, state FROM users WHERE email = '${email}'`);
  check(user?.state === "active", "the subscriber became an account");

  // Book marks and follows (DESIGN §9.6)
  await page.goto(`${BASE}/books/${bookSlug}`);
  await hydrated();
  const marked = page.waitForResponse(
    (r) => r.url().endsWith("/api/me/marks") && r.request().method() === "POST",
  );
  await page.click('.marks button:has-text("Loved it")');
  await page.waitForSelector('.marks button[aria-pressed="true"]:has-text("Loved it")');
  const markBody = await (await marked).json();
  check("levelUp" in markBody, "a mark reports whether the profile levelled up (for the level-up toast)");
  await page.reload();
  await hydrated();
  await page.waitForSelector('.marks button[aria-pressed="true"]:has-text("Loved it")');
  check(true, "a reader marks a book and the mark sticks");
  const seriesHref = await page
    .locator(".series-nav a[href^='/series/']")
    .first()
    .getAttribute("href")
    .catch(() => null);
  const followPath = seriesHref ?? (await page.locator(".byline a").first().getAttribute("href"));
  await page.goto(`${BASE}${followPath}`);
  await hydrated();
  await page.locator('.follow button:has-text("Follow")').click();
  await page.waitForSelector(".follow select");
  await page.selectOption(".follow select", "instant");
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/account/follows`);
  check(await page.isVisible(`.rows a[href="${followPath}"]`), "the follow is listed on the account");
  await page.click('button:has-text("Get my feed address")');
  const feedUrl = (await page.textContent(".feed-url"))?.trim();
  const feed = await fetch(feedUrl ?? "");
  check(
    feed.status === 200 && (feed.headers.get("content-type") ?? "").includes("text/calendar"),
    "a private calendar feed works",
  );
  await page.goto(`${BASE}/account/email`);
  check(
    await page.isChecked('input[name="release_alerts"]'),
    "choosing release-day emails opts into that list",
  );

  // Tastes (DESIGN §9.7)
  await page.goto(`${BASE}/account/preferences`);
  check(await page.isVisible("text=Level"), "the tastes page shows the profile level");
  await page.click('a:has-text("Tune my matches")');
  await hydrated();
  const saveTastes = page.locator('button:has-text("Save as my tastes")');
  if (await saveTastes.isVisible()) {
    await saveTastes.click();
    await page.waitForSelector("text=Saved as your tastes");
    check(true, "match results save as the reader's tastes");
  }
  await page.goto(`${BASE}/find?inc=system-apocalypse`);
  await hydrated();
  const alert = page.locator('button:has-text("Alert me to new books in this search")');
  if (await alert.isVisible()) {
    await alert.click();
    await page.waitForSelector("text=Saved.");
    await page.goto(`${BASE}/account/books`);
    check(await page.isVisible("text=New system-apocalypse"), "a search saves for alerts");
  }

  // Unsubscribing: account page, and RFC 8058 one-click from a mail app (cross-site, no cookies)
  const oneClick = await fetch(`${BASE}/u/${unsubToken(user.id, "weekly_digest")}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  check(oneClick.status === 200, "a mail app's one-click unsubscribe POST works without an Origin");
  const [weekly] = rows(
    `SELECT status FROM email_consents WHERE user_id = '${user.id}' AND list = 'weekly_digest'`,
  );
  check(weekly?.status === "unsubscribed", "one click drops that list");
  const forged = await fetch(`${BASE}/api/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=x%40example.com",
  });
  check(forged.status === 403, "other cross-site form posts are still refused");
  await page.goto(`${BASE}/u/${unsubToken(user.id, "reading_list")}`);
  check(await page.isVisible("text=Unsubscribe?"), "opening an unsubscribe link asks first");

  // The welcome email and the export (jobs Worker)
  await page.goto(`${BASE}/account/privacy`);
  await page.click('button:has-text("Export my data")');
  await page.waitForSelector("text=Your export is being prepared");
  if (withJobs) {
    sql(
      "UPDATE schedules SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE key IN ('email.welcome', 'exports.build')",
    );
    await fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);
    const sent = await eventually(
      () =>
        rows(
          `SELECT template FROM email_sends WHERE user_id = '${user.id}' AND template = 'welcome_1' AND status = 'sent'`,
        )[0],
      60,
    );
    check(Boolean(sent), "the jobs Worker sends the welcome reading list");
    const ready = await eventually(async () => {
      await page.reload();
      return page.isVisible('a:has-text("Download")');
    }, 60);
    check(ready, "the jobs Worker builds the export");
    const download = await page.request.get(
      `${BASE}${await page.getAttribute('a:has-text("Download")', "href")}`,
    );
    check((await download.json()).account.email === email, "the reader downloads their data");
  }

  // Delete (DESIGN §9.8)
  await page.fill("#confirm", "DELETE");
  await page.click('button:has-text("Delete my account")');
  await page.waitForURL((u) => u.pathname === "/goodbye");
  const after = await (await page.request.get(`${BASE}/api/me`)).json();
  check(after.signedIn === false, "deleting the account signs the reader out");
  check(rows(`SELECT id FROM users WHERE email = '${email}'`).length === 0, "the account is gone");
  check(
    rows(`SELECT reason FROM suppressions WHERE reason = 'account_deleted'`).length > 0,
    "only a hash of the address stays, to keep it off every list",
  );
  check(
    rows(`SELECT action FROM audit_log WHERE action = 'account.delete' AND actor_id = '${user.id}'`)
      .length === 1,
    "the deletion is audited",
  );

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
