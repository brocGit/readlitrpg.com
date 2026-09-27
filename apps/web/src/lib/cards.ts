// Share cards (DESIGN §9.1, QUIZZES §3.2): a quiz result or a reader class as a 1200×630 SVG in
// the brand's colors. Text only, generated per request and cached with the URL. PNG versions for
// platforms that don't show SVG come with M4's media pipeline.

import { color, font } from "@rlr/ui/tokens";

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
  for (const l of lines) {
    parts.push(
      `<text x="80" y="${y}" font-size="28" font-family="${font.system}" fill="${color.primary}">${esc(l)}</text>`,
    );
    y += 38;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${font.body}">
<rect width="1200" height="630" fill="${color.paper}"/>
<rect x="40" y="40" width="1120" height="550" rx="18" fill="${color.surface}" stroke="${color.line}" stroke-width="3"/>
<text x="80" y="140" font-size="30" font-family="${font.system}" letter-spacing="3" fill="${color.accent}">${esc(c.kicker.toUpperCase())}</text>
${parts.join("\n")}
<text x="80" y="550" font-size="28" font-family="${font.system}" fill="${color.ink}"><tspan fill="${color.accent}">[</tspan>ReadLitRPG<tspan fill="${color.accent}">]</tspan></text>
<text x="1120" y="550" font-size="24" text-anchor="end" fill="${color.muted}">${esc(c.footer ?? "readlitrpg.com")}</text>
</svg>`;
}

export function svgResponse(svg: string, maxAge = 86_400): Response {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      // An SVG opened directly must not run anything.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
