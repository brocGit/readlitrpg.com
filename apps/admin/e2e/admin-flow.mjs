// End-to-end owner console test against both previews (web on 4321, admin on 4322):
// the owner registers a passkey on the main site, is promoted to admin, signs in to the console
// with the same passkey, changes a setting (audited), queues a job, and verifies the audit chain.
// A reader's passkey must not open the console.
//
// Local runs stand in for Cloudflare Access with ACCESS_DEV_EMAIL (see .dev.vars.example).

import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const WEB = process.env.E2E_WEB_URL ?? "http://localhost:4321";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:4322";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const webDir = new URL("../../web/", import.meta.url);
const adminDir = new URL("..", import.meta.url);

const problems = [];
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E check failed: ${message}`);
  console.log(`✓ ${message}`);
};
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
  await page.waitForURL((u) => u.pathname === "/account");
  await hydrated();
  await page.click('button:has-text("Add a passkey")');
  await page.waitForSelector("li:has-text('added')");
  // Adding a passkey reloads the page; let that finish before navigating on.
  await page.waitForLoadState("networkidle");
}

// Test runs sign in many times from one IP; start each run with fresh rate-limit windows.
sql("DELETE FROM rate_counters");

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

  check(
    problems.length === 0,
    `no CSP violations or page errors${problems.length ? `: ${problems.join(" | ")}` : ""}`,
  );
} finally {
  await browser.close();
}
