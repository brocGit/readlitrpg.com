import { ingestBook } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { claimItems, pushProposals, startRun } from "@rlr/core/editorial";
import { openInboxItem } from "@rlr/core/inbox";
import { bookEmbeddings, books, editorialQueue, inboxItems } from "@rlr/core/schema";
import { defaultSettings } from "@rlr/core/settings";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildQueue, checkCitations, watchdog } from "../src/jobs/editorial";
import type { JobContext } from "../src/jobs/types";
import { updateVectors } from "../src/jobs/vectors";
import worker from "../src/worker";

let db: Db;
let ctx: JobContext;
const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1.asD1());
  await syncTaxonomy(db);
  ctx = {
    db,
    log,
    now: new Date(),
    env: { DB: d1.asD1(), CONFIG: new TestKV() } as unknown as Env,
  };
});

const seed = { source: "ai" as const, origin: "ai_seed" as const, fuzzyMin: 0.6, crowdMinVotes: 8 };

describe("editorial.queue", () => {
  it("queues unclassified books and unconfirmed seeds once", async () => {
    const { bookId } = await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    await db.update(books).set({ enrichStatus: "no_match" }).where(eq(books.id, bookId));
    expect(await buildQueue(ctx)).toBe(2);
    expect(await buildQueue(ctx)).toBe(0);
    const kinds = (await db.select().from(editorialQueue)).map((q) => q.kind).sort();
    expect(kinds).toEqual(["classify", "research"]);
  });
});

describe("editorial.watchdog", () => {
  it("puts expired claims back in the queue", async () => {
    await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    await buildQueue(ctx);
    const run = await startRun(db, { kind: "manual" });
    await claimItems(db, {
      runId: run.id,
      kinds: ["classify"],
      limit: 5,
      claimHours: 1,
      now: new Date(Date.now() - 2 * 3_600_000),
    });
    expect(await watchdog(ctx)).toBe(1);
    const [row] = await db.select().from(editorialQueue);
    expect(row?.status).toBe("queued");
  });
});

describe("editorial.citations", () => {
  it("confirms a researched book when the cited page names it", async () => {
    const { bookId } = await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    await db.update(books).set({ enrichStatus: "no_match" }).where(eq(books.id, bookId));
    await buildQueue(ctx);
    const run = await startRun(db, { kind: "manual" });
    const [item] = await claimItems(db, { runId: run.id, kinds: ["research"], limit: 1, claimHours: 3 });
    await pushProposals({ db, runId: run.id, settings: defaultSettings() }, [
      {
        kind: "research",
        item_id: item?.id,
        book_id: bookId,
        verdict: "confirmed",
        confidence: "high",
        sources: [{ url: "https://wightbooks.com/books" }],
      },
    ]);
    ctx.fetch = (async () => new Response("<p>Unsouled by Will Wight</p>")) as unknown as typeof fetch;
    expect(await checkCitations(ctx)).toBe(1);
    const [book] = await db.select().from(books).where(eq(books.id, bookId));
    expect(book?.confirmedAt).toBeTruthy();
  });
});

describe("vectors.update", () => {
  it("does nothing without Workers AI credentials", async () => {
    await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    expect(await updateVectors(ctx)).toBe(0);
  });

  it("embeds books through the REST API when configured", async () => {
    await ingestBook(db, { title: "Unsouled", authors: [{ name: "Will Wight" }] }, seed);
    ctx.env = { ...ctx.env, CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", CF_API_TOKEN: "t" } as Env;
    ctx.fetch = (async (_url: string, init: RequestInit) => {
      const texts = (JSON.parse(String(init.body)) as { text: string[] }).text;
      return Response.json({ result: { data: texts.map(() => Array(768).fill(0.5)) } });
    }) as unknown as typeof fetch;
    expect(await updateVectors(ctx)).toBe(1);
    expect(await db.select().from(bookEmbeddings)).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  it("runs due inbox defaults", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await openInboxItem(db, {
      type: "tag_check",
      title: "Check tags",
      defaultAction: "approve",
      defaultActionAt: new Date(Date.now() - 1000).toISOString(),
    });
    const env = { ...ctx.env, Q_JOBS: { send: async () => ({}) } } as unknown as Env;
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController, env, {
      waitUntil: (p: Promise<unknown>) => p,
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    const [item] = await db.select().from(inboxItems);
    expect(item?.status).toBe("auto_approved");
  });
});
