import { sha256Hex } from "@rlr/core";
import { ingestBook } from "@rlr/core/catalog";
import { createDb, type Db } from "@rlr/core/db";
import { buildEditorialQueue } from "@rlr/core/editorial";
import { can } from "@rlr/core/policy";
import { defaultSettings } from "@rlr/core/settings";
import { syncTaxonomy } from "@rlr/core/taxonomy";
import { createTestD1 } from "@rlr/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  handleFinish,
  handlePull,
  handlePush,
  handleStart,
  handleStatus,
  pushRequestSchema,
  readJson,
} from "../src/lib/editorial-api";
import { checkEditorialIdentity, checkEditorialToken } from "../src/lib/editorial-auth";

const TOKEN = "a-long-random-editorial-token-for-tests";

const req = (headers: Record<string, string> = {}, body?: string) =>
  new Request("https://admin.readlitrpg.com/api/editorial/pull", { method: "POST", headers, body });

describe("editorial API locks", () => {
  it("accepts only the token whose hash is configured, in any rotation slot", async () => {
    const env = {
      ENVIRONMENT: "production",
      EDITORIAL_TOKEN_HASH: `${"0".repeat(64)},${await sha256Hex(TOKEN)}`,
    };
    expect(await checkEditorialToken(req({ authorization: `Bearer ${TOKEN}` }), env)).toEqual({
      ok: true,
      tokenSlot: 1,
    });
    expect(
      await checkEditorialToken(req({ authorization: "Bearer wrong-token-of-enough-length" }), env),
    ).toMatchObject({
      ok: false,
      status: 401,
      reason: "bad_token",
    });
    expect(await checkEditorialToken(req(), env)).toMatchObject({ ok: false, reason: "missing_token" });
    expect(
      await checkEditorialToken(req({ authorization: `Bearer ${TOKEN}` }), { ENVIRONMENT: "production" }),
    ).toMatchObject({
      ok: false,
      reason: "editorial_api_not_configured",
    });
  });

  it("requires an allowlisted Access service token in production, never an owner's browser", () => {
    const env = { ENVIRONMENT: "production", EDITORIAL_ACCESS_CLIENT_IDS: "abc.access, def.access" };
    expect(checkEditorialIdentity({ kind: "service", clientId: "def.access", sub: "" }, env).ok).toBe(true);
    expect(checkEditorialIdentity({ kind: "service", clientId: "zzz.access", sub: "" }, env)).toMatchObject({
      ok: false,
      reason: "service_token_not_allowed",
    });
    expect(checkEditorialIdentity({ kind: "user", email: "owner@example.com", sub: "" }, env)).toMatchObject({
      ok: false,
      reason: "service_token_required",
    });
    expect(
      checkEditorialIdentity(
        { kind: "service", clientId: "set-at-setup", sub: "" },
        { ENVIRONMENT: "production" },
      ).ok,
    ).toBe(false);
    expect(
      checkEditorialIdentity({ kind: "user", email: "dev@example.com", sub: "" }, { ENVIRONMENT: "local" })
        .ok,
    ).toBe(true);
  });

  it("gives the editorial actor nothing but editorial.run", () => {
    const actor = { kind: "editorial" as const, runId: "" };
    expect(can(actor, "editorial.run").ok).toBe(true);
    for (const action of ["catalog.manage", "settings.change", "inbox.decide", "money.refund"] as const) {
      expect(can(actor, action).ok).toBe(false);
    }
  });

  it("refuses oversized and malformed bodies", async () => {
    await expect(readJson(req({}, "{"), pushRequestSchema)).rejects.toMatchObject({ code: "invalid_json" });
    await expect(
      readJson(req({ "content-length": "2000000" }, "{}"), pushRequestSchema),
    ).rejects.toBeInstanceOf(ApiError);
    const tooMany = JSON.stringify({ run_id: "r", schema_version: 1, proposals: Array(26).fill({}) });
    await expect(readJson(req({}, tooMany), pushRequestSchema)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});

describe("editorial API handlers", () => {
  let db: Db;
  beforeEach(async () => {
    db = createDb(createTestD1().asD1());
    await syncTaxonomy(db);
  });

  it("runs a whole session: start, pull, push, finish", async () => {
    const settings = defaultSettings();
    const { bookId } = await ingestBook(
      db,
      { title: "Unsouled", authors: [{ name: "Will Wight" }], primaryGenre: "progression-fantasy" },
      { source: "ai", origin: "ai_seed", fuzzyMin: 0.6, crowdMinVotes: 8 },
    );
    await buildEditorialQueue(db, settings);
    const start = await handleStart(db, { kind: "manual", label: "test" });
    expect(start).toMatchObject({ schema_version: 1, taxonomy_hash: expect.any(String) });

    const pull = await handlePull(db, settings, { run_id: start.run_id, kinds: ["classify"], limit: 10 });
    expect(pull.items).toHaveLength(1);
    const item = pull.items[0];
    expect(item?.input).toMatchObject({ book: { id: bookId, title: "Unsouled", authors: ["Will Wight"] } });

    const push = await handlePush(db, settings, {
      run_id: start.run_id,
      schema_version: 1,
      proposals: [
        {
          kind: "classify",
          item_id: item?.item_id,
          book_id: bookId,
          in_scope: "yes",
          primary_genre: "progression-fantasy",
          tags: [{ slug: "cultivation", confidence: "high", evidence: "Sacred arts and advancement ranks." }],
          crunch_level: { value: 0, confidence: "high" },
          romance_level: { value: 1, confidence: "medium" },
          harem: { value: "none", confidence: "high" },
          known_work: "yes",
          dials: {},
          stats: {},
          content_flags: [],
          summary: null,
          hook: null,
          anomalies: [],
        },
      ],
    });
    expect(push.outcomes[0]).toMatchObject({ status: "accepted" });
    expect(push.run).toMatchObject({ accepted: 1, rejected: 0 });

    const status = await handleStatus(db);
    expect(status.recent_runs[0]).toMatchObject({ id: start.run_id, status: "running" });
    const finish = await handleFinish(db, start.run_id, { status: "succeeded", notes: "done" });
    expect(finish).toMatchObject({ status: "succeeded", claimed: 1, accepted: 1 });
    await expect(handleFinish(db, start.run_id, { status: "succeeded" })).rejects.toMatchObject({
      code: "run_not_running",
    });
    await expect(
      handlePull(db, settings, { run_id: start.run_id, kinds: ["classify"], limit: 1 }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
