// Author emails (DESIGN §13.4): team invites, decisions on their listings and verification, the
// daily note of changes others made to their books, and "Still on for Oct 12?". All transactional:
// they're about the author's own listings, not marketing.

import { button, escapeHtml, layout } from "./layout";
import type { Rendered } from "./reader";

const p = (html: string, style = "") => `<p style="margin:0 0 12px;${style}">${html}</p>`;
const system = (text: string) =>
  p(
    escapeHtml(text),
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:#8a6a1f;",
  );
const muted = (text: string) => p(escapeHtml(text), "font-size:13px;color:#6f6a60;");
const FOOTER = "You're getting this because you manage an author profile on ReadLitRPG.";

function compose(
  subject: string,
  preheader: string,
  parts: { html: string; text: string }[],
  footer = FOOTER,
): Rendered {
  return {
    subject,
    html: layout({ preheader, bodyHtml: parts.map((x) => x.html).join("\n"), footerText: footer }),
    text: [...parts.map((x) => x.text), "", footer]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
const part = (html: string, text: string) => ({ html, text });

export function renderAuthorInvite(o: {
  authorName: string;
  role: "owner" | "editor";
  url: string;
}): Rendered {
  const what = `You've been invited to help manage ${o.authorName}'s books on ReadLitRPG as ${o.role === "owner" ? "an owner" : "an editor"}.`;
  return compose(
    `Join ${o.authorName} on ReadLitRPG`,
    "Accept within 7 days, signed in with this address.",
    [
      part(system("[Party invite]"), "[Party invite]"),
      part(p(escapeHtml(what)), what),
      part(button(o.url, "Accept the invite"), `Accept: ${o.url}`),
      part(
        muted(
          "Sign in with this email address to accept. The link works for 7 days. If you weren't expecting this, ignore it.",
        ),
        "Sign in with this email address to accept. The link works for 7 days. If you weren't expecting this, ignore it.",
      ),
    ],
    "You're getting this because an author on ReadLitRPG entered this address.",
  );
}

export type AuthorNotice =
  | "listing_published"
  | "listing_rejected"
  | "verified"
  | "verify_rejected"
  | "member_added"
  | "claim_approved"
  | "claim_rejected"
  | "change_approved"
  | "change_rejected"
  | "drafts_ready"
  | "pitch_accepted"
  | "pitch_declined"
  | "guest_changes"
  | "guest_scheduled"
  | "guest_declined"
  | "interview_invite"
  | "interview_ready"
  | "interview_scheduled"
  | "ad_scheduled"
  | "ad_rejected"
  | "ad_cancelled"
  | "ad_report"
  | "makegood"
  | "pro_welcome";

/** One short email per decision. `payload` fields are optional and escaped. */
export function renderAuthorNotice(
  kind: AuthorNotice,
  o: { authorName: string; dashboardUrl: string; payload: Record<string, unknown>; origin: string },
): Rendered {
  const s = (k: string) => (typeof o.payload[k] === "string" ? (o.payload[k] as string) : "");
  const title = s("title") || "your book";
  const bookUrl = s("slug") ? `${o.origin}/books/${s("slug")}` : o.dashboardUrl;
  const note = s("note") || s("reason");
  const dash = part(button(o.dashboardUrl, "Open your dashboard"), `Your dashboard: ${o.dashboardUrl}`);
  switch (kind) {
    case "listing_published":
      return compose(`"${title}" is live on ReadLitRPG`, "Readers can find it now.", [
        part(system("[Listing published]"), "[Listing published]"),
        part(
          p(
            `<strong>${escapeHtml(title)}</strong> is live. Readers can find it, follow it and get it in their matches.`,
          ),
          `${title} is live.`,
        ),
        part(button(bookUrl, "See the page"), `See it: ${bookUrl}`),
      ]);
    case "listing_rejected":
      return compose(`We couldn't list "${title}"`, "Here's why, and what to do next.", [
        part(p(`We couldn't list <strong>${escapeHtml(title)}</strong>.`), `We couldn't list ${title}.`),
        part(
          p(escapeHtml(note || "It didn't pass our listing checks.")),
          note || "It didn't pass our listing checks.",
        ),
        part(
          muted("Reply to this email if you think we got it wrong."),
          "Reply to this email if you think we got it wrong.",
        ),
        dash,
      ]);
    case "verified":
      return compose(`${o.authorName} is verified`, "Your listings now publish without waiting.", [
        part(system("[Rank up] Verified author"), "[Rank up] Verified author"),
        part(
          p(
            "Your profile is verified. New books and edits now go live straight away, and readers see the verified badge.",
          ),
          "Your profile is verified. New books and edits now go live straight away.",
        ),
        dash,
      ]);
    case "verify_rejected":
      return compose(`We couldn't verify ${o.authorName}`, "Try another way to verify.", [
        part(
          p("We couldn't confirm that profile is yours with the method you chose."),
          "We couldn't confirm that profile is yours with the method you chose.",
        ),
        ...(note ? [part(p(escapeHtml(note)), note)] : []),
        part(
          p("Try another method from your dashboard. A code on your own website is the quickest."),
          "Try another method from your dashboard.",
        ),
        dash,
      ]);
    case "member_added":
      return compose(`Someone new can manage ${o.authorName}`, "A member was added to your author profile.", [
        part(
          p(
            `A new member was added to <strong>${escapeHtml(o.authorName)}</strong>. If you didn't expect this, remove them from the Team page and reply to this email.`,
          ),
          `A new member was added to ${o.authorName}.`,
        ),
        dash,
      ]);
    case "claim_approved":
      return compose(`You now manage ${o.authorName}`, "Your claim was approved.", [
        part(
          p(
            `Your claim on <strong>${escapeHtml(o.authorName)}</strong> was approved. Verify the profile next so your books publish without waiting.`,
          ),
          `Your claim on ${o.authorName} was approved.`,
        ),
        dash,
      ]);
    case "claim_rejected":
      return compose(`About your claim on ${o.authorName}`, "We couldn't approve it.", [
        part(
          p(
            `We couldn't approve your claim on <strong>${escapeHtml(o.authorName)}</strong>. If the profile is yours, ask its current owner to invite you, or reply to this email.`,
          ),
          `We couldn't approve your claim on ${o.authorName}.`,
        ),
        ...(note ? [part(p(escapeHtml(note)), note)] : []),
      ]);
    case "change_approved":
      return compose("Your change is live", "An edit that needed a check has been applied.", [
        part(
          p(`Your change (${escapeHtml(s("reason") || "an edit")}) was checked and is now live.`),
          `Your change (${s("reason") || "an edit"}) is now live.`,
        ),
        dash,
      ]);
    case "change_rejected":
      return compose("About your change", "An edit wasn't applied.", [
        part(
          p(`We didn't apply your change (${escapeHtml(s("reason") || "an edit")}).`),
          `We didn't apply your change (${s("reason") || "an edit"}).`,
        ),
        // `note` would fall back to the reason, already said above.
        ...(s("note") ? [part(p(escapeHtml(s("note"))), s("note"))] : []),
        part(
          muted("Reply to this email if you'd like to talk it through."),
          "Reply to this email if you'd like to talk it through.",
        ),
      ]);
    case "drafts_ready": {
      const n = Number(o.payload.drafts ?? 0);
      return compose(
        `${n} book ${n === 1 ? "draft is" : "drafts are"} ready to check`,
        "Confirm each one and it goes live.",
        [
          part(system("[Loot sorted]"), "[Loot sorted]"),
          part(
            p(
              `We turned what you pasted into ${n} draft ${n === 1 ? "listing" : "listings"}. Check each one, fix anything we got wrong, and submit.`,
            ),
            `We turned what you pasted into ${n} drafts. Check and submit each one.`,
          ),
          dash,
        ],
      );
    }
    case "pitch_accepted":
      return compose(`Your pitch is in: "${title}"`, "Write it when you're ready.", [
        part(system("[Quest accepted]"), "[Quest accepted]"),
        part(
          p(
            `We'd love to publish <strong>${escapeHtml(title)}</strong>. Write it in your dashboard, then submit it for review.`,
          ),
          `We'd love to publish ${title}. Write it in your dashboard, then submit it for review.`,
        ),
        part(
          button(`${o.origin}/dashboard/write/${s("postId")}`, "Start writing"),
          `Start writing: ${o.origin}/dashboard/write/${s("postId")}`,
        ),
      ]);
    case "pitch_declined":
      return compose(`About your pitch: "${title}"`, "Not this one, but pitch again any time.", [
        part(p(`We're passing on <strong>${escapeHtml(title)}</strong>.`), `We're passing on ${title}.`),
        ...(s("note") ? [part(p(escapeHtml(s("note"))), s("note"))] : []),
        part(
          p("Pitch again any time: the craft of LitRPG and other authors' books do best."),
          "Pitch again any time.",
        ),
        dash,
      ]);
    case "guest_changes":
      return compose(`A few changes to "${title}"`, "Edit it and submit it again.", [
        part(
          p(`Before we publish <strong>${escapeHtml(title)}</strong>, a few changes:`),
          `Before we publish ${title}, a few changes:`,
        ),
        ...(s("note") ? [part(p(escapeHtml(s("note"))), s("note"))] : []),
        part(
          button(`${o.origin}/dashboard/write/${s("postId")}`, "Edit your post"),
          `Edit it: ${o.origin}/dashboard/write/${s("postId")}`,
        ),
      ]);
    case "guest_scheduled":
    case "interview_scheduled": {
      const when = s("publishAt").slice(0, 10);
      return compose(`"${title}" goes live on ${when}`, "Share it when it's out.", [
        part(system("[Scheduled]"), "[Scheduled]"),
        part(
          p(
            `<strong>${escapeHtml(title)}</strong> publishes on the ReadLitRPG blog on ${escapeHtml(when)}. It will appear on your author page too.`,
          ),
          `${title} publishes on ${when}. It will appear on your author page too.`,
        ),
        dash,
      ]);
    }
    case "guest_declined":
      return compose(`About "${title}"`, "We won't publish this one.", [
        part(p(`We won't publish <strong>${escapeHtml(title)}</strong>.`), `We won't publish ${title}.`),
        ...(s("note") ? [part(p(escapeHtml(s("note"))), s("note"))] : []),
        part(
          muted("Reply to this email if you'd like to talk it through."),
          "Reply to this email if you'd like to talk it through.",
        ),
      ]);
    case "interview_invite":
      return compose(
        `An interview for ${s("title") || "your new book"}?`,
        "Answer six questions; readers meet you before release.",
        [
          part(system("[Side quest offered]"), "[Side quest offered]"),
          part(
            p(
              `Your book <strong>${escapeHtml(s("title"))}</strong> comes out on ${escapeHtml(s("releaseDate"))}. Answer at least six of our questions in your own words and we'll publish the interview the week before release.`,
            ),
            `${s("title")} comes out on ${s("releaseDate")}. Answer at least six questions and we'll publish the interview the week before release.`,
          ),
          part(
            button(`${o.origin}/dashboard/interview/${s("interviewId")}`, "Answer the questions"),
            `Answer: ${o.origin}/dashboard/interview/${s("interviewId")}`,
          ),
        ],
      );
    case "ad_scheduled": {
      const url = `${o.origin}/dashboard/promote/${s("campaignId")}`;
      return compose("Your promotion is approved", "It runs on the dates you booked.", [
        part(system("[Quest accepted]"), "[Quest accepted]"),
        part(
          p(
            `<strong>${escapeHtml(s("title"))}</strong> is approved and starts on ${escapeHtml(s("startAt").slice(0, 10))}. You'll see what it delivered on its page, updated hourly.`,
          ),
          `${s("title")} is approved and starts on ${s("startAt").slice(0, 10)}.`,
        ),
        part(button(url, "See the promotion"), `See it: ${url}`),
      ]);
    }
    case "ad_rejected":
      return compose("We couldn't run your promotion", "You've been refunded in full.", [
        part(
          p(`We couldn't run <strong>${escapeHtml(s("title"))}</strong>, and you've been refunded in full.`),
          `We couldn't run ${s("title")}, and you've been refunded in full.`,
        ),
        ...(note ? [part(p(escapeHtml(note)), note)] : []),
        part(
          muted("Card refunds take 5–10 days to show. Credits are back in your balance now."),
          "Card refunds take 5–10 days to show. Credits are back in your balance now.",
        ),
        dash,
      ]);
    case "ad_cancelled": {
      const cents = (k: string) => (typeof o.payload[k] === "number" ? (o.payload[k] as number) : 0);
      const back = [
        cents("cardCents") ? `$${(cents("cardCents") / 100).toFixed(2)} to your card` : "",
        cents("creditCents") ? `$${(cents("creditCents") / 100).toFixed(2)} as credit` : "",
      ].filter(Boolean);
      const line = back.length
        ? `You get ${back.join(" and ")}.`
        : "Within 48 hours of the start there's no refund.";
      return compose("Promotion cancelled", line, [
        part(
          p(`<strong>${escapeHtml(s("title"))}</strong> is cancelled. ${escapeHtml(line)}`),
          `${s("title")} is cancelled. ${line}`,
        ),
        dash,
      ]);
    }
    case "ad_report": {
      const url = `${o.origin}/dashboard/promote/${s("campaignId")}`;
      const n = (k: string) => (typeof o.payload[k] === "number" ? (o.payload[k] as number) : 0);
      const lines = [
        `${n("impressions").toLocaleString("en-US")} times shown`,
        `${n("viewable").toLocaleString("en-US")} seen for a second or more`,
        ...(n("emailSends") ? [`${n("emailSends").toLocaleString("en-US")} in emails`] : []),
        `${n("clicks").toLocaleString("en-US")} clicks`,
        `${n("followsGained")} new followers of the book`,
      ];
      return compose(`How ${s("title")} did`, lines.join(", "), [
        part(system("[Quest complete] Your promotion's report"), "[Quest complete] Your promotion's report"),
        part(
          `<ul style="margin:0 0 12px;padding-left:20px;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
          lines.map((l) => `- ${l}`).join("\n"),
        ),
        part(
          muted("Numbers leave out bots and email link scanners. We never share who saw it."),
          "Numbers leave out bots and email link scanners.",
        ),
        part(button(url, "See the full report"), `Full report: ${url}`),
      ]);
    }
    case "makegood":
      return compose("We owe you a placement", "A credit is in your balance.", [
        part(
          p(
            `${escapeHtml(s("reason") || "Something on our side went wrong")}, so <strong>${escapeHtml(s("title"))}</strong> didn't get everything you paid for. We've added ${escapeHtml(s("amount"))} of credit to your balance. Sorry about that.`,
          ),
          `${s("reason") || "Something on our side went wrong"}, so ${s("title")} didn't get everything you paid for. We've added ${s("amount")} of credit to your balance.`,
        ),
        part(
          muted("Reply to this email if you'd rather rebook the same placement."),
          "Reply to this email if you'd rather rebook the same placement.",
        ),
        dash,
      ]);
    case "pro_welcome": {
      const url = `${o.origin}/dashboard/billing`;
      return compose("Welcome to Author Pro", "Thanks for supporting ReadLitRPG.", [
        part(system("[Class unlocked] Author Pro"), "[Class unlocked] Author Pro"),
        part(
          p(
            "Your submissions and edits go to the front of our review queue, promo credit arrives each quarter, and your book pages show which kinds of readers the match engine sends you.",
          ),
          "Priority review, promo credit each quarter, and which kinds of readers the match engine sends you.",
        ),
        part(button(url, "Billing and credits"), `Billing and credits: ${url}`),
      ]);
    }
    case "interview_ready":
      return compose("Your interview is ready to approve", "Check it, then approve or change your answers.", [
        part(
          p(
            `We put your answers in order and wrote a headline: <strong>${escapeHtml(s("headline"))}</strong>. We only fixed typos.`,
          ),
          `Headline: ${s("headline")}. We only fixed typos.`,
        ),
        part(
          button(`${o.origin}/dashboard/interview/${s("interviewId")}`, "Review and approve"),
          `Review: ${o.origin}/dashboard/interview/${s("interviewId")}`,
        ),
      ]);
  }
}

export interface ChangeLine {
  bookTitle: string;
  bookUrl: string;
  summary: string;
}

export function renderChangeDigest(o: {
  authorName: string;
  changes: ChangeLine[];
  dashboardUrl: string;
}): Rendered {
  const byBook = new Map<string, ChangeLine[]>();
  for (const c of o.changes) byBook.set(c.bookTitle, [...(byBook.get(c.bookTitle) ?? []), c]);
  const html = [...byBook.entries()]
    .map(
      ([title, lines]) =>
        `<p style="margin:12px 0 4px;"><strong><a href="${escapeHtml(lines[0]?.bookUrl ?? "")}" style="color:#1b1a17;">${escapeHtml(title)}</a></strong></p><ul style="margin:0 0 8px;padding-left:20px;">${[...new Set(lines.map((l) => l.summary))].map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    )
    .join("");
  const text = [...byBook.entries()]
    .map(
      ([title, lines]) =>
        `${title}\n${[...new Set(lines.map((l) => l.summary))].map((l) => `- ${l}`).join("\n")}`,
    )
    .join("\n\n");
  return compose(`Changes to ${o.authorName}'s books`, "What others changed on your listings today.", [
    part(system("[Patch log]"), "[Patch log]"),
    part(
      p("Here's what changed on your books today, made by someone other than you."),
      "Here's what changed on your books today, made by someone other than you.",
    ),
    part(html, text),
    part(
      p(
        "Something wrong? Open the book in your dashboard and use <em>Report a problem</em>; your own edit also wins over most of these.",
      ),
      "Something wrong? Open the book in your dashboard and use Report a problem.",
    ),
    part(button(o.dashboardUrl, "Open your dashboard"), `Your dashboard: ${o.dashboardUrl}`),
  ]);
}

export function renderReleaseAsk(o: { title: string; kind: string; date: string; url: string }): Rendered {
  return compose(`Still on for ${o.date}? (${o.title})`, "One click to confirm, change or delay.", [
    part(system("[Quest check-in]"), "[Quest check-in]"),
    part(
      p(
        `Is the ${escapeHtml(o.kind)} of <strong>${escapeHtml(o.title)}</strong> still coming out on <strong>${escapeHtml(o.date)}</strong>?`,
      ),
      `Is the ${o.kind} of ${o.title} still coming out on ${o.date}?`,
    ),
    part(button(o.url, "Confirm or change the date"), `Confirm or change: ${o.url}`),
    part(
      muted("Readers following the book see the date you confirm. The link works for 21 days."),
      "Readers following the book see the date you confirm. The link works for 21 days.",
    ),
  ]);
}
