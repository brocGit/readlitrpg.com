import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyBrief, template } from "../src/brief";
import { main, readProposals, validateAll } from "../src/cli";
import { ConfigError, clientConfig, LOCAL_TOKEN } from "../src/client";

let dir: string;
let logs: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlr-editorial-"));
  process.env.EDITORIAL_STATE_DIR = join(dir, "state");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
});
afterEach(() => {
  delete process.env.EDITORIAL_STATE_DIR;
  vi.restoreAllMocks();
});

const classify = (itemId: string, bookId: string) => ({
  kind: "classify",
  item_id: itemId,
  book_id: bookId,
  in_scope: "yes",
  primary_genre: "litrpg",
  tags: [{ slug: "male-mc", confidence: "high", evidence: "The narrator is a man." }],
  crunch_level: { value: 1, confidence: "medium" },
  romance_level: { value: 0, confidence: "medium" },
  harem: { value: "none", confidence: "medium" },
  known_work: "no",
  dials: {},
  stats: {},
  content_flags: [],
  summary: null,
  hook: null,
  anomalies: [],
});

describe("client configuration", () => {
  it("uses the well-known token locally and needs real credentials elsewhere", () => {
    const local = clientConfig("local", {});
    expect(local.baseUrl).toBe("http://localhost:4322");
    expect(local.headers.authorization).toBe(`Bearer ${LOCAL_TOKEN}`);
    expect(local.headers["cf-access-client-id"]).toBeUndefined();
    expect(() => clientConfig("production", {})).toThrow(ConfigError);
    expect(() => clientConfig("production", { EDITORIAL_TOKEN: "t".repeat(40) })).toThrow(/CF_ACCESS/);
    const prod = clientConfig("production", {
      EDITORIAL_TOKEN: "t".repeat(40),
      CF_ACCESS_CLIENT_ID: "id.access",
      CF_ACCESS_CLIENT_SECRET: "s",
    });
    expect(prod.baseUrl).toBe("https://admin.readlitrpg.com");
    expect(prod.headers).toMatchObject({
      "cf-access-client-id": "id.access",
      "cf-access-client-secret": "s",
    });
    expect(() => clientConfig("local", { EDITORIAL_API_URL: "http://evil.example" })).toThrow(/https/);
    expect(() => clientConfig("staging", {})).toThrow(/--env/);
  });
});

describe("proposal files", () => {
  it("reads arrays, wrapped objects and JSON lines", () => {
    const a = join(dir, "a.json");
    writeFileSync(a, JSON.stringify([{ x: 1 }, { x: 2 }]));
    const b = join(dir, "b.json");
    writeFileSync(b, JSON.stringify({ proposals: [{ x: 1 }] }));
    const c = join(dir, "c.jsonl");
    writeFileSync(c, '{"x":1}\n{"x":2}\n\n{"x":3}\n');
    expect(readProposals(a)).toHaveLength(2);
    expect(readProposals(b)).toHaveLength(1);
    expect(readProposals(c)).toHaveLength(3);
  });

  it("templates fail validation until they are filled in", () => {
    const skeleton = template([{ item_id: "q1", kind: "classify", input: { book: { id: "b1" } } }]);
    expect(validateAll(skeleton)[0]?.errors.join()).toMatch(/in_scope/);
    expect(validateAll([classify("q1", "b1")])).toEqual([]);
  });

  it("prints a brief with every active tag, dial and stat", () => {
    const text = classifyBrief();
    expect(text).toContain("`system-apocalypse`");
    expect(text).toContain("`competent_mc`");
    expect(text).toContain("`pacing`");
  });
});

describe("a whole run through the CLI", () => {
  it("starts, pulls, refuses invalid pushes, pushes, and finishes", async () => {
    const calls: { path: string; body: unknown; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body, auth: new Headers(init.headers).get("authorization") });
      const reply = (value: unknown, status = 200) => Response.json(value, { status });
      if (path === "/api/editorial/runs")
        return reply({ run_id: "R1", taxonomy_hash: "x", schema_version: 1 }, 201);
      if (path === "/api/editorial/pull") {
        return reply({
          claim_hours: 3,
          dropped: 0,
          items: [{ item_id: "Q1", kind: "classify", input: { book: { id: "B1", title: "T" } } }],
        });
      }
      if (path === "/api/editorial/push") {
        return reply({
          outcomes: body.proposals.map((p: { item_id: string }) => ({
            item_id: p.item_id,
            status: "accepted",
            reasons: [],
          })),
          run: { circuit_open: false },
        });
      }
      if (path === "/api/editorial/runs/R1/finish") {
        return reply({ status: "succeeded", claimed: 1, accepted: 1, rejected: 0, held: 0 });
      }
      return reply({ error: "not_found" }, 404);
    }) as unknown as typeof fetch;

    expect(await main(["start", "--env", "local", "--label", "test"], fakeFetch)).toBe(0);
    expect(logs.join("\n")).toMatch(/differs from the server/);
    await expect(main(["start"], fakeFetch)).rejects.toThrow(/still open/);

    const work = join(dir, "work.json");
    expect(await main(["pull", "--kind", "classify", "--limit", "5", "--out", work], fakeFetch)).toBe(0);
    const pulled = JSON.parse(readFileSync(work, "utf8"));
    expect(pulled.items[0].item_id).toBe("Q1");
    expect(pulled.note).toMatch(/untrusted/);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ ...classify("Q1", "B1"), primary_genre: "nope" }]));
    const pushesBefore = calls.filter((c) => c.path.endsWith("/push")).length;
    expect(await main(["push", bad], fakeFetch)).toBe(1);
    expect(calls.filter((c) => c.path.endsWith("/push")).length).toBe(pushesBefore);

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify([classify("Q1", "B1")]));
    expect(await main(["push", good], fakeFetch)).toBe(0);
    expect(logs.join("\n")).toMatch(/Pushed 1: 1 accepted/);
    expect(await main(["finish", "--notes", "ok"], fakeFetch)).toBe(0);
    expect(readdirSync(join(dir, "state"))).not.toContain("run.json");
    expect(calls.every((c) => c.auth === `Bearer ${LOCAL_TOKEN}`)).toBe(true);
  });
});
