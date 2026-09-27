// Secrets are set with `wrangler secret put` and never appear in wrangler.jsonc, so `wrangler types`
// can't see them. Declare them here (DESIGN Appendix D).
interface Env {
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  /** Optional. Without it, enrichment uses Open Library only (Google Books throttles anonymous calls). */
  GOOGLE_BOOKS_API_KEY?: string;
}
