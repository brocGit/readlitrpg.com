// Talking to the editorial API (DESIGN §7.1). Credentials come from the environment only:
// EDITORIAL_TOKEN plus the Access service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET),
// all stored in the cloud environment's secrets. Nothing here prints or writes them.

export type EditorialEnvName = "local" | "production";

/** The well-known local token; its hash is in apps/admin/.dev.vars.example. Useless anywhere else. */
export const LOCAL_TOKEN = "local-editorial-token-not-a-secret";

const BASE_URLS: Record<EditorialEnvName, string> = {
  local: "http://localhost:4322",
  production: "https://admin.readlitrpg.com",
};

export interface ClientConfig {
  baseUrl: string;
  env: EditorialEnvName | "custom";
  headers: Record<string, string>;
}

export class ConfigError extends Error {}

export function clientConfig(env: string, vars: NodeJS.ProcessEnv = process.env): ClientConfig {
  const custom = vars.EDITORIAL_API_URL;
  if (env !== "local" && env !== "production")
    throw new ConfigError(`--env must be local or production (got ${env})`);
  const baseUrl = custom ?? BASE_URLS[env];
  const url = new URL(baseUrl);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalHost) throw new ConfigError("EDITORIAL_API_URL must be https");
  const token = vars.EDITORIAL_TOKEN ?? (env === "local" ? LOCAL_TOKEN : undefined);
  if (!token) {
    throw new ConfigError(
      "EDITORIAL_TOKEN is not set. Scheduled runs get it from the cloud environment's secrets (docs/runbooks/editorial-runs.md).",
    );
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "rlr-editorial-cli/1",
  };
  if (!isLocalHost) {
    const id = vars.CF_ACCESS_CLIENT_ID;
    const secret = vars.CF_ACCESS_CLIENT_SECRET;
    if (!id || !secret) {
      throw new ConfigError(
        "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are needed to pass Cloudflare Access.",
      );
    }
    headers["cf-access-client-id"] = id;
    headers["cf-access-client-secret"] = secret;
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), env: custom ? "custom" : env, headers };
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const code = (body as { error?: string } | null)?.error;
    super(`editorial API answered ${status}${code ? ` (${code})` : ""}`);
  }
}

export interface Client {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createClient(config: ClientConfig, fetchImpl: typeof fetch = fetch): Client {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: config.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Access answers a login page (HTML) when the service token is missing or wrong.
      parsed = {
        error: response.status === 302 || text.includes("<html") ? "access_login_page" : "not_json",
      };
    }
    if (!response.ok) throw new ApiCallError(response.status, parsed);
    return parsed as T;
  }
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}
