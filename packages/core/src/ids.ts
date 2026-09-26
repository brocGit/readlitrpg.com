// ULIDs: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (DESIGN §5.1).
// Sortable by creation time and unguessable. Stored as TEXT.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: invalid timestamp ${now}`);
  }
  let time = "";
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 16 base32 chars need 80 bits; draw 16 bytes and use the low 5 bits of each.
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LEN));
  let random = "";
  for (const b of bytes) random += ALPHABET.charAt(b & 31);
  return time + random;
}

export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`not a ULID: ${id}`);
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
