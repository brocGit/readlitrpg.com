// The console's blog forms (DESIGN §14.2, §14.7). Posts can be long, so the editor reads its own
// form rather than readForm's 20,000-character cap.

import type { PostPatch } from "@rlr/core/content";
import type { PostSource } from "@rlr/core/schema";

export const STATUS_LABEL: Record<string, string> = {
  idea: "Idea",
  drafting: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  scheduled: "Scheduled",
  published: "Published",
  unpublished: "Unpublished",
  rejected: "Rejected",
};

export async function readPostForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form)
    if (typeof value === "string") out[key] = value.slice(0, key === "body" ? 100_000 : 20_000);
  return out;
}

/** "https://… | Title" per line; anything that isn't an https URL is dropped. */
export function parseSources(text: string): PostSource[] {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const [url = "", ...rest] = line.split("|");
      const title = rest.join("|").trim();
      return { url: url.trim(), ...(title ? { title: title.slice(0, 200) } : {}) };
    })
    .filter((s) => {
      try {
        return new URL(s.url).protocol === "https:";
      } catch {
        return false;
      }
    })
    .slice(0, 20);
}

export const sourcesText = (sources: PostSource[]) =>
  sources.map((s) => (s.title ? `${s.url} | ${s.title}` : s.url)).join("\n");

export function postPatchFromForm(f: Record<string, string>): PostPatch {
  const ai = f.ai === "assisted" || f.ai === "generated" ? f.ai : "none";
  return {
    title: f.title ?? "",
    dek: f.dek ?? "",
    bodyMd: f.body ?? "",
    bylineName: f.byline ?? "",
    seoTitle: f.seo_title ?? "",
    seoDescription: f.seo_description ?? "",
    canonicalUrl: f.canonical && /^https:\/\//.test(f.canonical) ? f.canonical.slice(0, 500) : null,
    sources: parseSources(f.sources ?? ""),
    noindex: f.noindex === "on",
    aiInvolvement: ai,
    disclosure: f.disclosure ?? "",
  };
}
