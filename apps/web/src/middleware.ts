// Request pipeline: context → security headers (wrapping the rest, so even refusals get them) →
// origin check → route gate (DESIGN §15.4, §15.5).

import { defineMiddleware, sequence } from "astro:middleware";
import { ulid } from "@rlr/core";
import { checkRoute, type RouteAccess } from "@rlr/core/policy";
import {
  apiSecurityHeaders,
  applyHeaders,
  buildCsp,
  reroutesToErrorPage,
  securityHeaders,
} from "@rlr/core/security";
import { loadSettings, type Settings } from "@rlr/core/settings";
import { log } from "./lib/log";
import { isCrossSiteFormPost } from "./lib/origin";
import { env, getAuth, getDb, isProduction } from "./lib/runtime";
import { resolveActor, resolveSession, type SessionInfo } from "./lib/session";
import { CROSS_SITE_POSTS, PRIVATE_PREFIXES, ROUTES } from "./routes";

const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => {
    value ??= fn();
    return value;
  };
};

const context = defineMiddleware((ctx, next) => {
  ctx.locals.requestId = ctx.request.headers.get("cf-ray") ?? ulid();
  const settings = once<Settings>(() => loadSettings({ db: getDb(), kv: env.CONFIG, log }));
  const session = once<SessionInfo | null>(() => resolveSession(ctx.request, { auth: getAuth(), settings }));
  ctx.locals.settings = settings;
  ctx.locals.session = session;
  ctx.locals.actor = once(async () => resolveActor(await session(), getDb()));
  return next();
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Astro's own check (security.checkOrigin) can't exempt a route, and SNS and mail apps post without
// an Origin header, so the same rule lives here with an explicit exemption list.
const origin = defineMiddleware((ctx, next) => {
  if (!CROSS_SITE_POSTS.has(ctx.routePattern) && isCrossSiteFormPost(ctx.request, ctx.url)) {
    return new Response(`Cross-site ${ctx.request.method} form submissions are forbidden`, { status: 403 });
  }
  return next();
});

const gate = defineMiddleware(async (ctx, next) => {
  const access: RouteAccess | undefined = (ROUTES as Record<string, RouteAccess>)[ctx.routePattern];
  if (!access) {
    // Fail closed: a page without a registry entry is never served.
    log.error("route.unregistered", { route: ctx.routePattern, request_id: ctx.locals.requestId });
    return new Response("Not found", { status: 404 });
  }

  if (!SAFE_METHODS.has(ctx.request.method) && ctx.routePattern !== "/api/auth/[...all]") {
    if ((await ctx.locals.settings())["flags.read_only_mode"]) {
      return Response.json(
        { error: "read_only", message: "ReadLitRPG is in maintenance mode. Please try again soon." },
        { status: 503, headers: { "Retry-After": "300" } },
      );
    }
  }

  if (access.kind !== "public") {
    const decision = checkRoute(await ctx.locals.actor(), access);
    if (!decision.ok) {
      const isApi = ctx.url.pathname.startsWith("/api/");
      if (decision.reason === "unauthenticated" && !isApi) {
        const next = encodeURIComponent(ctx.url.pathname + ctx.url.search);
        return ctx.redirect(`/signin?next=${next}`, 303);
      }
      const status = decision.reason === "unauthenticated" ? 401 : 403;
      return Response.json({ error: decision.reason }, { status });
    }
  }
  return next();
});

const headers = defineMiddleware(async (ctx, next) => {
  const response = await next();
  const isHtml = (response.headers.get("content-type") ?? "").includes("text/html");
  const production = isProduction();
  let result = response;
  if (isHtml) {
    // Astro sends the hash-based CSP header for rendered pages. Anything else gets the strictest
    // policy (no inline code at all). Dev mode has no CSP because Vite injects inline code.
    const base = securityHeaders({ hsts: production });
    if (!production || response.headers.has("content-security-policy")) {
      delete (base as Record<string, string>)["Content-Security-Policy"];
    } else {
      base["Content-Security-Policy"] = buildCsp({});
    }
    result = applyHeaders(response, base);
  } else if (reroutesToErrorPage(response)) {
    // The 404 or 500 page takes this response's place and brings its own headers (it passes
    // through here too); a policy set now would win over them (reroutesToErrorPage).
    result = applyHeaders(response, {});
  } else {
    result = applyHeaders(response, {
      ...apiSecurityHeaders(),
      ...(production ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" } : {}),
    });
  }
  if (PRIVATE_PREFIXES.some((p) => ctx.url.pathname.startsWith(p))) {
    result.headers.set("Cache-Control", "private, no-store");
  }
  if (!(await ctx.locals.settings())["flags.indexable"]) {
    result.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  result.headers.set("X-Request-Id", ctx.locals.requestId);
  return result;
});

export const onRequest = sequence(context, headers, origin, gate);
