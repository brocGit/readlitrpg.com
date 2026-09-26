// Append-only audit log with a hash chain (DESIGN §15.11). Each row stores
// hash = sha256(prev_hash + "\n" + canonical JSON of the row), so editing or deleting a row in the
// middle breaks every hash after it. The database refuses UPDATE outright (see the migration).

import { asc, desc, gt } from "drizzle-orm";
import { sha256Hex } from "../crypto";
import { type Db, isUniqueViolation } from "../db";
import { type ActorType, auditLog } from "../db/schema";
import { ulid } from "../ids";
import { nowIso } from "../time";

export const GENESIS_HASH = "0".repeat(64);

/**
 * Every row is kept seven years (money records need that long). Deleting only some rows would break
 * the chain, so retention removes whole prefixes: everything older than this, oldest first.
 */
export const AUDIT_RETENTION_DAYS = 2557;
const MAX_ATTEMPTS = 5;

export interface AuditActor {
  type: ActorType;
  id?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  subjectType?: string | null;
  subjectId?: string | null;
  diff?: unknown;
  ipHash?: string | null;
  requestId?: string | null;
}

export type AuditRow = typeof auditLog.$inferSelect;

/** The fields covered by the hash, in a fixed order. */
function hashInput(row: Omit<AuditRow, "hash">): string {
  return `${row.prevHash}\n${canonicalJson([
    row.id,
    row.seq,
    row.actorType,
    row.actorId,
    row.action,
    row.subjectType,
    row.subjectId,
    row.diff ?? null,
    row.ipHash,
    row.requestId,
    row.createdAt,
  ])}`;
}

export async function computeAuditHash(row: Omit<AuditRow, "hash">): Promise<string> {
  return sha256Hex(hashInput(row));
}

export async function appendAudit(db: Db, entry: AuditEntry): Promise<AuditRow> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [last] = await db
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const base: Omit<AuditRow, "hash"> = {
      id: ulid(),
      seq: (last?.seq ?? 0) + 1,
      actorType: entry.actor.type,
      actorId: entry.actor.id ?? null,
      action: entry.action,
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId ?? null,
      diff: entry.diff === undefined ? null : (JSON.parse(canonicalJson(entry.diff)) as unknown),
      ipHash: entry.ipHash ?? null,
      requestId: entry.requestId ?? null,
      createdAt: nowIso(),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const row: AuditRow = { ...base, hash: await computeAuditHash(base) };
    try {
      await db.insert(auditLog).values(row);
      return row;
    } catch (error) {
      // Another writer took this seq between our read and write. Re-read the tip and try again.
      if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new Error("appendAudit: exhausted retries");
}

export type ChainCheck =
  | { ok: true; checked: number; lastSeq: number; lastHash: string }
  | {
      ok: false;
      checked: number;
      brokenAtSeq: number;
      problem: "hash_mismatch" | "prev_mismatch" | "seq_gap";
    };

/**
 * Verify rows in seq order. `anchor` is the last verified (seq, hash), so a nightly job can check
 * only new rows, and the chain can start after rows removed by the retention policy.
 */
export async function verifyAuditChain(
  rows: AuditRow[],
  anchor: { seq: number; hash: string } | null = null,
): Promise<ChainCheck> {
  let prevSeq = anchor?.seq ?? null;
  let prevHash = anchor?.hash ?? null;
  let checked = 0;
  for (const row of rows) {
    if (prevSeq !== null && row.seq !== prevSeq + 1) {
      return { ok: false, checked, brokenAtSeq: row.seq, problem: "seq_gap" };
    }
    // Without an anchor, the first row's prev_hash is taken on trust (genesis or retention cut).
    if (prevHash !== null && row.prevHash !== prevHash) {
      return { ok: false, checked, brokenAtSeq: row.seq, problem: "prev_mismatch" };
    }
    const { hash, ...rest } = row;
    if ((await computeAuditHash(rest)) !== hash) {
      return { ok: false, checked, brokenAtSeq: row.seq, problem: "hash_mismatch" };
    }
    prevSeq = row.seq;
    prevHash = hash;
    checked++;
  }
  return { ok: true, checked, lastSeq: prevSeq ?? 0, lastHash: prevHash ?? GENESIS_HASH };
}

/** Verify the chain from `anchor` onward in pages, reading at most `pageSize` rows per query. */
export async function verifyAuditLog(
  db: Db,
  anchor: { seq: number; hash: string } | null = null,
  pageSize = 500,
): Promise<ChainCheck> {
  let cursor = anchor;
  let total = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(gt(auditLog.seq, cursor?.seq ?? 0))
      .orderBy(asc(auditLog.seq))
      .limit(pageSize);
    if (rows.length === 0) {
      return { ok: true, checked: total, lastSeq: cursor?.seq ?? 0, lastHash: cursor?.hash ?? GENESIS_HASH };
    }
    const result = await verifyAuditChain(rows, cursor);
    total += result.checked;
    if (!result.ok) return { ...result, checked: total };
    cursor = { seq: result.lastSeq, hash: result.lastHash };
  }
}

/** JSON with object keys sorted, so the same value always hashes the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
