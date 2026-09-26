// Open-redirect protection: only same-origin, path-only redirect targets are accepted.

export function safeRedirectPath(target: string | null | undefined, fallback = "/"): string {
  if (!target) return fallback;
  // Must be a path on this site: starts with one "/", not "//" or "/\" (protocol-relative).
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) return fallback;
  try {
    const url = new URL(target, "https://placeholder.invalid");
    if (url.origin !== "https://placeholder.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
