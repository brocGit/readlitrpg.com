// Browser-side helpers for islands on cached pages: who is signed in (asked once per page), the
// quiz takes kept in this browser, and Turnstile rendered on demand.

interface Me {
  signedIn: boolean;
  email?: string;
}

let me: Promise<Me> | undefined;

export function whoAmI(): Promise<Me> {
  if (!me)
    me = fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : { signedIn: false }))
      .catch(() => ({ signedIn: false }));
  return me;
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, data: null };
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as T | null };
}

/** Quiz take ids kept in this browser (QUIZZES §4.3). */
export function storedTakes(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem("rlr.takes") ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string").slice(-20) : [];
  } catch {
    return [];
  }
}

export function forgetTakes() {
  try {
    localStorage.removeItem("rlr.takes");
  } catch {
    // Storage may be off.
  }
}

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: { sitekey: string; action: string; callback: (token: string) => void },
  ): string;
  reset(id?: string): void;
}

let turnstile: Promise<TurnstileApi> | undefined;

/** Load Turnstile once, in explicit mode, for forms that appear after the page loads. */
export function loadTurnstile(): Promise<TurnstileApi> {
  turnstile ??= new Promise((resolve, reject) => {
    const w = window as unknown as { turnstile?: TurnstileApi };
    if (w.turnstile) return resolve(w.turnstile);
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => reject(new Error("turnstile failed to load"));
    document.head.appendChild(s);
  });
  return turnstile;
}
