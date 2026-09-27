// Reader emails (DESIGN §13.4, QUIZZES §3.4): the subscription confirmation, the welcome sequence,
// the weekly Patch Notes, release-day alerts and "your export is ready". Hand-written, table-based
// HTML with a plain-text part; every value is escaped. Links go to readlitrpg.com pages, never
// straight to a retailer (§13.5).

import { button, escapeHtml, layout } from "./layout";

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export interface EmailBook {
  title: string;
  url: string;
  authors: string;
  series?: string | null;
  hook?: string | null;
  /** "92% match", "Out 3 Nov 2026", "Ebook release"… */
  note?: string | null;
  why?: string | null;
  /** One-click choices; each opens a page with the choice pre-selected (QUIZZES §3.4). */
  marks?: { loved: string; read: string; no: string } | null;
}

/** What every marketing email carries at the bottom (DESIGN §13.3). */
export interface Footer {
  unsubscribeUrl: string;
  preferencesUrl: string;
  postalAddress: string;
  /** "You're getting this because…" */
  reason: string;
}

const mono = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
const muted = "color:#6f6a60;";
const a = (href: string, label: string, style = "color:#1f5f4a;") =>
  `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>`;
const p = (html: string, style = "") => `<p style="margin:0 0 12px;${style}">${html}</p>`;
const h2 = (text: string) => `<h2 style="margin:24px 0 8px;font-size:18px;">${escapeHtml(text)}</h2>`;
const system = (text: string) => p(escapeHtml(text), `${mono}font-size:13px;color:#8a6a1f;`);

function footerParts(f: Footer) {
  const html = `<br><br>${escapeHtml(f.reason)}<br>${a(f.preferencesUrl, "Email preferences", `${muted}`)} · ${a(f.unsubscribeUrl, "Unsubscribe", `${muted}`)}${f.postalAddress ? `<br>${escapeHtml(f.postalAddress)}` : ""}`;
  const text = [
    "",
    f.reason,
    `Email preferences: ${f.preferencesUrl}`,
    `Unsubscribe: ${f.unsubscribeUrl}`,
    f.postalAddress,
  ]
    .filter(Boolean)
    .join("\n");
  return { html, text };
}

function bookHtml(b: EmailBook): string {
  const meta = [b.authors, b.series].filter(Boolean).join(" · ");
  const marks = b.marks
    ? `<div style="margin-top:6px;font-size:13px;">${a(b.marks.loved, "Loved it")} · ${a(b.marks.read, "Read it")} · ${a(b.marks.no, "Not for me")}</div>`
    : "";
  return `<tr><td style="padding:10px 0;border-top:1px solid #e4dfd3;">
<div style="font-weight:600;">${a(b.url, b.title, "color:#1b1a17;text-decoration:none;")}${b.note ? ` <span style="${mono}font-size:12px;color:#1f5f4a;">${escapeHtml(b.note)}</span>` : ""}</div>
<div style="font-size:13px;${muted}">${escapeHtml(meta)}</div>
${b.hook ? `<div style="font-size:14px;font-style:italic;margin-top:4px;">${escapeHtml(b.hook)}</div>` : ""}
${b.why ? `<div style="font-size:14px;margin-top:4px;">${escapeHtml(b.why)}</div>` : ""}
${marks}
</td></tr>`;
}

const bookList = (list: EmailBook[]) =>
  list.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.map(bookHtml).join("")}</table>`
    : "";

const bookText = (list: EmailBook[]) =>
  list
    .map((b) =>
      [
        `- ${b.title}${b.note ? ` (${b.note})` : ""}`,
        `  ${[b.authors, b.series].filter(Boolean).join(" · ")}`,
        b.hook ? `  ${b.hook}` : "",
        `  ${b.url}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

function compose(opts: {
  subject: string;
  preheader: string;
  blocks: { html: string; text: string }[];
  footer?: Footer;
  footerText: string;
}): Rendered {
  const f = opts.footer ? footerParts(opts.footer) : { html: "", text: "" };
  return {
    subject: opts.subject,
    html: layout({
      preheader: opts.preheader,
      bodyHtml: opts.blocks.map((b) => b.html).join("\n"),
      footerText: opts.footerText,
      footerHtml: f.html,
    }),
    text: [...opts.blocks.map((b) => b.text), "", opts.footerText, f.text]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

const block = (html: string, text: string) => ({ html, text });

/** "your The Party Main reading list" reads badly: drop a leading article after "your". */
export const yourClass = (className: string) => className.replace(/^the\s+/i, "");

// ---------------------------------------------------------------------------------------------
// E0: confirm the subscription (double opt-in)

export function renderConfirm(o: { url: string; className?: string | null; listOnly: boolean }): Rendered {
  const subject = o.className
    ? `Confirm to get your ${yourClass(o.className)} reading list`
    : "Confirm your ReadLitRPG subscription";
  const what = o.className
    ? o.listOnly
      ? `Confirm and we'll send your ${yourClass(o.className)} reading list. Just the list: no weekly email.`
      : `Confirm and we'll send your ${yourClass(o.className)} reading list, then a weekly email of new matches for your taste.`
    : "Confirm and we'll send Patch Notes, a weekly email of new LitRPG matches for your taste.";
  return compose({
    subject,
    preheader: "One click to confirm. Nothing is sent until you do.",
    footerText:
      "You're getting this because someone entered this address on readlitrpg.com. If it wasn't you, ignore it: nothing more will arrive.",
    blocks: [
      block(system("[Quest offered] Confirm your email"), "[Quest offered] Confirm your email"),
      block(p(escapeHtml(what)), what),
      block(button(o.url, "Confirm my email"), `Confirm: ${o.url}`),
      block(
        p("One click to unsubscribe, any time. We never share your email.", `font-size:13px;${muted}`),
        "One click to unsubscribe, any time. We never share your email.",
      ),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// The welcome sequence (QUIZZES §3.4)

export function renderWelcome1(o: {
  className: string | null;
  best: EmailBook[];
  more: EmailBook[];
  matchUrl: string;
  footer: Footer;
}): Rendered {
  const who = o.className ?? "you";
  const total = o.best.length + o.more.length;
  return compose({
    subject: o.className
      ? `Your ${yourClass(o.className)} reading list is here`
      : "Your reading list is here",
    preheader: `${total} books picked for your profile, not just your class.`,
    footer: o.footer,
    footerText: "ReadLitRPG: a free discovery engine for LitRPG and progression fantasy.",
    blocks: [
      block(system(`[Loot acquired] A reading list for ${who}`), `[Loot acquired] A reading list for ${who}`),
      block(
        p(
          `${total} books picked for your profile. Tap <em>Loved it</em>, <em>Read it</em> or <em>Not for me</em> on any you know and your matches sharpen.`,
        ),
        `${total} books picked for your profile. Mark the ones you know and your matches sharpen.`,
      ),
      o.best.length
        ? block(h2("Best bets") + bookList(o.best), `BEST BETS\n${bookText(o.best)}`)
        : block(
            p(
              "Your list is still being stocked: the catalog is filling up. Your matches page updates as books arrive.",
            ),
            "Your list is still being stocked. Your matches page updates as books arrive.",
          ),
      o.more.length
        ? block(h2(`${o.more.length} more`) + bookList(o.more), `MORE\n${bookText(o.more)}`)
        : block("", ""),
      block(button(o.matchUrl, "See all my matches"), `All your matches: ${o.matchUrl}`),
    ],
  });
}

export function renderWelcome2(o: { rateUrl: string; footer: Footer }): Rendered {
  return compose({
    subject: "Your class is a starting point",
    preheader: "Rate 12 classics in 60 seconds and your matches get much sharper.",
    footer: o.footer,
    footerText: "ReadLitRPG: a free discovery engine for LitRPG and progression fantasy.",
    blocks: [
      block(system("[Skill unlocked] Taste appraisal"), "[Skill unlocked] Taste appraisal"),
      block(
        p(
          "A class tells us the broad strokes. Twelve books you've read tell us the rest: how fast you like the power to climb, how crunchy the system should be, and what makes you put a book down.",
        ),
        "A class tells us the broad strokes. Twelve books you've read tell us the rest.",
      ),
      block(button(o.rateUrl, "Rate 12 classics (60 seconds)"), `Rate 12 classics: ${o.rateUrl}`),
    ],
  });
}

export function renderWelcome3(o: {
  className: string | null;
  upcoming: EmailBook[];
  followUrl: string;
  quiz: { title: string; url: string } | null;
  footer: Footer;
}): Rendered {
  return compose({
    subject: o.className ? `New and upcoming for ${o.className}` : "New and upcoming for you",
    preheader: "Fresh releases that fit your profile, and one more quiz.",
    footer: o.footer,
    footerText: "ReadLitRPG: a free discovery engine for LitRPG and progression fantasy.",
    blocks: [
      block(system("[Patch incoming] New and upcoming"), "[Patch incoming] New and upcoming"),
      o.upcoming.length
        ? block(bookList(o.upcoming), bookText(o.upcoming))
        : block(
            p("Nothing new fits your profile this week. The catalog grows every day."),
            "Nothing new fits your profile this week.",
          ),
      block(
        p(`Love a series? ${a(o.followUrl, "Follow it")} and we'll tell you the day the next book is out.`),
        `Follow a series you love: ${o.followUrl}`,
      ),
      o.quiz
        ? block(
            p(`One more for the road: ${a(o.quiz.url, o.quiz.title)}`),
            `Another quiz: ${o.quiz.title} ${o.quiz.url}`,
          )
        : block("", ""),
    ],
  });
}

export function renderWelcome4(o: { preferencesUrl: string; footer: Footer }): Rendered {
  return compose({
    subject: "Your first weekly matches",
    preheader: "Patch Notes arrives on Fridays. Here's how to make it yours.",
    footer: o.footer,
    footerText: "ReadLitRPG: a free discovery engine for LitRPG and progression fantasy.",
    blocks: [
      block(system("[Party joined] Patch Notes"), "[Party joined] Patch Notes"),
      block(
        p(
          "From Friday you'll get Patch Notes: new matches for your taste, what's out from the series and authors you follow, and what's coming soon.",
        ),
        "From Friday you'll get Patch Notes: new matches, releases from what you follow, and what's coming soon.",
      ),
      block(
        p(
          `Change what it covers (or how often) on your ${a(o.preferencesUrl, "preferences page")}. Unsubscribing is one click at the bottom of every email.`,
        ),
        `Preferences: ${o.preferencesUrl}`,
      ),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Patch Notes: this week in LitRPG (DESIGN §13.5)

export interface DigestParts {
  week: string;
  className: string | null;
  outFromFollows: EmailBook[];
  newMatches: EmailBook[];
  comingSoon: EmailBook[];
  savedSearches: { name: string; url: string; books: EmailBook[] }[];
  quiz: { title: string; url: string } | null;
  footer: Footer;
}

export function renderDigest(d: DigestParts): Rendered {
  const quiet =
    !d.outFromFollows.length &&
    !d.newMatches.length &&
    !d.comingSoon.length &&
    !d.savedSearches.some((s) => s.books.length);
  const heading = d.className ? `This week for ${d.className}` : "This week in LitRPG";
  const blocks = [
    block(system(`[Patch Notes · ${d.week}] ${heading}`), `[Patch Notes · ${d.week}] ${heading}`),
    quiet
      ? block(
          p("A quiet week for your follows. The catalog grows every day; here's where to look meanwhile."),
          "A quiet week for your follows.",
        )
      : block("", ""),
    d.outFromFollows.length
      ? block(
          h2("Out this week from what you follow") + bookList(d.outFromFollows),
          `OUT THIS WEEK FROM WHAT YOU FOLLOW\n${bookText(d.outFromFollows)}`,
        )
      : block("", ""),
    d.newMatches.length
      ? block(
          h2("New matches for your taste") + bookList(d.newMatches),
          `NEW MATCHES FOR YOUR TASTE\n${bookText(d.newMatches)}`,
        )
      : block("", ""),
    ...d.savedSearches
      .filter((s) => s.books.length)
      .map((s) =>
        block(
          h2(`New for "${s.name}"`) + bookList(s.books) + p(a(s.url, "See the whole search")),
          `NEW FOR "${s.name}"\n${bookText(s.books)}\n${s.url}`,
        ),
      ),
    d.comingSoon.length
      ? block(
          h2("Coming soon from what you follow") + bookList(d.comingSoon),
          `COMING SOON\n${bookText(d.comingSoon)}`,
        )
      : block("", ""),
    d.quiz
      ? block(
          h2("Quiz of the week") + p(a(d.quiz.url, d.quiz.title)),
          `QUIZ OF THE WEEK\n${d.quiz.title} ${d.quiz.url}`,
        )
      : block("", ""),
  ];
  return compose({
    subject: quiet
      ? `Patch Notes ${d.week}: a quiet week`
      : d.newMatches[0]
        ? `Patch Notes ${d.week}: ${d.newMatches[0].title} and more for you`
        : `Patch Notes ${d.week}: ${heading}`,
    preheader: d.newMatches[0]
      ? `${d.newMatches[0].title} and more, picked for your taste.`
      : "New and upcoming LitRPG for your taste.",
    footer: d.footer,
    footerText: "Patch Notes: this week in LitRPG, from ReadLitRPG.",
    blocks,
  });
}

// ---------------------------------------------------------------------------------------------
// Release-day alert (DESIGN §13.6): one bundled email a day at most

export function renderReleaseAlert(o: {
  releases: EmailBook[];
  savedSearches: { name: string; url: string; books: EmailBook[] }[];
  footer: Footer;
}): Rendered {
  const first =
    o.releases[0]?.title ?? o.savedSearches.find((s) => s.books.length)?.books[0]?.title ?? "New books";
  const count = o.releases.length + o.savedSearches.reduce((n, s) => n + s.books.length, 0);
  return compose({
    // "Out today" only when something followed is released today; saved searches find books new to the site.
    subject: `${o.releases.length ? "Out today" : "New for you"}: ${first}${count > 1 ? ` and ${count - 1} more` : ""}`,
    preheader: "New books from what you follow.",
    footer: o.footer,
    footerText: "Release alerts from ReadLitRPG: at most one email a day.",
    blocks: [
      block(system("[New arrivals] Out today"), "[New arrivals] Out today"),
      o.releases.length ? block(bookList(o.releases), bookText(o.releases)) : block("", ""),
      ...o.savedSearches
        .filter((s) => s.books.length)
        .map((s) =>
          block(h2(`New for "${s.name}"`) + bookList(s.books), `NEW FOR "${s.name}"\n${bookText(s.books)}`),
        ),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Account

export function renderExportReady(o: { url: string; days: number }): Rendered {
  return compose({
    subject: "Your ReadLitRPG data export is ready",
    preheader: `Download it within ${o.days} days.`,
    footerText:
      "You asked for this export from your account page. If you didn't, sign in and check your account.",
    blocks: [
      block(system("[Inventory] Your data"), "[Inventory] Your data"),
      block(
        p(
          `Everything we hold about you, as one JSON file. The link works for ${o.days} days and only for you.`,
        ),
        `The link works for ${o.days} days.`,
      ),
      block(button(o.url, "Download my data"), `Download: ${o.url}`),
    ],
  });
}
