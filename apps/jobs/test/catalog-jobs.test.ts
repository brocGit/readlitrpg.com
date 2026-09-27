import { createImport, ingestBook, parseCatalogCsv } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { books, jobRuns, tags } from "@rlr/core/schema";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1, TestKV } from "@rlr/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichCatalog } from "../src/jobs/enrich";
import { importCatalog } from "../src/jobs/import";
import { syncTaxonomyJob } from "../src/jobs/taxonomy-sync";
import type { JobContext } from "../src/jobs/types";

class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown) {
    this.sent.push(body);
  }
}

let db: Db;
let ctx: JobContext & { env: Env & { Q_JOBS: FakeQueue; CONFIG: TestKV } };
const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

beforeEach(() => {
  const d1 = createTestD1();
  db = createDb(d1.asD1());
  ctx = {
    db,
    log,
    now: new Date(),
    pause: async () => {},
    env: { DB: d1.asD1(), CONFIG: new TestKV(), Q_JOBS: new FakeQueue() } as unknown as Env & {
      Q_JOBS: FakeQueue;
      CONFIG: TestKV;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe("taxonomy.sync", () => {
  it("syncs once, then does nothing until the YAML changes", async () => {
    expect(await syncTaxonomyJob(ctx)).toBeGreaterThan(100);
    expect(await syncTaxonomyJob(ctx)).toBe(0);
    expect((await db.select().from(tags)).length).toBeGreaterThan(100);
  });
});

describe("catalog.import", () => {
  it("processes a chunk and queues the next run while rows remain", async () => {
    await syncTaxonomy(db);
    const rows = parseCatalogCsv(
      ["title,authors", ...Array.from({ length: 25 }, (_, i) => `Book ${i + 1},Author ${i}`)].join("\n"),
    ).rows;
    await createImport(db, {
      kind: "csv",
      filename: "big.csv",
      fieldSource: "admin",
      origin: "admin",
      createdBy: "owner",
      rows,
    });
    expect(await importCatalog(ctx)).toBe(20); // import.chunk_size default
    expect(ctx.env.Q_JOBS.sent).toEqual([{ job: "catalog.import", runId: expect.any(String) }]);
    const [run] = await db.select().from(jobRuns);
    expect(run).toMatchObject({ job: "catalog.import", trigger: "manual", status: "queued" });
    expect(await importCatalog(ctx)).toBe(5);
    expect(ctx.env.Q_JOBS.sent).toHaveLength(1); // done: no further continuation
    expect(await db.select().from(books)).toHaveLength(25);
  });
});

describe("catalog.enrich", () => {
  it("looks up pending books and confirms matches", async () => {
    await syncTaxonomy(db);
    const seed = { source: "ai" as const, origin: "ai_seed" as const, fuzzyMin: 0.6, crowdMinVotes: 8 };
    const { bookId } = await ingestBook(
      db,
      { title: "The Primal Hunter", authors: [{ name: "Zogarth" }] },
      seed,
    );
    await ingestBook(db, { title: "Unknown Book", authors: [{ name: "Nobody" }] }, seed);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const title = new URL(url).searchParams.get("title");
        return Response.json({
          docs:
            title === "The Primal Hunter"
              ? [{ key: "/works/OL1W", title, author_name: ["Zogarth"], first_publish_year: 2022 }]
              : [],
        });
      }),
    );
    expect(await enrichCatalog(ctx)).toBe(2);
    const rows = await db.select().from(books);
    expect(rows.find((b) => b.id === bookId)).toMatchObject({ enrichStatus: "matched" });
    expect(rows.find((b) => b.id !== bookId)).toMatchObject({ enrichStatus: "no_match" });
    expect(await enrichCatalog(ctx)).toBe(0);
  });
});
