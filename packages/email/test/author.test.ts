import { describe, expect, it } from "vitest";
import {
  type AuthorNotice,
  buildEmail,
  emailJobSchema,
  renderAuthorInvite,
  renderAuthorNotice,
  renderChangeDigest,
  renderReleaseAsk,
} from "../src";

const base = {
  authorName: "Jane <Doe>",
  dashboardUrl: "https://readlitrpg.com/dashboard",
  origin: "https://readlitrpg.com",
};

describe("author templates", () => {
  it("every notice kind renders, escapes the author name and keeps the transactional footer", () => {
    const kinds: AuthorNotice[] = [
      "listing_published",
      "listing_rejected",
      "verified",
      "verify_rejected",
      "member_added",
      "claim_approved",
      "claim_rejected",
      "change_approved",
      "change_rejected",
      "drafts_ready",
      "pitch_accepted",
      "pitch_declined",
      "guest_changes",
      "guest_scheduled",
      "guest_declined",
      "interview_invite",
      "interview_ready",
      "interview_scheduled",
    ];
    for (const kind of kinds) {
      const e = renderAuthorNotice(kind, { ...base, payload: { title: "<b>Loot</b>", drafts: 2 } });
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.html).not.toContain("<Doe>");
      expect(e.html).not.toContain("<b>Loot</b>");
      expect(e.text).toContain("manage an author profile");
      // No unsubscribe link: these are about the author's own listings, not marketing.
      expect(e.text).not.toContain("/u/");
    }
  });

  it("a published listing links to its page, and a rejection says why", () => {
    const live = renderAuthorNotice("listing_published", {
      ...base,
      payload: { title: "Dungeon Potato", slug: "dungeon-potato" },
    });
    expect(live.subject).toBe('"Dungeon Potato" is live on ReadLitRPG');
    expect(live.text).toContain("https://readlitrpg.com/books/dungeon-potato");
    const no = renderAuthorNotice("listing_rejected", {
      ...base,
      payload: { title: "Not LitRPG", reason: "It's a cookbook." },
    });
    expect(no.text).toContain("It's a cookbook.");
  });

  it("a rejected change names the change once and adds the owner's note", () => {
    const e = renderAuthorNotice("change_rejected", {
      ...base,
      payload: { reason: "series change", note: "Book 3 is in another series." },
    });
    expect(e.text.match(/series change/g)).toHaveLength(1);
    expect(e.text).toContain("Book 3 is in another series.");
  });

  it("drafts_ready counts the drafts", () => {
    expect(renderAuthorNotice("drafts_ready", { ...base, payload: { drafts: 1 } }).subject).toBe(
      "1 book draft is ready to check",
    );
    expect(renderAuthorNotice("drafts_ready", { ...base, payload: { drafts: 4 } }).subject).toBe(
      "4 book drafts are ready to check",
    );
  });

  it("the change digest groups by book and drops repeated lines", () => {
    const e = renderChangeDigest({
      authorName: "Jane",
      dashboardUrl: base.dashboardUrl,
      changes: [
        { bookTitle: "One", bookUrl: "https://readlitrpg.com/books/one", summary: "Cover updated" },
        { bookTitle: "One", bookUrl: "https://readlitrpg.com/books/one", summary: "Cover updated" },
        { bookTitle: "Two", bookUrl: "https://readlitrpg.com/books/two", summary: "Tags updated" },
      ],
    });
    expect(e.subject).toBe("Changes to Jane's books");
    expect(e.text.match(/Cover updated/g)).toHaveLength(1);
    expect(e.text).toContain("Two\n- Tags updated");
  });

  it("the release ask carries its link and date", () => {
    const e = renderReleaseAsk({
      title: "Book 5",
      kind: "ebook",
      date: "Oct 12",
      url: "https://readlitrpg.com/dashboard/release/tok",
    });
    expect(e.subject).toBe("Still on for Oct 12? (Book 5)");
    expect(e.html).toContain("https://readlitrpg.com/dashboard/release/tok");
  });

  it("invites render through buildEmail and state the role", () => {
    const invite = renderAuthorInvite({ authorName: "Jane", role: "editor", url: "https://r/i" });
    expect(invite.text).toContain("as an editor");
    const job = emailJobSchema.parse({
      kind: "author_invite",
      to: "helper@example.com",
      authorName: "Jane",
      role: "owner",
      url: "https://readlitrpg.com/dashboard/invite/tok",
      requestedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(buildEmail(job, new Date("2026-10-02T00:00:00Z"))?.subject).toBe("Join Jane on ReadLitRPG");
    // Past the link's 7 days it isn't sent.
    expect(buildEmail(job, new Date("2026-10-09T00:00:00Z"))).toBeNull();
  });
});
