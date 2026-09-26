// Request pipeline: headers (wraps everything, so even refusals get them) → Access → route gate
// (DESIGN §15.3–15.5).

import { defineMiddleware, sequence } from "astro:middleware";
import { ulid } from "@rlr/core";
import { checkRoute, type RouteAccess } from "@rlr/core/policy";
import { applyHeaders, buildCsp, securityHeaders } from "@rlr/core/security";
import { loadSettings, type Settings } from "@rlr/core/settings";
import { checkAccess } from "./lib/access";
import { type AdminSession, adminActor, resolveAdminSession } from "./lib/admin-session";
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
  // Service tokens are for the editorial API (M2). Nothing here accepts them yet.
  if (result.identity.kind !== "user") {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  ctx.locals.access = result.identity;
  const settings = once<Settings>(() => loadSettings({ db: getDb(), kv: env.CONFIG, log }));
  ctx.locals.settings = settings;
  ctx.locals.admin = once<AdminSession | null>(() =>
    resolveAdminSession(ctx.request, { auth: getAuth(), db: getDb(), access: result.identity, settings }),
  );
  return next();
});

const gate = defineMiddleware(async (ctx, next) => {
  const rule: RouteAccess | undefined = (ROUTES as Record<string, RouteAccess>)[ctx.routePattern];
  if (!rule) {
    log.error("route.unregistered", { route: ctx.routePattern, request_id: ctx.locals.requestId });
    return new Response("Not found", { status: 404 });
  }
  if (rule.kind !== "public") {
    const decision = checkRoute(adminActor(await ctx.locals.admin()), rule);
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
  if (!production || (isHtml && response.headers.has("content-security-policy"))) {
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
