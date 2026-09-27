// Share cards (DESIGN §9.1, §7.10, QUIZZES §3.2): quiz results, reader classes and books as
// 1200×630 SVG in the brand's colors. The site serves the SVG; the jobs Worker rasterizes the same
// SVG to PNG for platforms that don't show SVG link previews.

import { color, font } from "./tokens";

// DejaVu first: it's the font the PNG renderer ships (the jobs Worker has no system fonts).
// Browsers showing the SVG version without it fall through to the brand's system stacks.
const sans = `'DejaVu Sans', ${font.body}`;
const mono = `'DejaVu Sans Mono', ${font.system}`;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** Greedy word wrap by character count (monospace-ish widths are close enough for a card). */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line ? `${line} ${w}` : w).length > width && line) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${(lines[maxLines - 1] ?? "").replace(/\s*\S*$/, "")}…`;
  }
  return lines;
}

export interface CardText {
  kicker: string;
  title: string;
  subtitle?: string;
  lines?: string[];
  footer?: string;
}

export function cardSvg(c: CardText): string {
  const title = wrap(c.title, 28, 2);
  const subtitle = c.subtitle ? wrap(c.subtitle, 52, 2) : [];
  const lines = (c.lines ?? []).slice(0, 3).map((l) => wrap(l, 60, 1)[0] ?? "");
  let y = 250;
  const parts: string[] = [];
  for (const t of title) {
    parts.push(`<text x="80" y="${y}" font-size="68" font-weight="700" fill="${color.ink}">${esc(t)}</text>`);
    y += 78;
  }
  y += 10;
  for (const s of subtitle) {
    parts.push(`<text x="80" y="${y}" font-size="32" fill="${color.muted}">${esc(s)}</text>`);
    y += 42;
  }
  y += 16;
  // Whatever doesn't fit above the footer is left off.
  for (const l of lines.filter((_, i) => y + i * 38 <= 490)) {
    parts.push(
      `<text x="80" y="${y}" font-size="28" font-family="${mono}" fill="${color.primary}">${esc(l)}</text>`,
    );
    y += 38;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${sans}">
<rect width="1200" height="630" fill="${color.paper}"/>
<rect x="40" y="40" width="1120" height="550" rx="18" fill="${color.surface}" stroke="${color.line}" stroke-width="3"/>
<text x="80" y="140" font-size="30" font-family="${mono}" letter-spacing="3" fill="${color.accent}">${esc(c.kicker.toUpperCase())}</text>
${parts.join("\n")}
<text x="80" y="550" font-size="28" font-family="${mono}" fill="${color.ink}"><tspan fill="${color.accent}">[</tspan>ReadLitRPG<tspan fill="${color.accent}">]</tspan></text>
<text x="1120" y="550" font-size="24" text-anchor="end" fill="${color.muted}">${esc(c.footer ?? "readlitrpg.com")}</text>
</svg>`;
}

export interface BookCardText {
  title: string;
  byline: string;
  kicker: string;
  hook?: string | null;
  note?: string | null;
  /** A cover as a data: URI (PNG or JPEG), with its size. */
  cover?: { href: string; width: number; height: number } | null;
}

/** A book's link preview: cover on the left when we have one, then title, author and hook. */
export function bookCardSvg(c: BookCardText): string {
  const coverH = 470;
  const coverW = c.cover ? Math.round((coverH * c.cover.width) / c.cover.height) : 0;
  const x = c.cover ? 80 + coverW + 56 : 80;
  const chars = c.cover ? 22 : 30;
  const title = wrap(c.title, chars, 3);
  const hook = c.hook ? wrap(c.hook, c.cover ? 40 : 56, 3) : [];
  const parts: string[] = [];
  let y = 200;
  for (const t of title) {
    parts.push(
      `<text x="${x}" y="${y}" font-size="60" font-weight="700" fill="${color.ink}">${esc(t)}</text>`,
    );
    y += 70;
  }
  y += 6;
  parts.push(`<text x="${x}" y="${y}" font-size="32" fill="${color.muted}">${esc(c.byline)}</text>`);
  y += 56;
  for (const h of hook) {
    parts.push(
      `<text x="${x}" y="${y}" font-size="28" font-style="italic" fill="${color.ink}">${esc(h)}</text>`,
    );
    y += 38;
  }
  const cover = c.cover
    ? `<image x="80" y="80" width="${coverW}" height="${coverH}" preserveAspectRatio="xMidYMid slice" href="${c.cover.href}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${sans}">
<rect width="1200" height="630" fill="${color.paper}"/>
<rect x="40" y="40" width="1120" height="550" rx="18" fill="${color.surface}" stroke="${color.line}" stroke-width="3"/>
${cover}
<text x="${x}" y="130" font-size="26" font-family="${mono}" letter-spacing="3" fill="${color.accent}">${esc(c.kicker.toUpperCase())}</text>
${parts.join("\n")}
<text x="${x}" y="550" font-size="28" font-family="${mono}" fill="${color.ink}"><tspan fill="${color.accent}">[</tspan>ReadLitRPG<tspan fill="${color.accent}">]</tspan></text>
${c.note ? `<text x="1120" y="550" font-size="24" text-anchor="end" fill="${color.primary}">${esc(c.note)}</text>` : ""}
</svg>`;
}
