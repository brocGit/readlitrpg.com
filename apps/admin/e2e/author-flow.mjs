// End-to-end author journey (M6) against both previews (web on 4321, admin on 4322): a reader
// becomes an author with a new pen name, asks to verify, and submits a book, which waits for the
// owner. The owner approves both in the Owner Inbox. The now-verified author edits (a blurb goes
// live at once, a series change waits for approval, a date change days before release is refused),
// sees a change the owner made, hides and shows the listing, invites an editor, and pastes a book
// list that an editorial run (through the real `pnpm editorial` CLI) turns into a draft they
// publish. A second claim on the profile goes to the owner, who rejects it. Last, the one-click
// "Still on for …?" release link. Fails on any CSP violation or page error.
//
// Run after the console E2E (it signs the owner in the same way). With E2E_JOBS=1 the jobs Worker
// (wrangler dev --test-scheduled on :8788) emails the decisions and sends the release ask.

import { execFileSync, execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:4321";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:4322";
const JOBS = process.env.E2E_JOBS_URL ?? "http://localhost:8788";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const withJobs = process.env.E2E_JOBS === "1";
const webDir = new URL("../../web/", import.meta.url);
const adminDir = new URL("..", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
// The local value from .dev.vars.example (never a production key).
const LINK_KEY = "local-dev-only-link-key-not-for-production-000000";

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

/** A signed link, as packages/core/src/readers/links.ts makes them. */
function signedToken(purpose, data, expiresAt = 0) {
  const body = Buffer.from(JSON.stringify(["k1", purpose, data, expiresAt])).toString("base64url");
  const sig = createHmac("sha256", LINK_KEY).update(`${purpose}.${body}`).digest("hex").slice(0, 32);
  return `${body}.${sig}`;
}

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

/** Submit a form and wait for `url`; a refusal fails with the page's own message. */
async function submitTo(page, button, url) {
  await page.click(button);
  await Promise.race([page.waitForURL(url), page.waitForSelector(".notice.error")]).catch(() => {
    throw new Error(`E2E: the form went to ${page.url()}`);
  });
  const refused = await page.$(".notice.error");
  if (refused) throw new Error(`E2E: the form was refused: ${(await refused.textContent())?.trim()}`);
}

/** Approve or reject the open Owner Inbox item whose row mentions `text`. */
async function decide({ page }, text, decision, note = "") {
  await page.goto(`${ADMIN}/inbox`);
  const row = page.locator("tr", { hasText: text });
  if (note) await row.locator('input[name="note"]').fill(note);
  await row.locator(`button[value="${decision}"]`).click();
  await page.waitForSelector(`text=Marked ${decision}.`);
}

// Letters only: a number in a title reads as a volume number.
const tag = Date.now()
  .toString(36)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)]);
const penName = `Quill Byrne ${tag}`;
const bookTitle = `The Tower Ledger ${tag}`;
const draftTitle = `The Vault Ledger ${tag}`;
const seriesName = `Ledger Cycle ${tag}`;
const authorEmail = `author-${tag}@example.com`;
const editorEmail = `editor-${tag}@example.com`;
const claimerEmail = `claimer-${tag}@example.com`;
const releaseDate = inDays(14);
// Store ids unique to the run: the duplicate check rightly matches a book from an earlier run.
const rrId = String(Date.now()).slice(-7);
const asin = `B0${tag.toUpperCase().slice(-8).padStart(8, "X")}`;

// Sign-ins from one IP: start with fresh rate-limit windows.
sql("DELETE FROM rate_counters");

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
try {
  // The owner, in the console (a passkey, as in the console E2E).
  const owner = await newUser(browser, { passkey: true });
  await signIn(owner, OWNER);
  await owner.page.goto(`${WEB}/account`);
  await owner.hydrated();
  await owner.page.click('button:has-text("Add a passkey")');
  await owner.page.waitForSelector("li:has-text('added')");
  await owner.page.waitForLoadState("networkidle");
  sql(`UPDATE users SET is_admin = 1 WHERE email = '${OWNER}'`);
  await owner.page.goto(`${ADMIN}/`);
  await owner.hydrated();
  await owner.page.click('button:has-text("Sign in with passkey")');
  await owner.page.waitForURL((u) => u.pathname === "/");

  // A reader becomes an author (DESIGN §10.1).
  const author = await newUser(browser);
  const page = author.page;
  await page.goto(`${WEB}/for-authors`);
  check(await page.isVisible('a:has-text("I\'m an author")'), "the For authors page leads to the dashboard");
  await signIn(author, authorEmail);
  const [authorUser] = rows(`SELECT id FROM users WHERE email = '${authorEmail}'`);
  await page.goto(`${WEB}/dashboard`);
  check(
    new URL(page.url()).pathname === "/dashboard/start",
    "a reader without a profile starts at I'm an author",
  );
  if (rows("SELECT id FROM authors WHERE slug = 'zogarth'").length > 0) {
    await page.fill("#name", "Zogarth");
    await page.click('button:has-text("Create the profile")');
    await page.waitForSelector("text=already in our catalog");
    check(true, "a pen name already in the catalog is claimed, not created twice");
  }
  await page.fill("#name", penName);
  await page.click('button:has-text("Create the profile")');
  await page.waitForURL(/\/dashboard\/verify\//);
  const authorId = new URL(page.url()).pathname.split("/").pop();
  const [membership] = rows(
    `SELECT role FROM author_members WHERE author_id = '${authorId}' AND user_id = '${authorUser.id}'`,
  );
  check(
    membership?.role === "owner" && (await page.isVisible("text=Profile created")),
    "a new pen name makes the reader its owner, unverified",
  );

  // Verification by a code on a page we never fetch: checked by hand (DESIGN §10.2).
  await page.click('summary:has-text("Royal Road, Amazon Author Central")');
  const start = page.locator('details:has(summary:has-text("Royal Road")) form');
  await start.locator('input[name="target"]').fill("https://www.royalroad.com/profile/424242");
  await start.locator('button:has-text("Get my code")').click();
  const code = (await page.textContent(".status-screen .code"))?.trim() ?? "";
  check(/^rlr-verify-/.test(code), "verifying hands out a code to put on the page");
  await page.click('form:has(input[value="check"]) button:has-text("Check")');
  await page.waitForSelector("text=We'll check the page by hand");
  check(true, "a code on a page we don't fetch goes to a check by hand");

  // An unverified author's book waits for the owner (DESIGN §10.3).
  await page.goto(`${WEB}/dashboard/books/new?author=${authorId}`);
  await page.fill("#title", bookTitle);
  await page.selectOption("#genre", "litrpg");
  await page.fill(
    "#blurb",
    "A clerk in the tower's counting-house discovers the System audits everyone, and it is behind.",
  );
  await page.fill("#links", `https://www.royalroad.com/fiction/${rrId}/the-tower-ledger`);
  await page.fill("#date_ebook", releaseDate);
  await page.click('button[value="suggest"]');
  check((await page.inputValue("#title")) === bookTitle, "suggesting tags keeps what was typed");
  await page.$eval('details:has(input[value="system-apocalypse"])', (d) => {
    d.open = true;
  });
  await page.check('input[name="tags"][value="system-apocalypse"]');
  await page.selectOption("#harem", "none");
  await page.selectOption("#romance", "0");
  await page.check('input[name="ai"][value="human"]');
  await submitTo(page, 'button[value="submit"]', (u) => u.pathname === "/dashboard");
  check(await page.isVisible("text=It's in review"), "an unverified author's book waits for a check");
  check(
    rows(`SELECT id FROM books WHERE title = '${bookTitle}'`).length === 0,
    "nothing is published before the check",
  );

  // The owner approves the listing and the verification (DESIGN §8.2).
  await decide(owner, bookTitle, "approved");
  const [book] = rows(`SELECT id, slug, visibility FROM books WHERE title = '${bookTitle}'`);
  check(book?.visibility === "published", "the owner's approval publishes the book");
  await decide(owner, code, "approved");
  const [verified] = rows(`SELECT trust_level, verified_at FROM authors WHERE id = '${authorId}'`);
  check(verified?.trust_level === "T1" && Boolean(verified.verified_at), "the owner verifies the author");
  check(
    rows(`SELECT id FROM audit_log WHERE action = 'author.verify' AND subject_id = '${authorId}'`).length ===
      1,
    "verification is audited",
  );
  await page.goto(`${WEB}/dashboard`);
  check(
    (await page.isVisible(`a:has-text("${bookTitle}")`)) && (await page.isVisible("td:has-text('Live')")),
    "the dashboard lists the book as live",
  );
  const [{ slug: authorSlug }] = rows(`SELECT slug FROM authors WHERE id = '${authorId}'`);
  const authorPage = await (await fetch(`${WEB}/authors/${authorSlug}`)).text();
  check(authorPage.includes("Verified author"), "the author page shows the verified badge");
  check((await fetch(`${WEB}/books/${book.slug}`)).status === 200, "the book has a public page");
  await owner.page.goto(`${ADMIN}/catalog/authors`);
  await owner.page.click(`a:has-text("${penName}")`);
  const profile = await owner.page.textContent("main");
  check(
    profile.includes("T1 · verified") && profile.includes(authorEmail) && profile.includes(bookTitle),
    "the console shows the author's trust, members and books",
  );

  // The author's own profile (DESIGN §10.5).
  await page.goto(`${WEB}/dashboard/profile/${authorId}`);
  await page.fill("#bio", "Writes about ledgers, towers and the people who balance them.");
  await page.fill("#newsletter", "https://quill.example/newsletter");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Saved.");
  check(
    rows(`SELECT newsletter_url FROM authors WHERE id = '${authorId}'`)[0]?.newsletter_url ===
      "https://quill.example/newsletter",
    "the author edits their bio and links",
  );

  // Edits under the protected-field rules (DESIGN §10.4).
  const bookDash = `${WEB}/dashboard/books/${book.id}`;
  await page.goto(bookDash);
  const blurb =
    "Revised by the author: the System audits everyone, and the clerk is the only one who reads the ledger.";
  await page.fill("#blurb", blurb);
  await page.click('button:has-text("Save changes")');
  await page.waitForSelector("text=Saved.");
  check(
    rows(`SELECT blurb_author FROM books WHERE id = '${book.id}'`)[0]?.blurb_author === blurb,
    "a verified author's edit goes live at once",
  );
  await page.fill("#series_name", seriesName);
  await page.fill("#series_position", "1");
  await page.click('button:has-text("Save changes")');
  await page.waitForSelector("text=need a quick check first");
  check(
    rows(`SELECT series_id FROM books WHERE id = '${book.id}'`)[0]?.series_id === null,
    "a series change waits for the owner",
  );
  await decide(owner, `Author change to "${bookTitle}"`, "approved");
  check(
    rows(`SELECT s.name FROM books b JOIN series s ON s.id = b.series_id WHERE b.id = '${book.id}'`)[0]
      ?.name === seriesName,
    "approving applies the series change as the author",
  );
  await page.goto(bookDash);
  await page.selectOption("#kind", "ebook");
  await page.fill("#date", inDays(2));
  await page.click('button:has-text("Set the date")');
  await page.waitForSelector("text=need a quick check first");
  check(
    rows(`SELECT date FROM releases WHERE book_id = '${book.id}' AND kind = 'ebook'`)[0]?.date ===
      releaseDate,
    "a date change days before release is checked first",
  );
  await decide(owner, `Author change to "${bookTitle}"`, "rejected", "The store still shows the old date.");
  check(
    rows(`SELECT kind FROM author_notices WHERE author_id = '${authorId}' AND kind = 'change_rejected'`)
      .length === 1,
    "the author is told the change wasn't applied",
  );

  // A change by someone else lands in the author's change log (DESIGN §10.6).
  await owner.page.goto(`${ADMIN}/catalog/books/${book.id}`);
  await owner.page.selectOption('select[name="kind"]', "audio");
  await owner.page.fill('input[name="date"]', inDays(60));
  await owner.page.click('button[value="release_set"]');
  await owner.page.waitForSelector("text=Release date added");
  await page.goto(`${WEB}/dashboard`);
  check(await page.isVisible("text=Changes by others"), "the owner's change shows on the author's dashboard");

  // Hiding is always immediate.
  await page.goto(bookDash);
  await page.click('button:has-text("Hide this listing")');
  await page.waitForSelector("text=Saved.");
  check(
    rows(`SELECT visibility FROM books WHERE id = '${book.id}'`)[0]?.visibility === "hidden",
    "an author hides a listing at once",
  );
  await page.click('button:has-text("Show it again")');
  await page.waitForSelector("text=Saved.");
  check(
    rows(`SELECT visibility FROM books WHERE id = '${book.id}'`)[0]?.visibility === "published",
    "and shows it again",
  );

  // Team members (DESIGN §10.5).
  await page.goto(`${WEB}/dashboard/team/${authorId}`);
  const invitePattern = /http:\/\/localhost:\d+\/dashboard\/invite\/\S+/g;
  const invitesBefore = previewLinks(invitePattern).length;
  await page.fill("#email", editorEmail);
  await page.selectOption("#role", "editor");
  await page.click('button:has-text("Send invite")');
  await page.waitForSelector(`text=Invite sent to ${editorEmail}`);
  const inviteUrl = await eventually(() => {
    const all = previewLinks(invitePattern);
    return all.length > invitesBefore ? all.at(-1) : null;
  }, 10);
  check(Boolean(inviteUrl), "an owner invites an editor by email (dev console)");
  const editor = await newUser(browser);
  await signIn(editor, editorEmail);
  await editor.page.goto(inviteUrl);
  await editor.page.click('button:has-text("Accept")');
  await editor.page.waitForSelector("text=[Party joined]");
  check(
    rows(
      `SELECT m.role FROM author_members m JOIN users u ON u.id = m.user_id WHERE m.author_id = '${authorId}' AND u.email = '${editorEmail}'`,
    )[0]?.role === "editor",
    "the invitee joins as an editor",
  );
  await editor.page.goto(bookDash);
  check((await editor.page.textContent("h1"))?.trim() === bookTitle, "an editor manages the books");
  await editor.page.goto(`${WEB}/dashboard/team/${authorId}`);
  check(
    await editor.page.isVisible("text=Only owners can invite or remove members."),
    "only owners manage the team",
  );
  await editor.context.close();

  // A second claim on a managed profile goes to the owner (DESIGN §10.1).
  const claimer = await newUser(browser);
  await signIn(claimer, claimerEmail);
  await claimer.page.goto(`${WEB}/dashboard/start?q=${encodeURIComponent(penName)}`);
  await claimer.page.click('button:has-text("Claim anyway")');
  await claimer.page.waitForSelector("text=we'll check your claim by hand");
  check(true, "claiming a managed profile goes to review");
  await decide(owner, `Second claim on the author profile "${penName}"`, "rejected", "Not the author.");
  check(
    rows(
      `SELECT m.role FROM author_members m JOIN users u ON u.id = m.user_id WHERE u.email = '${claimerEmail}'`,
    ).length === 0,
    "a rejected claim adds no member",
  );
  await claimer.context.close();

  // Paste anything (DESIGN §10.3): an editorial run turns a pasted list into drafts.
  await page.goto(`${WEB}/dashboard/paste?author=${authorId}`);
  const draftBlurb = "The clerk opens the vault's books and finds a stat nobody has ever levelled.";
  await page.fill(
    "#text",
    [
      "My books:",
      `${bookTitle} (${seriesName} #1) is out now.`,
      `${draftTitle} (${seriesName} #2). ${draftBlurb}`,
      `https://www.amazon.com/dp/${asin}`,
    ].join("\n"),
  );
  await page.click('button:has-text("Make drafts")');
  await page.waitForSelector("text=including 1 store link");
  const [paste] = rows(`SELECT id FROM author_pastes WHERE author_id = '${authorId}'`);
  const state = mkdtempSync(join(tmpdir(), "rlr-e2e-authors-"));
  const cliEnv = { ...process.env, EDITORIAL_STATE_DIR: state, EDITORIAL_API_URL: ADMIN };
  delete cliEnv.EDITORIAL_TOKEN;
  const editorial = (args) =>
    execFileSync("pnpm", ["-s", "editorial", ...args], { cwd: repoRoot, env: cliEnv, encoding: "utf8" });
  editorial(["start", "--env", "local", "--label", "e2e-authors"]);
  const workFile = join(state, "work.json");
  editorial(["pull", "--kind", "import_extract", "--limit", "50", "--out", workFile]);
  const work = JSON.parse(readFileSync(workFile, "utf8"));
  check(
    work.items.some((i) => i.input.paste_id === paste?.id),
    "a run claims the paste through `pnpm editorial pull`",
  );
  // Leftovers from earlier local runs get an empty extraction.
  const proposals = work.items.map((i) => ({
    kind: "import_extract",
    item_id: i.item_id,
    paste_id: i.input.paste_id,
    books:
      i.input.paste_id === paste?.id
        ? [
            { title: bookTitle, series_name: seriesName, series_position: 1 },
            {
              title: draftTitle,
              series_name: seriesName,
              series_position: 2,
              genre: "litrpg",
              blurb: draftBlurb,
              links: [`https://www.amazon.com/dp/${asin}`],
            },
          ]
        : [],
    anomalies: [],
  }));
  const proposalsFile = join(state, "proposals.json");
  writeFileSync(proposalsFile, JSON.stringify(proposals));
  const pushed = editorial(["push", proposalsFile]);
  check(/accepted/.test(pushed) && !/rejected/.test(pushed), "the extraction passes validation");
  editorial(["finish", "--notes", "e2e authors"]);
  const drafts = rows(
    `SELECT id, json_extract(payload, '$.title') AS title FROM author_submissions WHERE author_id = '${authorId}' AND status = 'draft'`,
  );
  check(
    drafts.length === 1 && drafts[0].title === draftTitle,
    "the run drafts the new book and skips the one already listed",
  );
  await page.goto(`${WEB}/dashboard`);
  await page.click('a:has-text("Check and submit")');
  check((await page.inputValue("#title")) === draftTitle, "the draft opens prefilled");
  check((await page.inputValue("#series_name")) === seriesName, "with its series");
  await page.check('input[name="ai"][value="human"]');
  await submitTo(page, 'button[value="submit"]', /published=1/);
  check(
    rows(`SELECT visibility FROM books WHERE title = '${draftTitle}'`)[0]?.visibility === "published",
    "a verified author's book goes live on submit",
  );

  // "Still on for …?" (DESIGN §7.7): the jobs Worker sends it 14 days out; the link needs no sign-in.
  let askId;
  if (withJobs) {
    // A first heartbeat creates the schedule rows for jobs it hasn't seen; then make two due.
    await fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);
    sql(
      "UPDATE schedules SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE key IN ('release.confirm_asks', 'authors.notices')",
    );
    await fetch(`${JOBS}/__scheduled?cron=*/5+*+*+*+*`);
    askId = await eventually(() => rows(`SELECT id FROM release_asks WHERE book_id = '${book.id}'`)[0]?.id);
    check(Boolean(askId), "the jobs Worker asks the author to confirm the date");
    const mailed = await eventually(
      () =>
        rows(
          `SELECT id FROM email_sends WHERE user_id = '${authorUser.id}' AND template = 'release_ask' AND status = 'sent'`,
        )[0],
    );
    check(Boolean(mailed), "and emails the ask");
    const unsent = await eventually(
      () =>
        rows(`SELECT id FROM author_notices WHERE author_id = '${authorId}' AND sent_at IS NULL`).length ===
        0,
    );
    check(unsent, "the jobs Worker emails the author's decisions");
  } else {
    const [rel] = rows(`SELECT id FROM releases WHERE book_id = '${book.id}' AND kind = 'ebook'`);
    askId = `e2eask${tag}`;
    sql(
      `INSERT INTO release_asks (id, release_id, book_id, stage, date, sent_at) VALUES ('${askId}', '${rel.id}', '${book.id}', 't14', '${releaseDate}', '${new Date().toISOString()}')`,
    );
  }
  const anon = await newUser(browser);
  const askLink = `${WEB}/dashboard/release/${signedToken("release", [askId, authorUser.id], Date.now() + 21 * 86_400_000)}`;
  await anon.page.goto(askLink);
  await anon.page.click('button:has-text("Yes, that\'s the date")');
  await anon.page.waitForSelector("text=[Quest log updated]");
  check(
    rows(`SELECT answer FROM release_asks WHERE id = '${askId}'`)[0]?.answer === "confirmed",
    "one click confirms the date, without signing in",
  );
  await anon.page.goto(askLink);
  check(await anon.page.isVisible("text=Already answered"), "an answered ask takes no more changes");
  const forged = await fetch(`${WEB}/dashboard/release/${signedToken("unsub", [askId, authorUser.id])}`);
  check(
    (await forged.text()).includes("That link has expired"),
    "a link signed for another purpose doesn't work",
  );
  await anon.context.close();

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
