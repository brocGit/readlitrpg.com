import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { appendAudit, GENESIS_HASH, verifyAuditChain, verifyAuditLog } from "../src/audit";
import { createDb, type Db } from "../src/db";
import { auditLog } from "../src/db/schema";
import { createTestD1, type TestD1 } from "../src/testing";

let d1: TestD1;
let db: Db;

beforeEach(() => {
  d1 = createTestD1();
  db = createDb(d1.asD1());
});

const admin = { type: "admin" as const, id: "owner" };

describe("audit log", () => {
  it("chains rows from genesis", async () => {
    const a = await appendAudit(db, { actor: admin, action: "settings.update", diff: { b: 1, a: 2 } });
    const b = await appendAudit(db, { actor: { type: "system" }, action: "job.run" });
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(await verifyAuditLog(db)).toMatchObject({ ok: true, checked: 2, lastSeq: 2, lastHash: b.hash });
  });

  it("detects an edited row", async () => {
    await appendAudit(db, { actor: admin, action: "a" });
    await appendAudit(db, { actor: admin, action: "b" });
    await appendAudit(db, { actor: admin, action: "c" });
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    const tampered = rows.map((r) => (r.seq === 2 ? { ...r, action: "innocent" } : r));
    expect(await verifyAuditChain(tampered)).toMatchObject({
      ok: false,
      brokenAtSeq: 2,
      problem: "hash_mismatch",
    });
  });

  it("detects a deleted row", async () => {
    for (const action of ["a", "b", "c"]) await appendAudit(db, { actor: admin, action });
    const rows = await db.select().from(auditLog).orderBy(asc(auditLog.seq));
    expect(await verifyAuditChain([rows[0], rows[2]].filter((r) => r !== undefined))).toMatchObject({
      ok: false,
      problem: "seq_gap",
    });
  });

  it("verifies incrementally from an anchor", async () => {
    await appendAudit(db, { actor: admin, action: "a" });
    const first = await verifyAuditLog(db);
    if (!first.ok) throw new Error("expected ok");
    await appendAudit(db, { actor: admin, action: "b" });
    const second = await verifyAuditLog(db, { seq: first.lastSeq, hash: first.lastHash });
    expect(second).toMatchObject({ ok: true, checked: 1, lastSeq: 2 });
  });

  it("the database refuses updates and recent deletes", async () => {
    await appendAudit(db, { actor: admin, action: "a" });
    expect(() => d1.sqlite.exec("UPDATE audit_log SET action = 'x'")).toThrow(/append-only/);
    expect(() => d1.sqlite.exec("DELETE FROM audit_log")).toThrow(/seven years/);
  });

  it("allows deleting rows past retention", () => {
    d1.sqlite.exec(
      `INSERT INTO audit_log (id, seq, actor_type, action, created_at, prev_hash, hash)
       VALUES ('old', 1, 'system', 'x', '2018-01-01T00:00:00.000Z', '${GENESIS_HASH}', 'h')`,
    );
    d1.sqlite.exec("DELETE FROM audit_log WHERE id = 'old'");
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
  });

  it("retries when another writer takes the same seq", async () => {
    // Simulate a racing writer: insert seq 2 directly after our read would have seen seq 1.
    await appendAudit(db, { actor: admin, action: "a" });
    const racing = Promise.all([
      appendAudit(db, { actor: admin, action: "b" }),
      appendAudit(db, { actor: admin, action: "c" }),
      appendAudit(db, { actor: admin, action: "d" }),
    ]);
    const rows = await racing;
    expect(new Set(rows.map((r) => r.seq))).toEqual(new Set([2, 3, 4]));
    expect(await verifyAuditLog(db)).toMatchObject({ ok: true, checked: 4 });
  });
});
