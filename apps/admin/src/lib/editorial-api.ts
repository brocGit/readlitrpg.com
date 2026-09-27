// Handlers for the editorial API (DESIGN §7.1). The pages under src/pages/api/editorial/ are thin
// wrappers; everything here takes plain inputs so it can be tested without a Worker.

import type { Db } from "@rlr/core/db";
import {
  buildWorkItems,
  claimItems,
  closeItem,
  finishRun,
  finishRunSchema,
  getRun,
  listRuns,
  PROPOSAL_SCHEMA_VERSION,
  pullRequestSchema,
  pushProposals,
  pushRequestSchema,
  queueDepth,
  recordOutcomes,
  startRun,
  startRunSchema,
} from "@rlr/core/editorial";
import type { Settings } from "@rlr/core/settings";
import { TAXONOMY_HASH } from "@rlr/core/taxonomy";
import type { z } from "zod";

/** Push bodies carry at most 25 proposals; nothing legitimate comes near this. */
export const MAX_BODY_BYTES = 1_000_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export async function readJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_request",
      parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    );
  }
  return parsed.data;
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function respond(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
    }
    throw error;
  }
}

async function runningRun(db: Db, runId: string) {
  const run = await getRun(db, runId);
  if (!run) throw new ApiError(404, "run_not_found");
  if (run.status !== "running") throw new ApiError(409, "run_not_running");
  return run;
}

export async function handleStart(db: Db, body: z.infer<typeof startRunSchema>) {
  const run = await startRun(db, body);
  return {
    run_id: run.id,
    schema_version: PROPOSAL_SCHEMA_VERSION,
    taxonomy_hash: TAXONOMY_HASH,
  };
}

export async function handlePull(db: Db, settings: Settings, body: z.infer<typeof pullRequestSchema>) {
  const run = await runningRun(db, body.run_id);
  if (run.circuitOpen) throw new ApiError(409, "run_on_hold");
  const limit = Math.min(body.limit, settings["editorial.max_claim"]);
  const claimed = await claimItems(db, {
    runId: run.id,
    kinds: body.kinds,
    limit,
    claimHours: settings["editorial.claim_hours"],
  });
  const { work, gone } = await buildWorkItems(db, claimed);
  // A subject that vanished since it was queued (merged, removed, decided) is not work any more.
  for (const id of gone) await closeItem(db, id, "rejected");
  await recordOutcomes(
    db,
    run.id,
    { claimed: work.length },
    {
      rejectShare: settings["editorial.circuit_reject_share"],
      minProposals: settings["editorial.circuit_min_proposals"],
    },
  );
  return {
    run_id: run.id,
    schema_version: PROPOSAL_SCHEMA_VERSION,
    taxonomy_hash: TAXONOMY_HASH,
    claim_hours: settings["editorial.claim_hours"],
    items: work,
    dropped: gone.length,
  };
}

export async function handlePush(db: Db, settings: Settings, body: z.infer<typeof pushRequestSchema>) {
  await runningRun(db, body.run_id);
  const outcomes = await pushProposals({ db, runId: body.run_id, settings }, body.proposals);
  const run = await getRun(db, body.run_id);
  return {
    outcomes,
    run: run && {
      accepted: run.proposalsAccepted,
      rejected: run.proposalsRejected,
      held: run.proposalsHeld,
      circuit_open: run.circuitOpen,
    },
  };
}

export async function handleFinish(db: Db, runId: string, body: z.infer<typeof finishRunSchema>) {
  await runningRun(db, runId);
  const run = await finishRun(db, runId, body);
  if (!run) throw new ApiError(409, "run_not_running");
  return {
    run_id: run.id,
    status: run.status,
    claimed: run.itemsClaimed,
    accepted: run.proposalsAccepted,
    rejected: run.proposalsRejected,
    held: run.proposalsHeld,
  };
}

export async function handleStatus(db: Db) {
  const [depth, runs] = await Promise.all([queueDepth(db), listRuns(db, 5)]);
  return {
    taxonomy_hash: TAXONOMY_HASH,
    schema_version: PROPOSAL_SCHEMA_VERSION,
    queue: depth,
    recent_runs: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      status: r.status,
      started_at: r.startedAt,
      finished_at: r.finishedAt,
      accepted: r.proposalsAccepted,
      rejected: r.proposalsRejected,
      held: r.proposalsHeld,
    })),
  };
}

export { finishRunSchema, pullRequestSchema, pushRequestSchema, startRunSchema };
