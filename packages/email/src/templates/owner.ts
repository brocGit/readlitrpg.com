// Emails to the owner (DESIGN §8.4): the daily action email (only when something needs them), the
// Sunday summary, and instant alerts. Operational mail to the site's own admins: transactional,
// plain, and every link goes to the admin console.

import { button, escapeHtml, layout } from "./layout";
import type { Rendered } from "./reader";

const p = (html: string, style = "") => `<p style="margin:0 0 12px;${style}">${html}</p>`;
const h2 = (text: string) => `<h2 style="margin:24px 0 8px;font-size:17px;">${escapeHtml(text)}</h2>`;
const mono = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
const system = (text: string) => p(escapeHtml(text), `${mono}font-size:13px;color:#8a6a1f;`);
const a = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:#1f5f4a;">${escapeHtml(label)}</a>`;
const FOOTER = "You're getting this because you're an admin of ReadLitRPG. Change it in Admin → Settings.";

function compose(subject: string, preheader: string, parts: { html: string; text: string }[]): Rendered {
  return {
    subject,
    html: layout({ preheader, bodyHtml: parts.map((x) => x.html).join("\n"), footerText: FOOTER }),
    text: [...parts.map((x) => x.text), "", FOOTER]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}
const part = (html: string, text: string) => ({ html, text });

function list(items: { html: string; text: string }[]) {
  return part(
    `<ul style="margin:0 0 12px;padding-left:20px;">${items.map((i) => `<li style="margin:4px 0;">${i.html}</li>`).join("")}</ul>`,
    items.map((i) => `- ${i.text}`).join("\n"),
  );
}

export interface OwnerItem {
  title: string;
  type: string;
  /** "Auto-approves in 5 h", "Due 6 Oct", "Priority 95". */
  when: string;
}

export function renderOwnerDaily(o: {
  due: OwnerItem[];
  urgent: OwnerItem[];
  open: number;
  inboxUrl: string;
}): Rendered {
  const n = o.due.length + o.urgent.length;
  const item = (i: OwnerItem) => ({
    html: `${escapeHtml(i.title)} <span style="${mono}font-size:12px;color:#6f6a60;">${escapeHtml(i.type)} · ${escapeHtml(i.when)}</span>`,
    text: `${i.title} (${i.type} · ${i.when})`,
  });
  return compose(
    `${n} inbox item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`,
    o.urgent.length ? "Something urgent is waiting." : "Some items decide themselves within 48 hours.",
    [
      part(system("[Quest log] Today's decisions"), "[Quest log] Today's decisions"),
      o.urgent.length
        ? part(h2("Urgent") + list(o.urgent.map(item)).html, `URGENT\n${list(o.urgent.map(item)).text}`)
        : part("", ""),
      o.due.length
        ? part(
            h2("Due in the next 48 hours") + list(o.due.map(item)).html,
            `DUE IN THE NEXT 48 HOURS\n${list(o.due.map(item)).text}`,
          )
        : part("", ""),
      part(
        p(
          `${o.open} open in all. Items with a default act on their own when the time comes; the rest wait for you.`,
          "color:#6f6a60;font-size:14px;",
        ),
        `${o.open} open in all.`,
      ),
      part(button(o.inboxUrl, "Open the inbox"), `Inbox: ${o.inboxUrl}`),
    ],
  );
}

export interface OwnerWeekly {
  from: string;
  to: string;
  kpis: { layer: string; line: string }[];
  inbox: {
    opened: number;
    ownerDecided: number;
    autoDecided: number;
    openNow: number;
    automationRate: number;
  };
  autoApproved: { title: string; status: string; undoUrl: string | null }[];
  lineup: string[];
  scheduledPosts: { title: string; when: string }[];
  bookedAds: { campaign: string; slot: string; when: string }[];
  liveCampaigns: number;
  inboxUrl: string;
  auditUrl: string;
}

export function renderOwnerWeekly(o: OwnerWeekly): Rendered {
  const kpis = list(
    o.kpis.map((k) => ({
      html: `<strong>${escapeHtml(k.layer)}:</strong> ${escapeHtml(k.line)}`,
      text: `${k.layer}: ${k.line}`,
    })),
  );
  const inboxLine = `${o.inbox.opened} opened, ${o.inbox.ownerDecided} decided by you, ${o.inbox.autoDecided} decided themselves (${o.inbox.automationRate}% automated). ${o.inbox.openNow} open now.`;
  const autos = o.autoApproved.slice(0, 20).map((x) => ({
    html: `${escapeHtml(x.title)} <span style="color:#6f6a60;font-size:13px;">${escapeHtml(x.status.replace("_", " "))}</span>${x.undoUrl ? ` · ${a(x.undoUrl, "undo")}` : ""}`,
    text: `${x.title} (${x.status.replace("_", " ")})${x.undoUrl ? ` undo: ${x.undoUrl}` : ""}`,
  }));
  const posts = o.scheduledPosts.map((x) => ({
    html: `${escapeHtml(x.title)} <span style="color:#6f6a60;font-size:13px;">${escapeHtml(x.when)}</span>`,
    text: `${x.title} (${x.when})`,
  }));
  const ads = o.bookedAds.map((x) => ({
    html: `${escapeHtml(x.campaign)} <span style="color:#6f6a60;font-size:13px;">${escapeHtml(x.slot)} · ${escapeHtml(x.when)}</span>`,
    text: `${x.campaign} (${x.slot} · ${x.when})`,
  }));
  const lineup = o.lineup.map((l) => ({ html: escapeHtml(l), text: l }));
  return compose(`Your week at ReadLitRPG: ${o.from} to ${o.to}`, o.kpis[0]?.line ?? "The week in numbers.", [
    part(system("[Weekly report] The week in numbers"), "[Weekly report] The week in numbers"),
    part(kpis.html, kpis.text),
    part(h2("Inbox") + p(escapeHtml(inboxLine)), `INBOX\n${inboxLine}`),
    autos.length
      ? part(
          h2("What decided itself") + list(autos).html + p(a(o.auditUrl, "Everything you can undo")),
          `WHAT DECIDED ITSELF\n${list(autos).text}\nEverything you can undo: ${o.auditUrl}`,
        )
      : part("", ""),
    lineup.length
      ? part(
          h2("Next week's newsletters") + list(lineup).html,
          `NEXT WEEK'S NEWSLETTERS\n${list(lineup).text}`,
        )
      : part("", ""),
    posts.length
      ? part(h2("Scheduled posts") + list(posts).html, `SCHEDULED POSTS\n${list(posts).text}`)
      : part("", ""),
    part(
      h2("Ads") +
        p(escapeHtml(`${o.liveCampaigns} live campaign${o.liveCampaigns === 1 ? "" : "s"}.`)) +
        (ads.length ? list(ads).html : ""),
      `ADS\n${o.liveCampaigns} live campaigns.${ads.length ? `\n${list(ads).text}` : ""}`,
    ),
    part(button(o.inboxUrl, "Open the inbox"), `Inbox: ${o.inboxUrl}`),
  ]);
}

export function renderOwnerAlert(o: {
  title: string;
  type: string;
  priority: number;
  summary: string | null;
  url: string;
}): Rendered {
  return compose(`Alert: ${o.title}`.slice(0, 200), `${o.type}, priority ${o.priority}`, [
    part(system(`[Alert] ${o.type} · priority ${o.priority}`), `[Alert] ${o.type} · priority ${o.priority}`),
    part(p(`<strong>${escapeHtml(o.title)}</strong>`), o.title),
    o.summary ? part(p(escapeHtml(o.summary)), o.summary) : part("", ""),
    part(button(o.url, "Open the inbox"), `Inbox: ${o.url}`),
  ]);
}
