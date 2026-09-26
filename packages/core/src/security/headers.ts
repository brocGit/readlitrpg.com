// Security headers for HTML responses (DESIGN §15.5).

export interface CspOptions {
  /** Per-request nonce for inline scripts and styles, when the page needs any. */
  nonce?: string;
  /** Extra hashes (e.g. 'sha256-…') for inline scripts the framework emits. */
  scriptHashes?: string[];
  styleHashes?: string[];
  mediaOrigin?: string;
  /** Allow Turnstile and Cloudflare Web Analytics. */
  turnstile?: boolean;
  webAnalytics?: boolean;
  /** Where forms may post besides 'self' (Stripe Checkout and Portal on web). */
  formActions?: string[];
  /** Dev servers need websocket HMR and eval; never set in production. */
  dev?: boolean;
}

export function buildCsp(opts: CspOptions = {}): string {
  // In dev, Vite injects inline scripts and styles and uses eval for HMR. 'unsafe-inline' is ignored
  // by browsers whenever a nonce or hash is present, so dev drops nonces and hashes entirely.
  const inline = opts.dev
    ? { script: ["'unsafe-inline'", "'unsafe-eval'"], style: ["'unsafe-inline'"] }
    : {
        script: [
          ...(opts.nonce ? [`'nonce-${opts.nonce}'`] : []),
          ...(opts.scriptHashes ?? []).map((h) => `'${h}'`),
        ],
        style: [
          ...(opts.nonce ? [`'nonce-${opts.nonce}'`] : []),
          ...(opts.styleHashes ?? []).map((h) => `'${h}'`),
        ],
      };
  const script = ["'self'", ...inline.script];
  const style = ["'self'", ...inline.style];
  const img = ["'self'", "data:"];
  const connect = ["'self'"];
  const frame: string[] = [];
  if (opts.mediaOrigin) img.push(opts.mediaOrigin);
  if (opts.turnstile) {
    script.push("https://challenges.cloudflare.com");
    frame.push("https://challenges.cloudflare.com");
  }
  if (opts.webAnalytics) {
    script.push("https://static.cloudflareinsights.com");
    connect.push("https://cloudflareinsights.com");
  }
  if (opts.dev) connect.push("ws:", "wss:");
  const directives = [
    "default-src 'self'",
    `script-src ${dedupe(script).join(" ")}`,
    `style-src ${dedupe(style).join(" ")}`,
    `img-src ${dedupe(img).join(" ")}`,
    "font-src 'self'",
    `connect-src ${dedupe(connect).join(" ")}`,
    `frame-src ${frame.length ? dedupe(frame).join(" ") : "'none'"}`,
    `form-action ${["'self'", ...(opts.formActions ?? [])].join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  if (!opts.dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const dedupe = (values: string[]) => [...new Set(values)];

/**
 * CSP for Astro pages (DESIGN §15.5). HTML is edge-cached and shared, so per-request nonces
 * can't work. Astro hashes its own scripts and styles and sends the policy as a response header.
 * This supplies everything except the hashes: the non-script directives and the allowed origins.
 */
export function astroCsp(opts: Omit<CspOptions, "nonce" | "scriptHashes" | "styleHashes" | "dev">) {
  const img = ["'self'", "data:", ...(opts.mediaOrigin ? [opts.mediaOrigin] : [])];
  const connect = ["'self'", ...(opts.webAnalytics ? ["https://cloudflareinsights.com"] : [])];
  const frame = opts.turnstile ? ["https://challenges.cloudflare.com"] : ["'none'"];
  const scripts = [
    "'self'",
    ...(opts.turnstile ? ["https://challenges.cloudflare.com"] : []),
    ...(opts.webAnalytics ? ["https://static.cloudflareinsights.com"] : []),
  ];
  return {
    directives: [
      "default-src 'self'",
      `img-src ${img.join(" ")}`,
      "font-src 'self'",
      `connect-src ${connect.join(" ")}`,
      `frame-src ${frame.join(" ")}`,
      `form-action ${["'self'", ...(opts.formActions ?? [])].join(" ")}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ] as const,
    scriptResources: scripts,
    styleResources: ["'self'"],
  };
}

export interface SecurityHeaderOptions extends CspOptions {
  /** HSTS is only sent over HTTPS in production. */
  hsts?: boolean;
  /** Pages carrying one-time tokens (sign-in confirmation) must not leak them in Referer. */
  noReferrer?: boolean;
}

export function securityHeaders(opts: SecurityHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildCsp(opts),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": opts.noReferrer ? "no-referrer" : "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };
  if (opts.hsts) headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  return headers;
}

/** Headers for JSON and other non-HTML responses. */
export function apiSecurityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
}

/**
 * Apply headers without overwriting any a handler set on purpose. Always returns a copy with
 * mutable headers: redirects and fetched responses have immutable ones.
 */
export function applyHeaders(response: Response, headers: Record<string, string>): Response {
  const target = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) {
    if (!target.headers.has(k)) target.headers.set(k, v);
  }
  return target;
}

/** A base64 nonce with 128 bits of entropy. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
