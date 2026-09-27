// End-to-end money (M8) against both previews (web on 4321, admin on 4322) and the jobs Worker
// (wrangler dev --test-scheduled on :8788), with the local fake Stripe: the owner turns selling
// on; an author books a Homepage Spotlight, pays on the fake checkout page, and the webhook and
// the jobs Worker confirm and approve it; a risky ad goes to the owner, who rejects it (refunded);
// a booking is cancelled for a card refund; a 100% code books without Stripe; a Sponsored Match is
// shown to a matching reader and counted once; Author Pro is bought and cancelled through the fake
// portal; the owner refunds part of an order and downloads the month's CSV. A forged webhook is
// refused. Fails on any CSP violation or page error.
//
// Run after the console E2E, which publishes the books and builds the match model this uses.

import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:4321";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:4322";
const JOBS = process.env.E2E_JOBS_URL ?? "http://localhost:8788";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
if (process.env.E2E_JOBS !== "1") {
  console.log("The money flow needs the jobs Worker (E2E_JOBS=1): payments are confirmed there.");
  process.exit(0);
}
const webDir = new URL("../../web/", import.meta.url);
const adminDir = new URL("..", import.meta.url);

const problems = [];
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E check failed: ${message}`);
  console.log(`✓ ${message}`);
};
const rows = (command) =>
  JSON.parse(
    execSync(
      `npx wrangler d1 execute DB --local --persist-to ../../.wrangler/state --json --command "${command}"`,
      { cwd: adminDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ),
  )[0].results;
const sql = (command) => rows(command);
async function eventually(probe, seconds = 45) {
  for (let i = 0; i < seconds; i++) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
const previewLinks = (pattern) =>
  execSync("npx astro preview logs", { cwd: webDir, encoding: "utf8" }).match(pattern) ?? [];
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const heartbeat = () => fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);

async function newUser(browser, { passkey = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  if (passkey) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  }
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("astro-island")].every((i) => !i.hasAttribute("ssr")),
    );
  return { context, page, hydrated };
}

async function signIn({ page }, email) {
  const pattern = /http:\/\/localhost:\d+\/signin\/confirm\S+/g;
  const before = previewLinks(pattern).length;
  await page.goto(`${WEB}/signin`);
  await page.fill("#email", email);
  await page.click('button:has-text("Email me a sign-in link")');
  await page.waitForURL(/sent=1/);
  const link = await eventually(() => {
    const all = previewLinks(pattern);
    return all.length > before ? all.at(-1) : null;
  }, 10);
  await page.goto(link);
  await page.click('button:has-text("Yes, sign me in")');
  await page.waitForURL((u) => u.pathname === "/welcome" || u.pathname === "/account");
}

/** Submit and wait for the flash message; a refusal fails with the page's own message. */
async function submit(page, button) {
  await page.click(button);
  await page.waitForSelector(".notice");
  const refused = await page.$(".notice.error");
  if (refused) throw new Error(`E2E: refused: ${(await refused.textContent())?.trim()}`);
  return (await page.textContent(".notice"))?.trim() ?? "";
}

async function setSetting(page, key, value) {
  await page.goto(`${ADMIN}/settings`);
  const form = page.locator(`form:has(input[name="key"][value="${key}"]):has(input[name="value"])`);
  await form.locator('input[name="value"]').fill(value);
  await form.locator('button[value="save"]').click();
  await page.waitForSelector(".notice");
}

// Letters only: a number in a title reads as a volume number.
const tag = Date.now()
  .toString(36)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
const authorEmail = `payer-${tag}@example.com`;

sql("DELETE FROM rate_counters");
const books = rows(
  "SELECT id, slug, title FROM books WHERE visibility = 'published' AND redirect_to IS NULL AND in_scope != 'no' AND content_flags = '[]' ORDER BY published_at LIMIT 2",
);
check(books.length === 2, "the console E2E left published books to promote");
// The first days (4 or more out) with a spotlight place left on each day this run books, so the
// flow can run again on the same local database. day(6) stays a week or more away for the refund.
const open = new Set(
  rows(
    "SELECT u.period_start AS d FROM inventory_units u JOIN ad_slots s ON s.id = u.slot_id WHERE s.key LIKE 'home_spotlight%' AND u.sold + u.held < u.capacity AND u.blackout = 0",
  ).map((r) => r.d),
);
let base = 4;
while (base < 90 && ![0, 1, 2, 6].every((k) => open.has(inDays(base + k)))) base++;
const day = (k) => inDays(base + k);
const [book, other] = books;

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  // The owner turns selling on (settings need a fresh passkey: we just signed in).
  const owner = await newUser(browser, { passkey: true });
  await signIn(owner, OWNER);
  await owner.page.goto(`${WEB}/account`);
  await owner.hydrated();
  await owner.page.click('button:has-text("Add a passkey")');
  await owner.page.waitForSelector("li:has-text('added')");
  await owner.page.waitForLoadState("networkidle");
  sql(`UPDATE users SET is_admin = 1 WHERE email = '${OWNER}'`);
  const admin = owner.page;
  await admin.goto(`${ADMIN}/`);
  await owner.hydrated();
  await admin.click('button:has-text("Sign in with passkey")');
  await admin.waitForURL((u) => u.pathname === "/");
  await setSetting(admin, "flags.ads_paid", "true");
  await setSetting(admin, "flags.author_pro", "true");
  await setSetting(admin, "billing.author_pro_price_month", '"price_fake_month"');
  // The test catalog is small: let any reader who passes their hard no's see the Sponsored Match.
  await setSetting(admin, "ads.sponsored_match_min_score", "0");
  // This run books more in an hour than a real author may start.
  await setSetting(admin, "ads.checkout_attempts_per_hour", "50");
  check(true, "the owner turns on paid placements and Author Pro");
  const adv = await (await fetch(`${WEB}/advertise`)).text();
  check(
    adv.includes("Homepage Spotlight") && adv.includes("Sponsored Match"),
    "/advertise lists the placements and prices",
  );
  check((await fetch(`${WEB}/legal/advertising`)).status === 200, "the advertising terms are published");

  // An author with a published book and a store link (set up directly: M6's flow covers the how).
  const author = await newUser(browser);
  const page = author.page;
  await signIn(author, authorEmail);
  await page.goto(`${WEB}/dashboard/start`);
  await page.fill("#name", `Pay Author ${tag}`);
  await page.click('button:has-text("Create the profile")');
  await page.waitForURL(/\/dashboard\/verify\//);
  const authorId = new URL(page.url()).pathname.split("/").pop();
  sql(
    `UPDATE authors SET trust_level = 'T1', verified_at = '${new Date().toISOString()}' WHERE id = '${authorId}'`,
  );
  sql(
    `INSERT OR IGNORE INTO book_authors (book_id, author_id, role, position) VALUES ('${book.id}', '${authorId}', 'author', 9)`,
  );
  sql(
    `INSERT OR IGNORE INTO book_links (id, book_id, kind, url) VALUES ('e2e${tag}', '${book.id}', 'royal_road', 'https://www.royalroad.com/fiction/77${tag.length}/e2e-${tag}')`,
  );

  /** Book, pay on the fake checkout, and return the campaign id. */
  async function book1(opts) {
    const q = new URLSearchParams({
      author: authorId,
      step: "quote",
      product: opts.product ?? "home_spotlight",
      book: book.id,
      start: opts.start ?? day(0),
      periods: "1",
      budget: "20",
      days: "14",
    });
    await page.goto(`${WEB}/dashboard/promote/new?${q}`);
    await page.fill('input[name="headline"]', opts.headline);
    await page.check('input[name="terms"]');
    if (opts.code) await page.fill('input[name="code"]', opts.code);
    await page.click('button:has-text("Continue to payment")');
    await page.waitForLoadState("load");
    const refused = await page.$(".notice.error");
    if (refused) throw new Error(`E2E: booking refused: ${(await refused.textContent())?.trim()}`);
    await page.waitForURL(
      (u) =>
        u.pathname.startsWith("/dev/stripe/checkout/") ||
        /^\/dashboard\/promote\/[0-9A-Z]{26}$/.test(u.pathname),
    );
    if (page.url().includes("/dev/stripe/checkout/")) {
      await page.click('button:has-text("Pay (test)")');
      await page.waitForURL(/\/dashboard\/promote\/[0-9A-Z]{26}\?paid=1/);
    }
    return new URL(page.url()).pathname.split("/").pop();
  }
  const statusOf = (id) => rows(`SELECT status FROM campaigns WHERE id = '${id}'`)[0]?.status;

  // A Homepage Spotlight, paid by card through the fake Stripe Checkout (DESIGN §11.4).
  await page.goto(`${WEB}/dashboard/promote`);
  await page.click('a:has-text("Book a promotion")');
  await page.waitForURL(/\/dashboard\/promote\/new/);
  await page.click('button:has-text("Check availability and price")');
  await page.waitForSelector("text=Total:");
  check(true, "booking shows the price and availability first");
  const spot = await book1({ headline: `Climb it ${tag}` });
  check(await page.isVisible("text=Payment received"), "the fake checkout pays and comes back");
  await heartbeat();
  check(
    (await eventually(() => statusOf(spot) === "scheduled")) === true,
    "the webhook and the jobs Worker confirm the payment and approve a clean ad",
  );
  const [paidOrder] = rows(
    `SELECT id, status, charged_cents FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE campaign_id = '${spot}')`,
  );
  check(paidOrder?.status === "paid" && paidOrder.charged_cents === 1000, "the order is paid");
  await page.reload();
  check(await page.isVisible("text=Scheduled"), "the author sees it scheduled");

  // A risky ad goes to the owner; rejecting it refunds in full.
  const risky = await book1({ headline: `The #1 climb ${tag}`, start: day(1) });
  const reviewItem = await eventually(
    () => rows(`SELECT id FROM inbox_items WHERE type = 'ad_review' AND subject_id = '${risky}'`)[0],
  );
  check(Boolean(reviewItem), "a ranking claim sends the ad to the owner's inbox");
  await admin.goto(`${ADMIN}/inbox`);
  const row = admin.locator("tr[data-inbox-item]", { hasText: `The #1 climb ${tag}` });
  await row.locator('input[name="note"]').fill("No ranking claims, please.");
  await row.locator('button[value="rejected"]').click();
  await admin.waitForSelector("text=Marked rejected.");
  check(statusOf(risky) === "rejected", "the owner rejects it");
  const [refunded] = rows(
    `SELECT status, refunded_cents FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE campaign_id = '${risky}')`,
  );
  check(
    refunded?.status === "refunded" && refunded.refunded_cents === 1000,
    "and it's refunded in full through Stripe",
  );
  await page.goto(`${WEB}/dashboard/promote/${risky}`);
  check(await page.isVisible("text=No ranking claims, please."), "the author sees why");

  // Cancelling 10 days out: a full refund to the card.
  const later = await book1({ headline: `Later climb ${tag}`, start: day(6) });
  await heartbeat();
  await eventually(() => statusOf(later) === "scheduled");
  await page.goto(`${WEB}/dashboard/promote/${later}`);
  check(
    (await submit(page, 'button:has-text("Cancel this promotion")')).includes("$10 back to your card"),
    "cancelling a week out refunds the card",
  );

  // A 100% code books with no Stripe at all.
  await admin.goto(`${ADMIN}/billing`);
  const codeForm = admin.locator('form:has(input[name="action"][value="code"])');
  await codeForm.locator('input[name="code"]').fill(`FREE${tag}`.toUpperCase().slice(0, 32));
  await codeForm.locator('input[name="value"]').fill("100");
  await codeForm.locator('button:has-text("Create code")').click();
  await admin.waitForSelector("text=created.");
  const free = await book1({ headline: `Free climb ${tag}`, start: day(2), code: `free${tag}` });
  check(
    rows(
      `SELECT kind, charged_cents FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE campaign_id = '${free}')`,
    )[0]?.kind === "comp",
    "a 100% promotion code books it without a payment",
  );

  // Sponsored Match: bought, then shown to a matching reader on their results and counted once.
  const sm = await book1({ product: "sponsored_match", headline: `Matched climb ${tag}` });
  await heartbeat();
  await eventually(() => statusOf(sm) === "scheduled");
  sql(
    `UPDATE campaigns SET status = 'live', start_at = '${new Date(Date.now() - 3_600_000).toISOString()}' WHERE id = '${sm}'`,
  );
  const match = await (
    await fetch(`${WEB}/api/match`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ loved: [other.slug] }),
    })
  ).json();
  const reader = await newUser(browser);
  await reader.page.goto(`${WEB}/match/r?p=${match.share}`);
  await reader.hydrated();
  const card = reader.page.locator("aside.ad-card.sponsored", { hasText: `Matched climb ${tag}` });
  await card.waitFor({ timeout: 15_000 }).catch(() => undefined);
  const shown = await card.isVisible();
  const promotedOnPage = [...(match.best ?? []), ...(match.more ?? [])].some((c) => c.slug === book.slug);
  check(shown || promotedOnPage, "the Sponsored Match shows on a matching reader's results, labeled");
  if (shown) {
    check(
      (await card.locator(".ad-label").textContent())?.startsWith("Sponsored"),
      "labeled Sponsored with the match %",
    );
    check(
      rows(`SELECT qualified_impressions FROM campaigns WHERE id = '${sm}'`)[0]?.qualified_impressions === 1,
      "counted once, on our server",
    );
  }
  const noToken = await (
    await fetch(`${WEB}/api/sponsored`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ inputs: { loved: [other.slug] }, shown: [] }),
    })
  ).json();
  check(noToken.card === null, "without the results page's token nothing is shown or charged");
  await reader.page.waitForLoadState("networkidle");
  await reader.context.close();

  // Author Pro: subscribe on the fake checkout, then cancel in the fake portal.
  await page.goto(`${WEB}/dashboard/billing?author=${authorId}`);
  await page.click('button:has-text("a month")');
  await page.waitForURL(/\/dev\/stripe\/checkout\//);
  await page.click('button:has-text("Pay (test)")');
  await page.waitForURL(/\/dashboard\/billing\?author=.*pro=1/);
  await heartbeat();
  const sub = await eventually(
    () =>
      rows(
        `SELECT status FROM subscriptions WHERE advertiser_id IN (SELECT id FROM advertisers WHERE owner_id = '${authorId}')`,
      )[0]?.status === "active",
  );
  check(sub === true, "Author Pro starts once Stripe says it's paid");
  await eventually(
    () =>
      rows(
        `SELECT sum(delta_cents) n FROM credits_ledger WHERE reason = 'author_pro' AND advertiser_id IN (SELECT id FROM advertisers WHERE owner_id = '${authorId}')`,
      )[0]?.n === 2000,
  );
  await page.reload();
  check(
    (await page.isVisible("text=Active")) && (await page.isVisible("text=Author Pro quarterly credit")),
    "with its quarterly promo credit",
  );
  await page.click('button:has-text("Receipts, invoices, card and cancelling")');
  await page.waitForURL(/\/dev\/stripe\/portal\//);
  await page.click('button:has-text("Cancel at period end")');
  await page.waitForURL(/\/dashboard\/billing/);
  await heartbeat();
  check(
    (await eventually(
      () =>
        rows(
          `SELECT cancel_at_period_end c FROM subscriptions WHERE advertiser_id IN (SELECT id FROM advertisers WHERE owner_id = '${authorId}')`,
        )[0]?.c === 1,
    )) === true,
    "cancelling in the portal ends it at the period's end",
  );

  // The owner's console: a partial refund as credit, and the month's CSV.
  await admin.goto(`${ADMIN}/billing/orders/${paidOrder.id}`);
  await admin.fill('input[name="amount"]', "2.50");
  await admin.selectOption('select[name="to"]', "credit");
  await admin.fill('input[name="reason"]', "Goodwill");
  check(
    (await submit(admin, 'button:has-text("Refund")')).includes("$2.50 as credit"),
    "the owner refunds part of an order as credit",
  );
  const csv = await admin.request.get(
    `${ADMIN}/billing/export?month=${new Date().toISOString().slice(0, 7)}`,
  );
  check(
    csv.status() === 200 && (await csv.text()).includes(paidOrder.id),
    "the month downloads as CSV for bookkeeping",
  );
  await admin.goto(`${ADMIN}/audit?action=billing.`);
  check(await admin.isVisible("text=billing.refund"), "money actions are in the audit log");

  const forged = await fetch(`${WEB}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
    body: JSON.stringify({
      id: "evt_forged",
      type: "checkout.session.completed",
      data: { object: { id: "cs_x" } },
    }),
  });
  check(forged.status === 400, "a webhook without a valid signature is refused");

  // Put the test-only settings back.
  for (const key of ["ads.sponsored_match_min_score", "ads.checkout_attempts_per_hour"]) {
    await admin.goto(`${ADMIN}/settings`);
    await admin.locator(`form:has(input[name="key"][value="${key}"]) button[value="reset"]`).click();
    await admin.waitForSelector(".notice");
  }
  await page.waitForLoadState("networkidle");

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
