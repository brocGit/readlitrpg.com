// Markdown for posts (DESIGN §14.7). micromark is CommonMark and safe by default: raw HTML is
// escaped and `javascript:` links are dropped. On top of that, outbound links get the rel the post
// type needs (§14.3: guest links are `ugc nofollow`; §11.5: sponsored links are `sponsored`),
// images must be our own media, and the page keeps the only <h1>. Shortcodes stay as text here and
// are expanded at render time (shortcodes.ts), so book cards stay live.

import { micromark } from "micromark";

export type LinkPolicy = "normal" | "ugc" | "sponsored";

export interface MarkdownOptions {
  /** Our own origin; links to it (and relative links) are internal. */
  origin: string;
  /** Where our images are served from; any other image becomes its alt text. */
  mediaOrigin: string;
  links?: LinkPolicy;
}

const REL: Record<LinkPolicy, string> = {
  normal: "noopener",
  ugc: "ugc nofollow noopener",
  sponsored: "sponsored noopener",
};

const internal = (href: string, origin: string) =>
  href.startsWith("/") ? !href.startsWith("//") : href === origin || href.startsWith(`${origin}/`);

/** Render post markdown to sanitized HTML. */
export function renderMarkdown(md: string, opts: MarkdownOptions): string {
  const origin = opts.origin.replace(/\/$/, "");
  const mediaOrigin = opts.mediaOrigin.replace(/\/$/, "");
  const rel = REL[opts.links ?? "normal"];
  return (
    micromark(md.replace(/\r\n?/g, "\n"))
      // The page title is the only h1.
      .replace(/<(\/?)h1>/g, "<$1h2>")
      .replace(/<a href="([^"]*)"/g, (whole, href: string) =>
        !href ? "<a" : internal(href, origin) ? whole : `${whole} rel="${rel}"`,
      )
      // micromark drops unsafe protocols to an empty href; don't leave dead links behind.
      .replace(/<a>([\s\S]*?)<\/a>/g, "$1")
      .replace(/<img src="([^"]*)" alt="([^"]*)"( title="[^"]*")? \/>/g, (_w, src: string, alt: string) =>
        src.startsWith(`${mediaOrigin}/`) || src.startsWith("/media/")
          ? `<img src="${src}" alt="${alt}" loading="lazy" />`
          : alt,
      )
  );
}

/** Plain text of some markdown (for descriptions, feeds and length checks). */
export function markdownText(md: string): string {
  return md
    .replace(/\[\[[^\]]{1,300}\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(md: string): number {
  const text = markdownText(md);
  return text ? text.split(" ").length : 0;
}
