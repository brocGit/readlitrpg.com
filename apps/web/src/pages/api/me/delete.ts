import { hashIp } from "@rlr/core";
import { appendAudit } from "@rlr/core/audit";
import { deleteAccount } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { formBody, readerId, unauthorized } from "../../../lib/api";
import { log } from "../../../lib/log";
import { env, getAuth, getDb } from "../../../lib/runtime";

// "Delete my account" (DESIGN §9.8, §16.3): an immediate hard delete. Only a hash of the address
// stays, on the suppression list, so it is never mailed again.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  const form = await formBody(ctx.request);
  if (
    String(form.get("confirm") ?? "")
      .trim()
      .toLowerCase() !== "delete"
  )
    return ctx.redirect("/account/privacy?error=confirm", 303);
  const db = getDb();
  // Sign out first, while the session still exists, so the browser's cookie is cleared.
  const signOut = await getAuth()
    .api.signOut({ headers: ctx.request.headers, asResponse: true })
    .catch(() => null);
  const { deleted, exportKeys } = await deleteAccount(db, userId);
  if (deleted) {
    for (const key of exportKeys) await env.PRIVATE.delete(key);
    await appendAudit(db, {
      actor: { type: "user", id: userId },
      action: "account.delete",
      subjectType: "user",
      subjectId: userId,
      ipHash: await hashIp(ctx.clientAddress, env.IP_HASH_SALT_SEED),
      requestId: ctx.locals.requestId,
    });
    log.info("account.deleted", { request_id: ctx.locals.requestId });
  }
  const response = new Response(null, { status: 303, headers: { Location: "/goodbye" } });
  for (const cookie of signOut?.headers.getSetCookie() ?? []) response.headers.append("Set-Cookie", cookie);
  return response;
};
