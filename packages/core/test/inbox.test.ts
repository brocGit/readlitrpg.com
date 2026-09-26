import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db";
import { decideInboxItem, listOpenInbox, openInboxItem } from "../src/inbox";
import { createTestD1 } from "../src/testing";

let db: Db;
beforeEach(() => {
  db = createDb(createTestD1().asD1());
});

describe("inbox", () => {
  it("dedupes alerts by key", async () => {
    const first = await openInboxItem(db, { type: "dlq_message", title: "Failed", dedupeKey: "dlq:x:1" });
    const second = await openInboxItem(db, { type: "dlq_message", title: "Failed", dedupeKey: "dlq:x:1" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await listOpenInbox(db)).toHaveLength(1);
  });

  it("orders by priority and closes once", async () => {
    await openInboxItem(db, { type: "a", title: "low", priority: 10 });
    const high = await openInboxItem(db, { type: "b", title: "high", priority: 100 });
    const open = await listOpenInbox(db);
    expect(open.map((i) => i.title)).toEqual(["high", "low"]);
    expect(await decideInboxItem(db, high?.id ?? "", { status: "resolved", decidedBy: "owner" })).toBe(true);
    expect(await decideInboxItem(db, high?.id ?? "", { status: "resolved", decidedBy: "owner" })).toBe(false);
    expect(await listOpenInbox(db)).toHaveLength(1);
  });
});
