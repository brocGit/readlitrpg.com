// Reader data jobs (DESIGN §9.7, §9.8): matching imported Goodreads / StoryGraph libraries to the
// catalog in chunks, and building "export my data" files into PRIVATE with an emailed link.

import { buildExport, EXPORT_TTL_DAYS, processLibraryChunk } from "@rlr/core/readers";
import { dataExports, users } from "@rlr/core/schema";
import { renderExportReady } from "@rlr/email";
import { and, asc, eq } from "drizzle-orm";
import type { JobContext } from "./types";

/** About 160 queries a chunk (match, mark, row update), so four chunks stay under D1's limit. */
const IMPORT_CHUNKS = 4;

export async function matchLibraryImports({ db, log }: JobContext): Promise<number> {
  let total = 0;
  for (let i = 0; i < IMPORT_CHUNKS; i++) {
    const r = await processLibraryChunk(db, 40);
    total += r.processed;
    if (!r.importId) break;
    if (r.remaining === 0) log.info("library_import.done", { import_id: r.importId });
  }
  return total;
}

export async function buildExports({ db, env, log, now }: JobContext): Promise<number> {
  const queued = await db
    .select({ id: dataExports.id, userId: dataExports.userId })
    .from(dataExports)
    .where(eq(dataExports.status, "queued"))
    .orderBy(asc(dataExports.createdAt))
    .limit(3);
  const origin = env.PUBLIC_ORIGIN.replace(/\/$/, "");
  for (const e of queued) {
    const data = await buildExport(db, e.userId);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, e.userId));
    if (!data || !user) {
      // The account was deleted while the export waited.
      await db.update(dataExports).set({ status: "expired" }).where(eq(dataExports.id, e.id));
      continue;
    }
    const key = `exports/${e.userId}/${e.id}.json`;
    await env.PRIVATE.put(key, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    await db
      .update(dataExports)
      .set({
        status: "ready",
        objectKey: key,
        readyAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + EXPORT_TTL_DAYS * 86_400_000).toISOString(),
      })
      .where(and(eq(dataExports.id, e.id), eq(dataExports.status, "queued")));
    const email = renderExportReady({ url: `${origin}/account/export/${e.id}`, days: EXPORT_TTL_DAYS });
    await env.Q_EMAIL.send({
      kind: "rendered",
      to: user.email,
      userId: e.userId,
      template: "export_ready",
      issueId: null,
      stream: "transactional",
      ...email,
    });
    log.info("export.ready", { export_id: e.id });
  }
  return queued.length;
}
