// The only way the Workers fetch other sites (DESIGN §15.8). Every call names the hosts it may
// reach; nothing else is allowed, including through redirects.

import { DO_NOT_FETCH } from "../catalog/normalize";

export const BOT_USER_AGENT = "ReadLitRPG-Bot/1.0 (+https://readlitrpg.com/bot)";

export interface SafeFetchOptions {
  /** Hostnames this call may reach (exact match, or a subdomain of one). */
  allowHosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface SafeResponse {
  status: number;
  url: string;
  headers: Headers;
  text: string;
}

export class SafeFetchError extends Error {
  constructor(
    readonly code: "blocked" | "timeout" | "too_large" | "too_many_redirects" | "network",
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
const PRIVATE_NAMES = /(^localhost$|\.local$|\.internal$|\.localhost$)/i;

export function checkUrl(raw: string, allowHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("blocked", "not a URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("blocked", "https only");
  if (url.port && url.port !== "443") throw new SafeFetchError("blocked", "port 443 only");
  if (url.username || url.password) throw new SafeFetchError("blocked", "no credentials in URLs");
  const host = url.hostname.toLowerCase();
  if (IP_LITERAL.test(host) || PRIVATE_NAMES.test(host))
    throw new SafeFetchError("blocked", "private or literal host");
  if (DO_NOT_FETCH.some((pattern) => pattern.test(host))) {
    throw new SafeFetchError("blocked", `${host} is on the do-not-fetch list`);
  }
  if (!allowHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new SafeFetchError("blocked", `${host} is not allowed for this call`);
  }
  return url;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  let url = checkUrl(raw, opts.allowHosts);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": BOT_USER_AGENT, accept: "application/json", ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SafeFetchError(timedOut ? "timeout" : "network", timedOut ? "timed out" : String(error));
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (hop >= (opts.maxRedirects ?? 3))
        throw new SafeFetchError("too_many_redirects", "too many redirects");
      url = checkUrl(new URL(response.headers.get("location") ?? "", url).toString(), opts.allowHosts);
      continue;
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new SafeFetchError("too_large", "response too large");
    const text = await readCapped(response, maxBytes);
    return { status: response.status, url: url.toString(), headers: response.headers, text };
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SafeFetchError("too_large", "response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
