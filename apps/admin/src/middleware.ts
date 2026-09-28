// Request pipeline: headers (wraps everything, so even refusals get them) → Access → route gate
// (DESIGN §15.3–15.5).

import { defineMiddleware, sequence } from "astro:middleware";
import { ulid } from "@rlr/core";
import { openInboxItem } from "@rlr/core/inbox";
import { type Actor, checkRoute, type RouteAccess } from "@rlr/core/policy";
import {
  type AccessIdentity,
  applyHeaders,
  buildCsp,
  reroutesToErrorPage,
  securityHeaders,
} from "@rlr/core/security";
import { loadSettings, type Settings } from "@rlr/core/settings";
import type { APIContext, MiddlewareNext } from "astro";
import { checkAccess } from "./lib/access";
import { type AdminSession, adminActor, resolveAdminSession } from "./lib/admin-session";
import { checkEditorialIdentity, checkEditorialToken, EDITORIAL_PREFIX } from "./lib/editorial-auth";
import { env, getAuth, getDb, isProduction, log } from "./lib/runtime";
import { ROUTES } from "./routes";

const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => {
    value ??= fn();
    return value;
  };
};

const access = defineMiddleware(async (ctx, next) => {
  const result = await checkAccess(ctx.request, env);
  if (!result.ok) {
    log.warn("access.denied", { reason: result.reason, request_id: ctx.locals.requestId });
    return new Response("Access required", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  ctx.locals.access = result.identity;
  const settings = once<Settings>(() => loadSettings({ db: getDb(), kv: env.CONFIG, log }));
  ctx.locals.settings = settings;
  ctx.locals.editorial = null;
  if (ctx.url.pathname.startsWith(EDITORIAL_PREFIX)) {
    return editorialAccess(ctx, result.identity, next);
  }
  // Service tokens only ever reach the editorial API.
  if (result.identity.kind !== "user") {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  ctx.locals.admin = once<AdminSession | null>(() =>
    resolveAdminSession(ctx.request, { auth: getAuth(), db: getDb(), access: result.identity, settings }),
  );
  return next();
});

/** The editorial API: Access service token, editorial token, and the kill switch (§7.13). */
async function editorialAccess(
  ctx: APIContext,
  identity: AccessIdentity,
  next: MiddlewareNext,
): Promise<Response> {
  const refuse = (status: number, reason: string) => {
    log.warn("editorial.refused", { reason, request_id: ctx.locals.requestId });
    return Response.json({ error: reason }, { status, headers: { "Cache-Control": "no-store" } });
  };
  const who = checkEditorialIdentity(identity, env);
  if (!who.ok) return refuse(who.status, who.reason);
  const token = await checkEditorialToken(ctx.request, env);
  if (!token.ok) {
    // A valid service token with a wrong editorial token means one of the two leaked, or a
    // rotation went wrong. Either way the owner should know (one alert per hour).
    if (token.reason === "bad_token" && env.ENVIRONMENT !== "local") {
      await openInboxItem(getDb(), {
        type: "security_event",
        title: "The editorial API refused a bad editorial token",
        priority: 90,
        payload: { requestId: ctx.locals.requestId },
        dedupeKey: `editorial_bad_token:${new Date().toISOString().slice(0, 13)}`,
      });
    }
    return refuse(token.status, token.reason);
  }
  if (!(await ctx.locals.settings())["flags.editorial_api"]) return refuse(503, "editorial_api_off");
  ctx.locals.editorial = { tokenSlot: token.tokenSlot };
  ctx.locals.admin = async () => null;
  return next();
}

const gate = defineMiddleware(async (ctx, next) => {
  const rule: RouteAccess | undefined = (ROUTES as Record<string, RouteAccess>)[ctx.routePattern];
  if (!rule) {
    log.error("route.unregistered", { route: ctx.routePattern, request_id: ctx.locals.requestId });
    return new Response("Not found", { status: 404 });
  }
  if (rule.kind !== "public") {
    // Editorial requests never carry an admin session; their actor comes from the token alone.
    const actor: Actor = ctx.locals.editorial
      ? { kind: "editorial", runId: "" }
      : adminActor(await ctx.locals.admin());
    const decision = checkRoute(actor, rule);
    if (!decision.ok) {
      if (ctx.url.pathname.startsWith("/api/"))
        return Response.json({ error: decision.reason }, { status: 401 });
      return ctx.redirect(`/signin?next=${encodeURIComponent(ctx.url.pathname)}`, 303);
    }
  }
  return next();
});

const headers = defineMiddleware(async (ctx, next) => {
  ctx.locals.requestId = ctx.request.headers.get("cf-ray") ?? ulid();
  const response = await next();
  const production = isProduction();
  const base = securityHeaders({ hsts: production });
  const isHtml = (response.headers.get("content-type") ?? "").includes("text/html");
  // A bodiless 404 or 500 becomes the error page, which brings its own policy (reroutesToErrorPage).
  if (
    !production ||
    reroutesToErrorPage(response) ||
    (isHtml && response.headers.has("content-security-policy"))
  ) {
    delete (base as Record<string, string>)["Content-Security-Policy"];
  } else {
    base["Content-Security-Policy"] = buildCsp({});
  }
  const result = applyHeaders(response, base);
  // Nothing on the admin host is ever cached or indexed.
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("X-Robots-Tag", "noindex, nofollow");
  result.headers.set("X-Request-Id", ctx.locals.requestId);
  return result;
});

export const onRequest = sequence(headers, access, gate);
