import { describe, expect, it } from "vitest";
import {
  buildEmail,
  type EmailBook,
  emailJobSchema,
  type Footer,
  renderConfirm,
  renderDigest,
  renderReleaseAlert,
  renderWelcome1,
  SesProvider,
} from "../src";

const footer: Footer = {
  unsubscribeUrl: "https://readlitrpg.com/u/tok",
  preferencesUrl: "https://readlitrpg.com/account/email",
  postalAddress: "ReadLitRPG, 1 Example St, Springfield",
  reason: "You're getting this because you subscribed to Patch Notes.",
};

const book = (title: string, extra: Partial<EmailBook> = {}): EmailBook => ({
  title,
  url: `https://readlitrpg.com/books/${title.toLowerCase().replace(/\W+/g, "-")}`,
  authors: "A. Author",
  ...extra,
});

describe("reader templates", () => {
  it("confirmation explains what the reader gets and carries the link", () => {
    const listOnly = renderConfirm({
      url: "https://readlitrpg.com/subscribe/confirm?t=x",
      className: "Tank",
      listOnly: true,
    });
    expect(listOnly.subject).toContain("Tank reading list");
    expect(listOnly.text).toContain("Just the list");
    expect(listOnly.text).toContain("https://readlitrpg.com/subscribe/confirm?t=x");
    expect(renderConfirm({ url: "https://x", className: "The Party Main", listOnly: false }).subject).toBe(
      "Confirm to get your Party Main reading list",
    );
    const weekly = renderConfirm({ url: "https://readlitrpg.com/subscribe/confirm?t=x", listOnly: false });
    expect(weekly.subject).toBe("Confirm your ReadLitRPG subscription");
    expect(weekly.text).toContain("Patch Notes");
  });

  it("escapes every value and puts the footer on marketing mail", () => {
    const evil = book('<img src=x onerror="alert(1)">', {
      hook: "<script>x</script>",
      marks: { loved: "https://r/m/1", read: "https://r/m/2", no: "https://r/m/3" },
    });
    const e = renderWelcome1({
      className: "Rogue",
      best: [evil],
      more: [book("Two"), book("Three")],
      matchUrl: "https://readlitrpg.com/match",
      footer,
    });
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<img src=x");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.text).toContain("3 books picked");
    expect(e.html).toContain("2 more");
    expect(e.html).toContain("Loved it");
    for (const part of [e.html, e.text]) {
      expect(part).toContain("https://readlitrpg.com/u/tok");
      expect(part).toContain("1 Example St");
    }
  });

  it("digest subject follows its content, and a quiet week says so", () => {
    const busy = renderDigest({
      week: "2026-W40",
      className: "Mage",
      outFromFollows: [book("Out Now")],
      newMatches: [book("Fresh Pick", { note: "91% match" })],
      comingSoon: [],
      savedSearches: [
        { name: "crafting", url: "https://readlitrpg.com/find?q=crafting", books: [book("Forge")] },
      ],
      quiz: null,
      footer,
    });
    expect(busy.subject).toBe("Patch Notes 2026-W40: Fresh Pick and more for you");
    expect(busy.text).toContain('NEW FOR "crafting"');
    expect(busy.text).toContain("91% match");
    const quiet = renderDigest({
      week: "2026-W41",
      className: null,
      outFromFollows: [],
      newMatches: [],
      comingSoon: [],
      savedSearches: [],
      quiz: null,
      footer,
    });
    expect(quiet.subject).toBe("Patch Notes 2026-W41: a quiet week");
  });

  it("release alerts count everything they bundle", () => {
    const e = renderReleaseAlert({
      releases: [book("Book 5")],
      savedSearches: [{ name: "tower", url: "https://x", books: [book("Climb"), book("Floor 2")] }],
      footer,
    });
    expect(e.subject).toBe("Out today: Book 5 and 2 more");
  });
});

describe("reader email jobs", () => {
  it("drops week-old confirmations", () => {
    const job = emailJobSchema.parse({
      kind: "confirm_subscription",
      to: "a@example.com",
      userId: "01J0000000000000000000000",
      url: "https://readlitrpg.com/subscribe/confirm?t=x",
      className: null,
      listOnly: false,
      requestedAt: "2026-09-20T12:00:00.000Z",
    });
    expect(buildEmail(job, new Date("2026-09-21T12:00:00Z"))).toMatchObject({
      template: "confirm_subscription",
      stream: "transactional",
    });
    expect(buildEmail(job, new Date("2026-09-28T12:00:00Z"))).toBeNull();
  });

  it("passes rendered mail through and refuses oversized bodies", () => {
    const base = {
      kind: "rendered",
      to: "a@example.com",
      userId: null,
      template: "weekly_digest",
      issueId: "01J0000000000000000000001",
      stream: "marketing",
      subject: "Patch Notes",
      html: "<p>hi</p>",
      text: "hi",
      headers: { "List-Unsubscribe": "<https://readlitrpg.com/u/t>" },
    };
    const message = buildEmail(emailJobSchema.parse(base));
    expect(message).toMatchObject({ stream: "marketing", template: "weekly_digest", issueId: base.issueId });
    expect(emailJobSchema.safeParse({ ...base, html: "x".repeat(80_000) }).success).toBe(false);
    expect(emailJobSchema.safeParse({ ...base, template: "nope" }).success).toBe(false);
  });

  it("sends marketing mail from the news address", async () => {
    let body: { FromEmailAddress?: string; ConfigurationSetName?: string } = {};
    const provider = new SesProvider({
      accessKeyId: "a",
      secretAccessKey: "b",
      region: "us-east-1",
      from: "ReadLitRPG <hello@mail.readlitrpg.com>",
      fromMarketing: "ReadLitRPG <weekly@news.readlitrpg.com>",
      configurationSets: { transactional: "rlr-transactional", marketing: "rlr-marketing" },
      fetch: async (input) => {
        body = await (input as Request).json();
        return Response.json({ MessageId: "m" });
      },
    });
    await provider.send({ to: "a@example.com", subject: "s", html: "h", text: "t", stream: "marketing" });
    expect(body.FromEmailAddress).toBe("ReadLitRPG <weekly@news.readlitrpg.com>");
    expect(body.ConfigurationSetName).toBe("rlr-marketing");
  });
});
