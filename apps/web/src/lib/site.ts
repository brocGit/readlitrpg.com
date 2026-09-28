// Shared bits for the public entity pages (DESIGN §9.5): absolute URLs, cover images and the
// settings the read models need. Nothing here reads the session.

import { COVER_WIDTHS, siteOgKey, variantKey } from "@rlr/core/media";
import type { Settings } from "@rlr/core/settings";
import type { Cover, PageOptions } from "@rlr/core/site";
import { env } from "./runtime";

export const origin = () => env.PUBLIC_ORIGIN.replace(/\/$/, "");
export const mediaOrigin = () => (env.PUBLIC_MEDIA_ORIGIN || `${origin()}/media`).replace(/\/$/, "");
export const mediaUrl = (key: string) => `${mediaOrigin()}/${key}`;

export const pageOptions = (s: Settings): PageOptions => ({
  displayMin: s["tags.display_min"],
  minAppraisals: s["stats.display_min_appraisals"],
});

/** A responsive cover: every variant in the srcset, with the aspect ratio so nothing jumps. */
export function coverImage(cover: Cover, width: number) {
  const ratio = cover.width && cover.height ? cover.height / cover.width : 1.5;
  return {
    src: mediaUrl(variantKey(cover.key, width <= 160 ? 160 : 320)),
    srcset: COVER_WIDTHS.map((w) => `${mediaUrl(variantKey(cover.key, w))} ${w}w`).join(", "),
    sizes: `${width}px`,
    width,
    height: Math.round(width * ratio),
  };
}

/** The OG image for a cover-led page: the largest variant. */
export const coverOgUrl = (cover: Cover | null) => (cover ? mediaUrl(variantKey(cover.key, 640)) : null);

/** The site's own link preview, for pages without one of their own. */
export const siteOgUrl = () => mediaUrl(siteOgKey());

/** A daily issue's patch number, from its date: "Patch 26.09.28" (DESIGN §9.10). */
export const patchTag = (isoDate: string) => `Patch ${isoDate.slice(2, 10).replaceAll("-", ".")}`;

export const notFound = () => new Response(null, { status: 404 });
export const movedTo = (path: string) =>
  new Response(null, { status: 301, headers: { location: path, "cache-control": "public, max-age=3600" } });

/** Where links and images in posts point, for rendering an author's draft. */
export const renderEnv = () => ({ origin: origin(), mediaOrigin: mediaOrigin() });
