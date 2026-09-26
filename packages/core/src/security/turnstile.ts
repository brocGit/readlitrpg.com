// Cloudflare Turnstile server-side check (DESIGN §15.2). Bot protection on public forms.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's documented test keys: they always pass. Local development only. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

export interface TurnstileResult {
  ok: boolean;
  errors: string[];
}

export async function verifyTurnstile(
  token: string | null | undefined,
  opts: { secret: string; ip?: string; expectedAction?: string; fetch?: typeof fetch },
): Promise<TurnstileResult> {
  if (!token || token.length > 2048) return { ok: false, errors: ["missing-input-response"] };
  if (!opts.secret) return { ok: false, errors: ["missing-input-secret"] };
  const body = new FormData();
  body.set("secret", opts.secret);
  body.set("response", token);
  if (opts.ip) body.set("remoteip", opts.ip);
  try {
    const response = await (opts.fetch ?? fetch)(TURNSTILE_VERIFY_URL, { method: "POST", body });
    if (!response.ok) return { ok: false, errors: [`http-${response.status}`] };
    const json = (await response.json()) as { success?: boolean; action?: string; "error-codes"?: string[] };
    if (!json.success) return { ok: false, errors: json["error-codes"] ?? ["unknown"] };
    if (opts.expectedAction && json.action && json.action !== opts.expectedAction) {
      return { ok: false, errors: ["action-mismatch"] };
    }
    return { ok: true, errors: [] };
  } catch {
    return { ok: false, errors: ["network"] };
  }
}
