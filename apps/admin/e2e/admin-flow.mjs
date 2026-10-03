// End-to-end owner console test against both previews (web on 4321, admin on 4322):
// the owner registers a passkey on the main site, is promoted to admin, signs in to the console
// with the same passkey, changes a setting (audited), queues a job, and verifies the audit chain.
// A reader's passkey must not open the console. Then the catalog (M1) and an editorial run driven
// through the real `pnpm editorial` CLI with the local token (M2). Then discovery (M3): the owner
// rebuilds the match model, a reader matches from a loved book, and a published quiz is played,
// shared and retired. Then the public site (M4): book, series, author and tag pages with structured
// data, a release date through to New & upcoming and the calendar feed, robots.txt and sitemaps,
// the page-view beacon, and (with the jobs Worker running) a cover upload and PNG share cards.
//
// Local runs stand in for Cloudflare Access with ACCESS_DEV_EMAIL (see .dev.vars.example).

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:4321";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:4322";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const webDir = new URL("../../web/", import.meta.url);
const adminDir = new URL("..", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

const problems = [];
const withJobs = process.env.E2E_JOBS === "1";

/** A real, decodable PNG of one color: the Images binding has to be able to re-encode it. */
function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Poll until `probe` returns truthy (jobs run on their own clock). */
async function eventually(probe, seconds = 45) {
  for (let i = 0; i < seconds; i++) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E check failed: ${message}`);
  console.log(`✓ ${message}`);
};
const sqlRows = (command) =>
  JSON.parse(
    execSync(
      `npx wrangler d1 execute DB --local --persist-to ../../.wrangler/state --json --command "${command}"`,
      {
        cwd: adminDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ),
  )[0].results;
const sql = (command) =>
  execSync(`npx wrangler d1 execute DB --local --persist-to ../../.wrangler/state --command "${command}"`, {
    cwd: adminDir,
    stdio: "pipe",
  });

async function newReader(browser, { expectForbidden = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // The reader's refused console sign-in is a 403 on purpose.
    if (expectForbidden && /status of 403/.test(m.text())) return;
    problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
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
  const hydrated = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll("astro-island")].every((i) => !i.hasAttribute("ssr")),
    );
  return { context, page, hydrated };
}

async function signUpWithPasskey({ page, hydrated }, email) {
  await page.goto(`${WEB}/signin`);
  await page.fill("#email", email);
  await page.click('button:has-text("Email me a sign-in link")');
  await page.waitForURL(/sent=1/);
  await new Promise((r) => setTimeout(r, 500));
  const logs = execSync("npx astro preview logs", { cwd: webDir, encoding: "utf8" });
  const link = (logs.match(/http:\/\/localhost:\d+\/signin\/confirm\S+/g) ?? []).at(-1);
  await page.goto(link);
  await page.click('button:has-text("Yes, sign me in")');
  // New readers land on onboarding (M5), returning ones on their account; passkeys are added there.
  await page.waitForURL((u) => u.pathname === "/welcome" || u.pathname === "/account");
  await page.goto(`${WEB}/account`);
  await hydrated();
  await page.click('button:has-text("Add a passkey")');
  await page.waitForSelector("li:has-text('added')");
  // Adding a passkey reloads the page; let that finish before navigating on.
  await page.waitForLoadState("networkidle");
}

// Test runs sign in many times from one IP; start each run with fresh rate-limit windows.
sql("DELETE FROM rate_counters");
// Each run adds a passkey for the owner. Clear the earlier runs' first: past 64, the browser refuses
// to register another (excludeCredentials), and the old ones would satisfy "added" on their own.
sql(`DELETE FROM passkeys WHERE user_id IN (SELECT id FROM users WHERE email = '${OWNER}')`);

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  // A reader who is not an admin can't get in, even past Access.
  const reader = await newReader(browser, { expectForbidden: true });
  await signUpWithPasskey(reader, `reader-${Date.now()}@example.com`);
  await reader.page.goto(`${ADMIN}/`);
  check(
    new URL(reader.page.url()).pathname === "/signin",
    "the console sends visitors without an admin session to sign-in",
  );
  await reader.hydrated();
  await reader.page.click('button:has-text("Sign in with passkey")');
  await reader.page.waitForSelector("text=Passkey sign-in failed");
  await reader.page.goto(`${ADMIN}/settings`);
  check(new URL(reader.page.url()).pathname === "/signin", "a reader's passkey does not open the console");

  // The owner.
  const owner = await newReader(browser);
  await signUpWithPasskey(owner, OWNER);
  sql(`UPDATE users SET is_admin = 1 WHERE email = '${OWNER}'`);
  await owner.page.goto(`${ADMIN}/`);
  await owner.hydrated();
  await owner.page.click('button:has-text("Sign in with passkey")');
  await owner.page.waitForURL((u) => u.pathname === "/");
  check(
    (await owner.page.textContent("h1")) === "Dashboard",
    "the owner signs in to the console with the same passkey",
  );

  await owner.page.goto(`${ADMIN}/settings`);
  const row = owner.page.locator("tr", { hasText: "editorial.stale_hours" });
  await row.locator('input[name="value"]').fill("48");
  await row.locator('button[value="save"]').click();
  await owner.page.waitForSelector("text=editorial.stale_hours saved");
  check(true, "a setting change saves");
  await owner.page
    .locator("tr", { hasText: "editorial.stale_hours" })
    .locator('button[value="reset"]')
    .click();
  await owner.page.waitForSelector("text=back to its default");

  const bad = owner.page.locator("tr", { hasText: "match.weights" });
  await bad.locator('input[name="value"]').fill('{"dial":1,"stat":1,"tag":0,"semantic":0,"quality":0}');
  await bad.locator('button[value="save"]').click();
  await owner.page.waitForSelector("text=sum to 1");
  check(true, "invalid settings are refused with a reason");

  await owner.page.goto(`${ADMIN}/automation`);
  await owner.page
    .locator("tr", { hasText: "audit.verify" })
    .locator('button[value="run_now"]')
    .first()
    .click();
  await owner.page.waitForSelector("text=will run on the next heartbeat");
  check(true, "run-now queues a job for the next heartbeat");

  await owner.page.goto(`${ADMIN}/audit?verify=1`);
  const audit = await owner.page.textContent("main");
  check(
    audit.includes("settings.update") &&
      audit.includes("settings.reset") &&
      audit.includes("schedule.run_now"),
    "admin actions are in the audit log",
  );
  check(audit.includes("Chain intact"), "the audit chain verifies");

  // Catalog (M1): vocabulary, quick-add, the publication gate, and a CSV import.
  const page = owner.page;
  await page.goto(`${ADMIN}/taxonomy`);
  await page.click('button:has-text("Sync now")');
  await page.waitForSelector("text=Synced:");
  check(await page.isVisible("text=Dungeon Core"), "the taxonomy syncs into the database");

  const stamp = Date.now();
  const title = `E2E Hunter ${stamp}`;
  await page.goto(`${ADMIN}/catalog/new`);
  await page.fill("#title", title);
  await page.fill("#authors", "Zogarth");
  await page.fill("#series", `E2E Series ${stamp}`);
  await page.fill("#position", "1");
  await page.selectOption("#genre", "litrpg");
  await page.fill("#tags", "system-apocalypse, xianxia");
  await page.fill("#links", `https://www.amazon.com/dp/B0E2E${String(stamp).slice(-5)}/ref=sr_1_1?tag=x-20`);
  await page.click('button:has-text("Save book")');
  await page.waitForSelector("text=Added.");
  check(
    await page.isVisible("text=Passes the publication gate"),
    "a book the owner adds passes the publication gate",
  );
  check(await page.isVisible("text=cultivation"), "tag synonyms resolve (xianxia → cultivation)");
  await page.click('button[value="publish"]');
  await page.waitForSelector("text=Book is now published");
  check(true, "the owner publishes it");
  const bookUrl = page.url().split("?")[0];

  await page.goto(`${ADMIN}/catalog/new`);
  await page.fill("#title", `${title}: A LitRPG Adventure (E2E Series ${stamp} Book 1)`);
  await page.fill("#authors", "Zogarth");
  await page.fill("#pages", "704");
  await page.click('button:has-text("Save book")');
  await page.waitForSelector("text=Matched an existing book");
  check(page.url().split("?")[0] === bookUrl, "adding it again with a retail title updates the same book");

  const csv = [
    "Title,Authors,Series,Book,Genre,Tags",
    `E2E Import A ${stamp},E2E Author,E2E Imports ${stamp},1,progression-fantasy,cultivation`,
    `E2E Import B ${stamp},E2E Author,E2E Imports ${stamp},2,progression-fantasy,cultivation`,
  ].join("\n");
  await page.goto(`${ADMIN}/catalog/import`);
  await page.selectOption("#kind", "csv");
  await page.setInputFiles("#file", { name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.click('button:has-text("Check and import")');
  await page.waitForSelector("text=Importing 2 books");
  check(true, "a CSV upload is validated and queued");
  if (process.env.E2E_JOBS === "1") {
    let complete = false;
    for (let i = 0; i < 30 && !complete; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await page.reload();
      complete = await page.isVisible("text=Import complete");
    }
    check(complete, "the jobs Worker ingests the import");
  }

  await page.goto(`${ADMIN}/catalog/import`);
  await page.setInputFiles("#file", {
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("title,authors,crunch\nX,Y,9\n"),
  });
  await page.click('button:has-text("Check and import")');
  await page.waitForSelector("text=Nothing was imported");
  check(await page.isVisible("text=Row 2:"), "a bad file is refused with row numbers, and nothing is stored");

  // Editorial runs (M2): the owner queues the book, a run claims it through the CLI and pushes a
  // classification, and the book shows it. The API refuses a missing or wrong token.
  await page.goto(bookUrl);
  await page.click('button:has-text("Classify next")');
  await page.waitForSelector("text=Queued for the next editorial run");
  check(true, "the owner queues a book for classification");
  const state = mkdtempSync(join(tmpdir(), "rlr-e2e-editorial-"));
  const cliEnv = { ...process.env, EDITORIAL_STATE_DIR: state, EDITORIAL_API_URL: ADMIN };
  delete cliEnv.EDITORIAL_TOKEN;
  const editorial = (args) =>
    execFileSync("pnpm", ["-s", "editorial", ...args], { cwd: repoRoot, env: cliEnv, encoding: "utf8" });
  editorial(["start", "--env", "local", "--label", "e2e"]);
  const workFile = join(state, "work.json");
  editorial(["pull", "--kind", "classify", "--limit", "200", "--out", workFile]);
  const work = JSON.parse(readFileSync(workFile, "utf8"));
  const bookId = bookUrl.split("/").pop();
  check(
    work.items.some((i) => i.input.book.id === bookId),
    "a run claims it through `pnpm editorial pull`",
  );
  const proposals = work.items.map((i) => ({
    kind: "classify",
    item_id: i.item_id,
    book_id: i.input.book.id,
    in_scope: "yes",
    primary_genre: "litrpg",
    tags: [{ slug: "system-apocalypse", confidence: "high", evidence: "Set by the E2E run." }],
    crunch_level: { value: 2, confidence: "medium" },
    romance_level: { value: 0, confidence: "medium" },
    harem: { value: "none", confidence: "high" },
    known_work: "no",
    dials: { pacing: { value: 8, confidence: "medium" }, crunch: { value: 6, confidence: "medium" } },
    stats: {},
    content_flags: [],
    summary: "An end-to-end summary written by the test run.",
    hook: "A hook from the test run.",
    anomalies: [],
  }));
  const proposalsFile = join(state, "proposals.json");
  writeFileSync(proposalsFile, JSON.stringify(proposals));
  const pushed = editorial(["push", proposalsFile]);
  check(
    /accepted/.test(pushed) && !/rejected/.test(pushed),
    "the classification passes validation and policy",
  );
  editorial(["finish", "--notes", "e2e"]);
  await page.goto(bookUrl);
  check(
    await page.isVisible("text=An end-to-end summary written by the test run."),
    "the book page shows the run's classification",
  );
  await page.goto(`${ADMIN}/editorial`);
  check(await page.isVisible("text=e2e"), "the console lists the run");
  const wrong = await fetch(`${ADMIN}/api/editorial/status`, {
    headers: { authorization: "Bearer not-the-right-editorial-token" },
  });
  const missing = await fetch(`${ADMIN}/api/editorial/status`);
  check(wrong.status === 401 && missing.status === 401, "the editorial API refuses a missing or wrong token");

  // Discovery (M3). A second published book in the same vein, then a fresh model.
  const second = `E2E Hunter Rival ${stamp}`;
  await page.goto(`${ADMIN}/catalog/new`);
  await page.fill("#title", second);
  await page.fill("#authors", `E2E Rival ${stamp}`);
  await page.selectOption("#genre", "litrpg");
  await page.fill("#tags", "system-apocalypse");
  await page.click('button:has-text("Save book")');
  await page.waitForSelector("text=Added.");
  await page.click('button[value="publish"]');
  await page.waitForSelector("text=Book is now published");
  await page.goto(`${ADMIN}/match`);
  await page.click('button:has-text("Rebuild now")');
  await page.waitForSelector("text=/Built \\S+ from \\d+ books|Nothing changed/");
  check(await page.isVisible("text=Current version"), "the owner rebuilds the match model");
  const firstSlug = sqlRows(`SELECT slug FROM books WHERE id = '${bookId}'`)[0]?.slug;
  await page.goto(`${ADMIN}/match?loved=${firstSlug}`);
  check(await page.isVisible("text=Reader class:"), "a sample match runs in the console");

  // The site checks for a new model at most once a minute (DESIGN §7.8).
  let served = false;
  for (let i = 0; i < 40 && !served; i++) {
    const res = await fetch(`${WEB}/api/match`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({ loved: [firstSlug] }),
    });
    served = res.ok && (await res.json()).loved.length > 0;
    if (!served) await new Promise((r) => setTimeout(r, 2000));
  }
  check(served, "the site picks up the new model");

  const visitor = await newReader(browser);
  await visitor.page.goto(`${WEB}/match`);
  await visitor.hydrated();
  await visitor.page.fill('input[type="search"]', title);
  await visitor.page.click(`.hits button:has-text("${title}")`);
  await visitor.page.click('button:has-text("Find my next read")');
  await visitor.page.waitForURL((u) => u.pathname === "/match/r");
  await visitor.hydrated();
  check(
    await visitor.page.isVisible(`text=Because you loved ${title}`),
    "a reader matches from a loved book and lands on a shareable result",
  );
  const shareUrl = visitor.page.url();
  const card = await fetch(`${WEB}/match/card.svg?${new URL(shareUrl).search.slice(1)}`);
  check(
    card.status === 200 && (card.headers.get("content-type") ?? "").startsWith("image/svg+xml"),
    "the result has a reader class card",
  );
  const liked = await fetch(`${WEB}/books-like/${firstSlug}`);
  check(liked.status === 200, "the book has a books-like page");

  const quizSlug = "whats-your-litrpg-class";
  const before = await fetch(`${WEB}/quiz/${quizSlug}`);
  const quizRow = () => page.locator("tr", { hasText: quizSlug });
  await page.goto(`${ADMIN}/quizzes`);
  if (await quizRow().locator('button[value="retire"]').isVisible()) {
    await quizRow().locator('button[value="retire"]').click();
    await page.waitForSelector("text=is retired");
  } else check(before.status === 404, "a quiz that isn't published isn't on the site");
  await quizRow().locator('button[value="publish"]').click();
  await page.waitForSelector("text=is live");
  check(true, "the owner publishes a quiz");
  await visitor.page.goto(`${WEB}/quiz`);
  await visitor.page.click(`a[href="/quiz/${quizSlug}"]`);
  await visitor.hydrated();
  // Wait for the next question (or the result) after each answer: a click on the answer just
  // picked can land while the result renders, and then waits for a button that never comes back.
  for (let i = 0; i < 20 && !(await visitor.page.isVisible(".quiz-result")); i++) {
    const step = await visitor.page.textContent(".quiz-player > .label");
    await visitor.page.locator(".options button").first().click();
    await visitor.page.waitForFunction(
      (before) =>
        document.querySelector(".quiz-result") !== null ||
        document.querySelector(".quiz-player > .label")?.textContent !== before,
      step,
    );
  }
  await visitor.page.waitForSelector(".quiz-result h2");
  check(await visitor.page.isVisible("text=books for you"), "a reader plays the quiz and gets a result");
  const resultHref = await visitor.page.getAttribute('a:has-text("Share my result")', "href");
  await visitor.page.goto(`${WEB}${resultHref}`);
  check(await visitor.page.isVisible("text=Take the quiz"), "the result has a shareable page");
  const ogUrl = await visitor.page.getAttribute('meta[property="og:image"]', "content");
  check(/\/og\/quiz\/.+\.png$/.test(ogUrl ?? ""), "the result's link preview is a PNG card");
  if (withJobs) {
    // Publishing queued og.render; the jobs Worker draws the cards with resvg inside workerd.
    const png = await eventually(async () => {
      const res = await fetch(ogUrl);
      return res.status === 200 && res.headers.get("content-type") === "image/png"
        ? new Uint8Array(await res.arrayBuffer())
        : null;
    });
    check(png && png[0] === 0x89 && png[1] === 0x50, "the jobs Worker renders the quiz's PNG share cards");
  }
  const quizCard = await fetch(`${WEB}${resultHref}/card.svg`);
  check(quizCard.status === 200, "the result has a share card");
  await visitor.page.click('a:has-text("Get matches for this result")');
  await visitor.page.waitForURL((u) => u.pathname === "/match/quiz");
  await visitor.hydrated();
  check(true, "a result carries into the Match Quiz");
  // Locally both previews share one SQLite file; let the island's preview requests finish first.
  await visitor.page.waitForLoadState("networkidle");
  await visitor.context.close();
  await page.goto(`${ADMIN}/quizzes`);
  await quizRow().locator('button[value="retire"]').click();
  await page.waitForSelector("text=is retired");
  const after = await fetch(`${WEB}/quiz/${quizSlug}`);
  check(after.status === 404, "a retired quiz leaves the site");
  await page.goto(`${ADMIN}/audit`);
  const trail = await page.textContent("main");
  check(
    trail.includes("match.model_rebuild") && trail.includes("quiz.publish") && trail.includes("quiz.retire"),
    "model rebuilds and quiz decisions are audited",
  );

  // The public site (M4).
  await page.goto(bookUrl);
  await page.selectOption('select[name="kind"]', "ebook");
  await page.fill('input[name="date"]', "2027-03-14");
  await page.click('button[value="release_set"]');
  await page.waitForSelector("text=Release date added");
  check(true, "the owner sets a release date");
  await page.setInputFiles('input[name="cover"]', {
    name: "cover.png",
    mimeType: "image/png",
    buffer: solidPng(640, 960, [stamp % 200, 80, 120]),
  });
  await page.click('button:has-text("Upload")');
  await page.waitForSelector("text=Cover received");
  check(true, "the owner uploads a cover, and it is checked and kept privately");

  const reader2 = await newReader(browser);
  const beacon = reader2.page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/e" && r.request().method() === "POST",
  );
  await reader2.page.goto(`${WEB}/books/${firstSlug}`);
  check((await reader2.page.textContent("h1"))?.includes(title), "the book has a public page");
  check((await beacon).status() === 204, "the page reports a view to the beacon");
  const html = await reader2.page.content();
  check(
    html.includes('"@type":"Book"') && html.includes('rel="canonical"'),
    "the book page carries structured data and a canonical link",
  );
  await reader2.page.click(`a:has-text("E2E Series ${stamp}")`);
  check(
    new URL(reader2.page.url()).pathname === `/series/e2e-series-${stamp}`,
    "the book links to its series",
  );
  check((await fetch(`${WEB}/authors/zogarth`)).status === 200, "the author has a page");
  const tagPage = await fetch(`${WEB}/tags/system-apocalypse`);
  const tagFeed = await (await fetch(`${WEB}/feeds/tags/system-apocalypse.xml`)).text();
  check(
    tagPage.status === 200 && tagFeed.includes(`/books/${firstSlug}`),
    "the tag has a page, and its feed lists the new book",
  );
  const fresh = await (await fetch(`${WEB}/new`)).text();
  check(
    fresh.includes(`/books/${firstSlug}`) && fresh.includes("14 Mar 2027"),
    "New & upcoming shows the release",
  );
  const cal = await (await fetch(`${WEB}/feeds/releases.ics`)).text();
  check(cal.includes("DTSTART;VALUE=DATE:20270314"), "the release calendar has the date");
  const robots = await (await fetch(`${WEB}/robots.txt`)).text();
  check(
    robots.includes("User-agent: GPTBot") && robots.includes("Sitemap:"),
    "robots.txt sets the crawler policy",
  );
  const books = await (await fetch(`${WEB}/sitemaps/books-1.xml`)).text();
  check(books.includes(`/books/${firstSlug}</loc>`), "the sitemap lists the book");
  // A primary genre counts as its genre tag, so the genre pages are in the tag sitemap (DESIGN §9.10).
  const tagMap = await (await fetch(`${WEB}/sitemaps/tags.xml`)).text();
  check(tagMap.includes("/tags/litrpg</loc>"), "the tag sitemap lists the LitRPG genre page");
  await reader2.page.goto(`${WEB}/lists`);
  check(
    (await reader2.page.locator(".list-card .cover-fan").count()) > 0 &&
      /\[Living list · \d+ books?\]/.test((await reader2.page.textContent(".lists-board")) ?? ""),
    "the reading lists show their covers and how many books they hold",
  );
  if (withJobs) {
    const src = await eventually(async () => {
      const page = await (await fetch(`${WEB}/books/${firstSlug}`)).text();
      return /<img class="cover large"[^>]*src="([^"]+)"/.exec(page)?.[1] ?? null;
    }, 60);
    const img = src ? await fetch(src) : null;
    check(
      img?.status === 200 && img.headers.get("content-type") === "image/webp",
      "the jobs Worker publishes the cover as WebP variants",
    );
  }
  await reader2.context.close();

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
