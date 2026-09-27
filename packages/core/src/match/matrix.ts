// The feature matrix (DESIGN §7.8): every matchable book's dials, stats, tags, hard attributes,
// quality prior and a reduced embedding, packed into one binary blob. The jobs Worker (or the
// console) builds it from D1 and writes it to KV under a version; the web Worker keeps the current
// version in isolate memory and scores every book per request in a few milliseconds. It is never
// sent to browsers.

import { CONTENT_FLAGS, DIALS, STAT_KEYS, STATS, TAGS } from "../taxonomy";

export const DIAL_ORDER: readonly string[] = DIALS.map((d) => d.key);
export const STAT_ORDER: readonly string[] = STATS.map((s) => s.key);
export const EMB_DIMS = 64;
export const UNKNOWN = 255;

/** Bit layout of `attrs` (one Uint32 per book). */
export const ATTR = {
  haremShift: 0, // 3 bits: 0 none, 1 implied, 2 harem, 3 reverse_harem, 4 unknown
  flagsShift: 3, // 8 bits, CONTENT_FLAGS order
  formatsShift: 11, // 4 bits: ebook, audiobook, print, serial
  seriesStatusShift: 15, // 3 bits: 0 unknown/standalone, 1 ongoing, 2 complete, 3 hiatus, 4 no_recent_releases
  aiShift: 18, // 2 bits: 0 unknown, 1 human, 2 ai_assisted, 3 ai_generated
  hasEmbedding: 1 << 20,
  inScopeShift: 21, // 2 bits: 0 yes, 1 borderline, 2 no, 3 unknown
  kindleUnlimited: 1 << 23,
  crunchShift: 24, // 3 bits, 7 unknown
  romanceShift: 27, // 3 bits, 7 unknown
} as const;

export const HAREM_CODES = ["none", "implied", "harem", "reverse_harem", "unknown"] as const;
export const FORMAT_BITS = ["ebook", "audiobook", "print", "serial"] as const;
export const SERIES_STATUS_CODES = [
  "unknown",
  "ongoing",
  "complete",
  "hiatus",
  "no_recent_releases",
] as const;
export const AI_CODES = ["unknown", "human", "ai_assisted", "ai_generated"] as const;
export const SCOPE_CODES = ["yes", "borderline", "no", "unknown"] as const;

export interface FeatureMatrix {
  version: string;
  builtAt: string;
  n: number;
  dials: readonly string[];
  stats: readonly string[];
  tags: readonly string[];
  ids: string[];
  slugs: string[];
  /** Series ids; `seriesIdx` points into this (-1 = standalone). */
  series: string[];
  seriesIdx: Int32Array;
  /** NaN when the book has no position. */
  seriesPos: Float32Array;
  authors: string[];
  authorOff: Uint32Array;
  authorIdx: Uint32Array;
  /** value × 10 (0–100), UNKNOWN when missing; confidence × 100. Row-major, n × dials. */
  dialVal: Uint8Array;
  dialConf: Uint8Array;
  statVal: Uint8Array;
  statConf: Uint8Array;
  /** Bit i set: stat i may be shown publicly (§6.7), so it can drive sorting and heads-ups. */
  statPublic: Uint16Array;
  tagOff: Uint32Array;
  tagIdx: Uint16Array;
  /** score × 100 */
  tagScore: Uint8Array;
  attrs: Uint32Array;
  /** 0–100 */
  quality: Uint8Array;
  /** First publication year, 0 when unknown. */
  year: Uint16Array;
  /** Unit vectors × 127, n × EMB_DIMS; zeros when the book has no embedding. */
  emb: Int8Array;
}

// ---------------------------------------------------------------------------------------------
// Attribute helpers

export const harem = (m: FeatureMatrix, i: number) =>
  HAREM_CODES[((m.attrs[i] ?? 0) >> ATTR.haremShift) & 7] ?? "unknown";
export const hasFlag = (m: FeatureMatrix, i: number, flag: string) => {
  const bit = CONTENT_FLAGS.indexOf(flag);
  return bit >= 0 && (((m.attrs[i] ?? 0) >> (ATTR.flagsShift + bit)) & 1) === 1;
};
export const hasFormat = (m: FeatureMatrix, i: number, format: (typeof FORMAT_BITS)[number]) =>
  (((m.attrs[i] ?? 0) >> (ATTR.formatsShift + FORMAT_BITS.indexOf(format))) & 1) === 1;
export const seriesStatus = (m: FeatureMatrix, i: number) =>
  SERIES_STATUS_CODES[((m.attrs[i] ?? 0) >> ATTR.seriesStatusShift) & 7] ?? "unknown";
export const aiUse = (m: FeatureMatrix, i: number) =>
  AI_CODES[((m.attrs[i] ?? 0) >> ATTR.aiShift) & 3] ?? "unknown";
export const inScope = (m: FeatureMatrix, i: number) =>
  SCOPE_CODES[((m.attrs[i] ?? 0) >> ATTR.inScopeShift) & 3] ?? "unknown";
export const hasEmbedding = (m: FeatureMatrix, i: number) => ((m.attrs[i] ?? 0) & ATTR.hasEmbedding) !== 0;
export const isKu = (m: FeatureMatrix, i: number) => ((m.attrs[i] ?? 0) & ATTR.kindleUnlimited) !== 0;
export const crunchLevel = (m: FeatureMatrix, i: number) => {
  const v = ((m.attrs[i] ?? 0) >> ATTR.crunchShift) & 7;
  return v === 7 ? null : v;
};
export const romanceLevel = (m: FeatureMatrix, i: number) => {
  const v = ((m.attrs[i] ?? 0) >> ATTR.romanceShift) & 7;
  return v === 7 ? null : v;
};

/** Dial value 0–10 (null when unknown) and its confidence 0–1. */
export function dial(m: FeatureMatrix, i: number, d: number): { value: number | null; conf: number } {
  const k = i * m.dials.length + d;
  const raw = m.dialVal[k] ?? UNKNOWN;
  return raw === UNKNOWN ? { value: null, conf: 0 } : { value: raw / 10, conf: (m.dialConf[k] ?? 0) / 100 };
}

export function stat(
  m: FeatureMatrix,
  i: number,
  s: number,
): { value: number | null; conf: number; public: boolean } {
  const k = i * m.stats.length + s;
  const raw = m.statVal[k] ?? UNKNOWN;
  const isPublic = (((m.statPublic[i] ?? 0) >> s) & 1) === 1;
  return raw === UNKNOWN
    ? { value: null, conf: 0, public: false }
    : { value: raw / 10, conf: (m.statConf[k] ?? 0) / 100, public: isPublic };
}

/** A book's tags as tag index → score (0–1). */
export function tagsOf(m: FeatureMatrix, i: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = m.tagOff[i] ?? 0; k < (m.tagOff[i + 1] ?? 0); k++)
    out.set(m.tagIdx[k] ?? 0, (m.tagScore[k] ?? 0) / 100);
  return out;
}

export function authorsOf(m: FeatureMatrix, i: number): number[] {
  const out: number[] = [];
  for (let k = m.authorOff[i] ?? 0; k < (m.authorOff[i + 1] ?? 0); k++) out.push(m.authorIdx[k] ?? 0);
  return out;
}

export function embeddingOf(m: FeatureMatrix, i: number): Int8Array | null {
  return hasEmbedding(m, i) ? m.emb.subarray(i * EMB_DIMS, (i + 1) * EMB_DIMS) : null;
}

export function indexOfBook(m: FeatureMatrix): Map<string, number> {
  const map = new Map<string, number>();
  for (const [i, id] of m.ids.entries()) map.set(id, i);
  for (const [i, slug] of m.slugs.entries()) map.set(slug, i);
  return map;
}

// ---------------------------------------------------------------------------------------------
// Random projection: 768-d embeddings → 64-d unit vectors (Johnson–Lindenstrauss). Deterministic,
// so every build projects the same way; far cheaper than PCA in a Worker.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let projection: Float32Array | null = null;
function projectionMatrix(inDims: number): Float32Array {
  if (projection && projection.length === EMB_DIMS * inDims) return projection;
  const rand = mulberry32(0x5eed_1a7e);
  const p = new Float32Array(EMB_DIMS * inDims);
  for (let k = 0; k < p.length; k += 2) {
    // Box–Muller: two standard normals per pair of uniforms.
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    p[k] = r * Math.cos(2 * Math.PI * v);
    if (k + 1 < p.length) p[k + 1] = r * Math.sin(2 * Math.PI * v);
  }
  projection = p;
  return p;
}

/** Project and quantize one embedding to EMB_DIMS signed bytes (a unit vector × 127). */
export function reduceEmbedding(v: ArrayLike<number>): Int8Array {
  const p = projectionMatrix(v.length);
  const out = new Float32Array(EMB_DIMS);
  for (let r = 0; r < EMB_DIMS; r++) {
    let sum = 0;
    const row = r * v.length;
    for (let c = 0; c < v.length; c++) sum += (p[row + c] ?? 0) * (v[c] ?? 0);
    out[r] = sum;
  }
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const q = new Int8Array(EMB_DIMS);
  for (let r = 0; r < EMB_DIMS; r++)
    q[r] = Math.max(-127, Math.min(127, Math.round(((out[r] ?? 0) / norm) * 127)));
  return q;
}

/** Cosine of two quantized unit vectors. */
export function cosineI8(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------------------------------------------------------------------------------------------
// Assembling a matrix from plain rows (the D1 builder and tests both use this)

export interface MatrixBookInput {
  id: string;
  slug: string;
  seriesId: string | null;
  seriesPosition: number | null;
  seriesStatus: string | null;
  authorIds: string[];
  harem: string;
  contentFlags: string[];
  formats: string[];
  kindleUnlimited: boolean;
  aiUse: string;
  inScope: string;
  crunchLevel: number | null;
  romanceLevel: number | null;
  year: number | null;
  quality: number;
  /** key → value/confidence; stats also carry `public`. */
  dials: Record<string, { value: number | null; confidence: number | null }>;
  stats: Record<string, { value: number | null; confidence: number | null; public: boolean }>;
  tags: Record<string, number>;
  embedding: ArrayLike<number> | null;
}

const idxOf = <T>(list: readonly T[], value: T, fallback: number) => {
  const i = list.indexOf(value);
  return i < 0 ? fallback : i;
};

export function assembleMatrix(
  books: MatrixBookInput[],
  version: string,
  builtAt = new Date().toISOString(),
): FeatureMatrix {
  const n = books.length;
  const dials = DIAL_ORDER;
  const stats = STAT_ORDER;
  const tagSlugs = TAGS.map((t) => t.slug);
  const tagIndex = new Map(tagSlugs.map((s, i) => [s, i]));
  const series: string[] = [];
  const seriesMap = new Map<string, number>();
  const authors: string[] = [];
  const authorMap = new Map<string, number>();
  const seriesIdx = new Int32Array(n);
  const seriesPos = new Float32Array(n);
  const authorOff = new Uint32Array(n + 1);
  const authorList: number[] = [];
  const dialVal = new Uint8Array(n * dials.length).fill(UNKNOWN);
  const dialConf = new Uint8Array(n * dials.length);
  const statVal = new Uint8Array(n * stats.length).fill(UNKNOWN);
  const statConf = new Uint8Array(n * stats.length);
  const statPublic = new Uint16Array(n);
  const tagOff = new Uint32Array(n + 1);
  const tagIdxList: number[] = [];
  const tagScoreList: number[] = [];
  const attrs = new Uint32Array(n);
  const quality = new Uint8Array(n);
  const year = new Uint16Array(n);
  const emb = new Int8Array(n * EMB_DIMS);

  books.forEach((b, i) => {
    if (b.seriesId) {
      let s = seriesMap.get(b.seriesId);
      if (s === undefined) {
        s = series.push(b.seriesId) - 1;
        seriesMap.set(b.seriesId, s);
      }
      seriesIdx[i] = s;
    } else seriesIdx[i] = -1;
    seriesPos[i] = b.seriesPosition ?? Number.NaN;
    authorOff[i] = authorList.length;
    for (const a of b.authorIds) {
      let k = authorMap.get(a);
      if (k === undefined) {
        k = authors.push(a) - 1;
        authorMap.set(a, k);
      }
      authorList.push(k);
    }
    dials.forEach((key, d) => {
      const v = b.dials[key];
      if (v && v.value !== null) {
        dialVal[i * dials.length + d] = Math.round(Math.min(10, Math.max(0, v.value)) * 10);
        dialConf[i * dials.length + d] = Math.round(Math.min(1, Math.max(0, v.confidence ?? 0.45)) * 100);
      }
    });
    stats.forEach((key, s) => {
      const v = b.stats[key];
      if (v && v.value !== null) {
        statVal[i * stats.length + s] = Math.round(Math.min(10, Math.max(0, v.value)) * 10);
        // Hidden judgment stats count at low weight (§7.8).
        const conf = (v.confidence ?? 0.45) * (v.public ? 1 : 0.5);
        statConf[i * stats.length + s] = Math.round(Math.min(1, conf) * 100);
        if (v.public) statPublic[i] = (statPublic[i] ?? 0) | (1 << s);
      }
    });
    tagOff[i] = tagIdxList.length;
    for (const [slug, score] of Object.entries(b.tags)) {
      const t = tagIndex.get(slug);
      if (t === undefined || score < 0.2) continue;
      tagIdxList.push(t);
      tagScoreList.push(Math.round(Math.min(1, score) * 100));
    }
    let a = 0;
    a |= idxOf(HAREM_CODES, b.harem as (typeof HAREM_CODES)[number], 4) << ATTR.haremShift;
    CONTENT_FLAGS.forEach((f, bit) => {
      if (b.contentFlags.includes(f)) a |= 1 << (ATTR.flagsShift + bit);
    });
    const formats = new Set(b.formats.map((f) => (f === "paperback" || f === "hardcover" ? "print" : f)));
    FORMAT_BITS.forEach((f, bit) => {
      if (formats.has(f)) a |= 1 << (ATTR.formatsShift + bit);
    });
    a |=
      idxOf(SERIES_STATUS_CODES, (b.seriesStatus ?? "unknown") as (typeof SERIES_STATUS_CODES)[number], 0) <<
      ATTR.seriesStatusShift;
    const ai = b.aiUse === "ai_assisted" ? 2 : b.aiUse === "ai_generated" ? 3 : b.aiUse === "human" ? 1 : 0;
    a |= ai << ATTR.aiShift;
    if (b.embedding) {
      a |= ATTR.hasEmbedding;
      emb.set(reduceEmbedding(b.embedding), i * EMB_DIMS);
    }
    a |= idxOf(SCOPE_CODES, b.inScope as (typeof SCOPE_CODES)[number], 3) << ATTR.inScopeShift;
    if (b.kindleUnlimited) a |= ATTR.kindleUnlimited;
    a |= (b.crunchLevel ?? 7) << ATTR.crunchShift;
    a |= (b.romanceLevel ?? 7) << ATTR.romanceShift;
    attrs[i] = a >>> 0;
    quality[i] = Math.round(Math.min(1, Math.max(0, b.quality)) * 100);
    year[i] = b.year ?? 0;
  });
  authorOff[n] = authorList.length;
  tagOff[n] = tagIdxList.length;

  return {
    version,
    builtAt,
    n,
    dials,
    stats,
    tags: tagSlugs,
    ids: books.map((b) => b.id),
    slugs: books.map((b) => b.slug),
    series,
    seriesIdx,
    seriesPos,
    authors,
    authorOff,
    authorIdx: Uint32Array.from(authorList),
    dialVal,
    dialConf,
    statVal,
    statConf,
    statPublic,
    tagOff,
    tagIdx: Uint16Array.from(tagIdxList),
    tagScore: Uint8Array.from(tagScoreList),
    attrs,
    quality,
    year,
    emb,
  };
}

// ---------------------------------------------------------------------------------------------
// Binary encoding: "RLRM", a JSON header, then 8-byte aligned typed arrays.

const MAGIC = 0x4d524c52; // "RLRM" little-endian
const FORMAT_VERSION = 1;

type ArrayField =
  | "seriesIdx"
  | "seriesPos"
  | "authorOff"
  | "authorIdx"
  | "dialVal"
  | "dialConf"
  | "statVal"
  | "statConf"
  | "statPublic"
  | "tagOff"
  | "tagIdx"
  | "tagScore"
  | "attrs"
  | "quality"
  | "year"
  | "emb";

const ARRAY_FIELDS: {
  name: ArrayField;
  ctor: {
    new (buffer: ArrayBuffer, offset: number, length: number): ArrayLike<number>;
    BYTES_PER_ELEMENT: number;
  };
}[] = [
  { name: "seriesIdx", ctor: Int32Array },
  { name: "seriesPos", ctor: Float32Array },
  { name: "authorOff", ctor: Uint32Array },
  { name: "authorIdx", ctor: Uint32Array },
  { name: "dialVal", ctor: Uint8Array },
  { name: "dialConf", ctor: Uint8Array },
  { name: "statVal", ctor: Uint8Array },
  { name: "statConf", ctor: Uint8Array },
  { name: "statPublic", ctor: Uint16Array },
  { name: "tagOff", ctor: Uint32Array },
  { name: "tagIdx", ctor: Uint16Array },
  { name: "tagScore", ctor: Uint8Array },
  { name: "attrs", ctor: Uint32Array },
  { name: "quality", ctor: Uint8Array },
  { name: "year", ctor: Uint16Array },
  { name: "emb", ctor: Int8Array },
];

interface Header {
  format: number;
  version: string;
  builtAt: string;
  n: number;
  dials: readonly string[];
  stats: readonly string[];
  tags: readonly string[];
  ids: string[];
  slugs: string[];
  series: string[];
  authors: string[];
  arrays: Record<string, { offset: number; length: number }>;
}

const align8 = (n: number) => (n + 7) & ~7;

export function encodeMatrix(m: FeatureMatrix): ArrayBuffer {
  const arrays: Header["arrays"] = {};
  let offset = 0;
  for (const f of ARRAY_FIELDS) {
    const arr = m[f.name] as unknown as ArrayBufferView & { length: number };
    arrays[f.name] = { offset, length: arr.length };
    offset = align8(offset + arr.byteLength);
  }
  const header: Header = {
    format: FORMAT_VERSION,
    version: m.version,
    builtAt: m.builtAt,
    n: m.n,
    dials: m.dials,
    stats: m.stats,
    tags: m.tags,
    ids: m.ids,
    slugs: m.slugs,
    series: m.series,
    authors: m.authors,
    arrays,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = align8(12 + headerBytes.length);
  const buffer = new ArrayBuffer(dataStart + offset);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.length, true);
  new Uint8Array(buffer, 12, headerBytes.length).set(headerBytes);
  for (const f of ARRAY_FIELDS) {
    const arr = m[f.name] as unknown as ArrayBufferView;
    const at = arrays[f.name]?.offset ?? 0;
    new Uint8Array(buffer, dataStart + at, arr.byteLength).set(
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
    );
  }
  return buffer;
}

export function decodeMatrix(buffer: ArrayBuffer): FeatureMatrix {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a feature matrix");
  if (view.getUint32(4, true) !== FORMAT_VERSION) throw new Error("unsupported feature matrix format");
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength))) as Header;
  const dataStart = align8(12 + headerLength);
  const out: Record<string, unknown> = {
    version: header.version,
    builtAt: header.builtAt,
    n: header.n,
    dials: header.dials,
    stats: header.stats,
    tags: header.tags,
    ids: header.ids,
    slugs: header.slugs,
    series: header.series,
    authors: header.authors,
  };
  for (const f of ARRAY_FIELDS) {
    const meta = header.arrays[f.name];
    if (!meta) throw new Error(`feature matrix is missing ${f.name}`);
    out[f.name] = new f.ctor(buffer, dataStart + meta.offset, meta.length);
  }
  return out as unknown as FeatureMatrix;
}

/** The dial and stat keys this build knows, for validating inputs. */
export const MATCH_KEYS = { dials: new Set(DIAL_ORDER), stats: STAT_KEYS };
