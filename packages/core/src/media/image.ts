// Image checks before anything is stored (DESIGN §15.7): the type from its magic bytes (never the
// file name or a header), its dimensions from the image header, size and aspect limits. JPEG, PNG
// and WebP only: no SVG, GIF or HEIC.

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export class MediaError extends Error {}

export function sniff(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b))
    return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) =>
  (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);

/** Width and height from the image header, or null when the header can't be read. */
export function dimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 24) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Start-of-frame markers carry the size; C4 (DHT), C8 and CC (arithmetic coding tables) don't.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
      }
      i += 2 + u16be(bytes, i + 2);
    }
    return null;
  }
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 " && bytes.length >= 30)
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b = bytes;
    const width = 1 + ((((b[22] ?? 0) & 0x3f) << 8) | (b[21] ?? 0));
    const height = 1 + ((((b[24] ?? 0) & 0x0f) << 10) | ((b[23] ?? 0) << 2) | (((b[22] ?? 0) & 0xc0) >> 6));
    return { width, height };
  }
  if (chunk === "VP8X" && bytes.length >= 30)
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  return null;
}

export interface ImageRules {
  maxBytes: number;
  maxSide: number;
  minWidth: number;
  minHeight: number;
  /** Height ÷ width limits, for covers. */
  ratio?: [number, number];
}

/** Uploaded covers (DESIGN §15.7): at least 600×900, between 1:1.3 and 1:1.8. */
export const UPLOAD_COVER_RULES: ImageRules = {
  maxBytes: 10_000_000,
  maxSide: 6000,
  minWidth: 600,
  minHeight: 900,
  ratio: [1.3, 1.8],
};

/** Covers from Open Library are often smaller; anything readable as a thumbnail will do. */
export const FETCHED_COVER_RULES: ImageRules = {
  maxBytes: 3_000_000,
  maxSide: 6000,
  minWidth: 180,
  minHeight: 260,
  ratio: [1.2, 1.9],
};

export interface CheckedImage {
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
}

export function checkImage(bytes: Uint8Array, rules: ImageRules): CheckedImage {
  if (bytes.length === 0) throw new MediaError("the file is empty");
  if (bytes.length > rules.maxBytes)
    throw new MediaError(`the file is over ${Math.round(rules.maxBytes / 1_000_000)} MB`);
  const mime = sniff(bytes);
  if (!mime) throw new MediaError("only JPEG, PNG and WebP images are accepted");
  const size = dimensions(bytes, mime);
  if (!size || size.width === 0 || size.height === 0) throw new MediaError("the image size can't be read");
  if (size.width > rules.maxSide || size.height > rules.maxSide)
    throw new MediaError(`images can be at most ${rules.maxSide} pixels on a side`);
  if (size.width < rules.minWidth || size.height < rules.minHeight)
    throw new MediaError(`covers need to be at least ${rules.minWidth}×${rules.minHeight}`);
  if (rules.ratio) {
    const r = size.height / size.width;
    if (r < rules.ratio[0] || r > rules.ratio[1])
      throw new MediaError("that doesn't have a book cover's shape");
  }
  return { mime, ...size, bytes: bytes.length };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
