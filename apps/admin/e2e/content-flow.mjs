// End-to-end owner console for M7 against both previews (web on 4321, admin on 4322): the owner
// writes a post with a book shortcode and publishes it, then undoes the publish from the audit log.
// "Today in LitRPG" is built by the jobs Worker and shows on /news. In the Owner Inbox: countdowns,
// snooze and wake, the keyboard shortcuts, undoing an approval, and "Approve all low-risk". Last, a
// house ad on the homepage: its /go/ link redirects to the destination read from the database, and
// pausing it (and undoing the pause) takes it off the page and back. Fails on any CSP violation or
// page error.
//
// Run after the console E2E, which publishes the books this uses. With E2E_JOBS=1 the jobs Worker
// (wrangler dev --test-scheduled on :8788) builds the daily news post.

import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:4321";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:4322";
const JOBS = process.env.E2E_JOBS_URL ?? "http://localhost:8788";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const withJobs = process.env.E2E_JOBS === "1";
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
const ulid = () =>
  `01E2E${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    .replace(/[^0-9A-Z]/g, "0")
    .slice(0, 26)
    .padEnd(26, "0");

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

/** Undo the newest undoable audit row for `action` that mentions `text`. */
async function undo(page, action, text) {
  await page.goto(`${ADMIN}/audit?action=${encodeURIComponent(action)}&undoable=1`);
  const row = page.locator("tr", { hasText: text }).first();
  await row.locator('button:has-text("Undo")').click();
  await page.waitForSelector(".notice");
  const message = (await page.textContent(".notice"))?.trim() ?? "";
  if (!message.startsWith("Undone")) throw new Error(`E2E: undo failed: ${message}`);
  return message;
}

// Letters only: a number in a title reads as a volume number.
const tag = Date.now()
  .toString(36)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
const today = new Date().toISOString().slice(0, 10);
const postTitle = `Why Towers Work ${tag}`;
const reviewTitle = `A Guide to Floors ${tag}`;
const adHeadline = `Climb it ${tag}`.slice(0, 60);

sql("DELETE FROM rate_counters");
const [book] = rows(
  "SELECT id, slug, title FROM books WHERE visibility = 'published' AND redirect_to IS NULL AND in_scope != 'no' AND content_flags = '[]' ORDER BY published_at LIMIT 1",
);
// The house ad's book must not already be in today's spotlight: the homepage never shows a book
// twice, and money runs on earlier days book spotlight dates that eventually arrive.
const [adBook] = rows(
  "SELECT id, slug FROM books WHERE visibility = 'published' AND redirect_to IS NULL AND in_scope != 'no' AND content_flags = '[]' AND id NOT IN (SELECT c.book_id FROM bookings b JOIN inventory_units u ON u.id = b.inventory_unit_id JOIN ad_slots s ON s.id = u.slot_id JOIN campaigns c ON c.id = b.campaign_id WHERE s.key LIKE 'home_spotlight%' AND b.status = 'confirmed' AND c.book_id IS NOT NULL AND u.period_start <= date('now') AND u.period_end >= date('now')) ORDER BY published_at LIMIT 1",
);
check(Boolean(book), "the console E2E left a published book to write about");

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  // Each run adds a passkey for the owner. Clear the earlier runs' first: past 64, the browser refuses
  // to register another (excludeCredentials), and the old ones would satisfy "added" on their own.
  sql(`DELETE FROM passkeys WHERE user_id IN (SELECT id FROM users WHERE email = '${OWNER}')`);
  const owner = await newUser(browser, { passkey: true });
  await signIn(owner, OWNER);
  await owner.page.goto(`${WEB}/account`);
  await owner.hydrated();
  await owner.page.click('button:has-text("Add a passkey")');
  await owner.page.waitForSelector("li:has-text('added')");
  await owner.page.waitForLoadState("networkidle");
  sql(`UPDATE users SET is_admin = 1 WHERE email = '${OWNER}'`);
  const page = owner.page;
  await page.goto(`${ADMIN}/`);
  await owner.hydrated();
  await page.click('button:has-text("Sign in with passkey")');
  await page.waitForURL((u) => u.pathname === "/");
  const visitor = await newUser(browser);

  // A post by the owner, with a book card from a shortcode (DESIGN §14.3).
  await page.goto(`${ADMIN}/blog`);
  await page.fill('input[name="title"]', postTitle);
  await page.selectOption('select[name="type"]', "owner");
  await page.click('button:has-text("Start writing")');
  await page.waitForURL(/\/blog\/[0-9A-Z]{26}/);
  const postId = new URL(page.url()).pathname.split("/").pop();
  await page.fill('input[name="dek"]', "What makes a tower climb satisfying.");
  await page.fill(
    'textarea[name="body"]',
    `Every floor is a promise.\n\n[[book:${book.slug}]]\n\nSee [[book:${book.slug}]] for the best example.`,
  );
  await submit(page, 'button[value="publish"]');
  const [post] = rows(`SELECT slug, status FROM posts WHERE id = '${postId}'`);
  check(post?.status === "published", "the owner writes and publishes a post");
  const postUrl = `${WEB}/blog/${post.slug}`;
  await visitor.page.goto(postUrl);
  check(await visitor.page.isVisible(`h1:has-text("${postTitle}")`), "the post is on the site");
  check(
    (await visitor.page.locator(`a[href="/books/${book.slug}"]`).count()) >= 2,
    "the shortcode renders as a book card and an inline link",
  );
  check((await (await fetch(`${WEB}/blog`)).text()).includes(postTitle), "the blog index lists it");
  check((await (await fetch(`${WEB}/feeds/blog.xml`)).text()).includes(postTitle), "and so does the feed");

  // Undo from the audit log (DESIGN §8.3).
  await undo(page, "post.publish", postId);
  check(
    rows(`SELECT status FROM posts WHERE id = '${postId}'`)[0]?.status === "unpublished" &&
      (await fetch(postUrl)).status === 404,
    "undoing the publish from the audit log takes the post down",
  );
  await page.goto(`${ADMIN}/audit?action=post.publish`);
  check(
    await page.locator("tr", { hasText: postId }).first().locator("text=Undone").isVisible(),
    "the audit row shows it was undone, and can't be undone twice",
  );

  // Today in LitRPG, built by the jobs Worker every morning (DESIGN §14.6).
  if (withJobs) {
    await fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);
    sql("UPDATE schedules SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE key = 'news.daily_roundup'");
    await fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);
    const daily = await eventually(
      () => rows(`SELECT slug FROM posts WHERE gen_key = 'daily:${today}' AND status = 'published'`)[0],
    );
    check(Boolean(daily), "the jobs Worker publishes today's Today in LitRPG");
    const todayPage = await fetch(`${WEB}/news/today`, { redirect: "follow" });
    check(todayPage.status === 200, "/news/today shows it");
    check(
      (await (await fetch(`${WEB}/feeds/news.xml`)).text()).includes("Today in LitRPG"),
      "the news feed has it",
    );
  }
  check((await fetch(`${WEB}/news`)).status === 200, "the news page is up");

  // The Owner Inbox (DESIGN §8.1).
  await page.goto(`${ADMIN}/blog`);
  await page.fill('input[name="title"]', reviewTitle);
  await page.click('button:has-text("Start writing")');
  await page.waitForURL(/\/blog\/[0-9A-Z]{26}/);
  const reviewId = new URL(page.url()).pathname.split("/").pop();
  await page.fill('textarea[name="body"]', "Floors, in order.");
  await submit(page, 'button[value="save"]');
  sql(`UPDATE posts SET status = 'in_review' WHERE id = '${reviewId}'`);
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const reviewItem = ulid();
  const reportItem = ulid();
  sql(
    `INSERT INTO inbox_items (id, type, subject_type, subject_id, title, priority, payload, default_action, default_action_at, ai_recommendation) VALUES ('${reviewItem}', 'post_review', 'post', '${reviewId}', 'Review: ${reviewTitle}', 60, '{\\"postId\\":\\"${reviewId}\\"}', 'approve', '${inTwoDays}', 'approve'), ('${reportItem}', 'author_report', 'book', '${book.id}', 'Report ${tag}', 60, NULL, 'none', NULL, NULL)`,
  );
  await page.goto(`${ADMIN}/inbox`);
  const reviewRow = page.locator("tr[data-inbox-item]", { hasText: reviewTitle });
  check(
    /Auto-approves in 1 d 2[23] h/.test((await reviewRow.locator(".countdown").textContent()) ?? ""),
    "each card counts down to its default action",
  );
  check(
    (await page.textContent("details.bulk ul"))?.includes(reviewTitle),
    '"Approve all low-risk" lists what it would approve before you confirm',
  );

  const reportRow = page.locator("tr[data-inbox-item]", { hasText: `Report ${tag}` });
  await reportRow.locator('button:has-text("Snooze")').click();
  await page.waitForSelector("text=Snoozed for tomorrow.");
  check(!(await page.isVisible(`text=Report ${tag}`)), "a snoozed item leaves the inbox");
  await page.goto(`${ADMIN}/inbox?snoozed=1`);
  await page
    .locator("tr", { hasText: `Report ${tag}` })
    .locator('button:has-text("Wake now")')
    .click();
  await page.waitForSelector("text=Back in the inbox.");
  check(await page.isVisible(`text=Report ${tag}`), "and comes back when woken");

  // Keyboard: j/k move between cards, a approves the focused one.
  await page.goto(`${ADMIN}/inbox`);
  await owner.hydrated();
  await page.waitForSelector("text=Keys: j / k move");
  await page.locator("tr[data-inbox-item]").first().focus();
  const before = await page.evaluate(() => document.activeElement?.textContent ?? "");
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  check(
    (await page.evaluate(() => document.activeElement?.textContent ?? "")) === before,
    "j and k move between cards",
  );
  await page.locator("tr[data-inbox-item]", { hasText: `Report ${tag}` }).focus();
  await page.keyboard.press("a");
  await page.waitForSelector("text=Marked resolved.");
  await page.locator("tr[data-inbox-item]", { hasText: reviewTitle }).focus();
  await page.keyboard.press("a");
  await page.waitForSelector("text=Marked approved.");
  check(
    rows(`SELECT status FROM posts WHERE id = '${reviewId}'`)[0]?.status === "published",
    "a approves the focused card, and approving the review publishes the post",
  );
  await undo(page, "inbox.decide", reviewItem);
  check(
    rows(`SELECT status FROM posts WHERE id = '${reviewId}'`)[0]?.status === "in_review",
    "undoing the approval puts the post back in review",
  );

  const bulkItem = ulid();
  sql(
    `INSERT INTO inbox_items (id, type, subject_type, subject_id, title, priority, payload, default_action, default_action_at, ai_recommendation) VALUES ('${bulkItem}', 'post_review', 'post', '${reviewId}', 'Again: ${reviewTitle}', 60, '{\\"postId\\":\\"${reviewId}\\"}', 'approve', '${inTwoDays}', 'approve')`,
  );
  await page.goto(`${ADMIN}/inbox`);
  await page.click('summary:has-text("Approve all low-risk")');
  await page.click('button:has-text("Approve these")');
  await page.waitForSelector("text=low-risk item");
  check(
    rows(`SELECT status FROM inbox_items WHERE id = '${bulkItem}'`)[0]?.status === "approved" &&
      rows(`SELECT status FROM posts WHERE id = '${reviewId}'`)[0]?.status === "published",
    '"Approve all low-risk" approves the list it showed',
  );
  await page.goto(`${ADMIN}/blog/${reviewId}`);
  await submit(page, 'button[value="unpublish"]');

  // A house ad on the homepage (DESIGN §11.9).
  await page.goto(`${ADMIN}/ads`);
  await page.fill('input[name="name"]', `E2E ${tag}`);
  await page.selectOption('select[name="product"]', "home_spotlight");
  await page.selectOption('select[name="mode"]', "backfill");
  await page.fill('input[name="book"]', adBook.slug);
  await page.fill('input[name="headline"]', adHeadline);
  await page.fill('input[name="body"]', "A house campaign from the E2E run.");
  await page.fill('input[name="url"]', `https://example.com/e2e-${tag}`);
  await page.fill('input[name="weight"]', "100");
  check(
    (await submit(page, 'button:has-text("Create")')).includes("Backfill campaign created"),
    "the owner creates a house campaign",
  );
  await visitor.page.goto(`${WEB}/`);
  const ad = visitor.page.locator(`aside[data-ad]:has-text("${adHeadline}")`);
  check(await ad.isVisible(), "the homepage shows it in a spotlight slot");
  check((await ad.locator(".ad-label").textContent())?.trim() === "From ReadLitRPG", "labeled as a house ad");
  const href = await ad.locator("a").first().getAttribute("href");
  check(/^\/go\/[\w.-]+$/.test(href ?? ""), "its link is a signed /go/ token");
  const go = await fetch(`${WEB}${href}`, { redirect: "manual" });
  check(
    go.status === 302 && go.headers.get("location") === `https://example.com/e2e-${tag}`,
    "/go/ redirects to the destination stored for the campaign",
  );
  check(
    (await fetch(`${WEB}/go/not-a-token`, { redirect: "manual" })).status === 404,
    "a forged /go/ is refused",
  );
  // The viewable-impression beacon fires after a second in view.
  await visitor.page.waitForTimeout(1500);

  await page.goto(`${ADMIN}/ads`);
  const campaignRow = () => page.locator("tr", { hasText: `E2E ${tag}` });
  await campaignRow().locator('button:has-text("Pause")').click();
  await page.waitForSelector("text=Campaign paused.");
  await visitor.page.goto(`${WEB}/`);
  check(!(await visitor.page.isVisible(`text=${adHeadline}`)), "a paused campaign leaves the page");
  const [campaign] = rows(`SELECT id FROM campaigns WHERE name = 'E2E ${tag}'`);
  await undo(page, "ads.campaign_state", campaign.id);
  await visitor.page.goto(`${WEB}/`);
  check(await visitor.page.isVisible(`text=${adHeadline}`), "undoing the pause brings it back");
  await page.goto(`${ADMIN}/ads`);
  await campaignRow().locator('button:has-text("End")').click();
  await page.waitForSelector("text=Campaign completed.");
  await visitor.page.waitForLoadState("networkidle");
  await visitor.context.close();

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
