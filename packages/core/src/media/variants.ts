// Where re-encoded image variants live in the MEDIA bucket (DESIGN §15.7). A media row's `key` is a
// random prefix; each width is stored beside it, so pages can build a srcset without a lookup.

export const COVER_WIDTHS = [160, 320, 640] as const;
export type CoverWidth = (typeof COVER_WIDTHS)[number];

export const variantKey = (key: string, width: number) => `${key}/w${width}.webp`;
