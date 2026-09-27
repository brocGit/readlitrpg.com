// CSRF defense for form posts (the rule Astro's security.checkOrigin applies): a POST that a
// browser could send cross-site without a preflight must carry our own Origin.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

export function isCrossSiteFormPost(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const sameOrigin = request.headers.get("origin") === url.origin;
  const type = request.headers.get("content-type");
  // Without a content type the browser would have sent a preflight for anything but a form, but a
  // missing Origin is still refused: every browser sends one on a POST.
  if (type === null) return !sameOrigin;
  const formLike = FORM_TYPES.some((t) => type.toLowerCase().includes(t));
  return formLike && !sameOrigin;
}
