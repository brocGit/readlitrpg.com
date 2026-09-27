// Secrets are set with `wrangler secret put` and never appear in wrangler.jsonc, so `wrangler types`
// can't see them. Declare them here (DESIGN Appendix D).
interface Env {
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  /** Optional. Without it, enrichment uses Open Library only (Google Books throttles anonymous calls). */
  GOOGLE_BOOKS_API_KEY?: string;
  /** Optional pair for embeddings through the Workers AI REST API (DESIGN §7.2). */
  CF_ACCOUNT_ID?: string;
  /** A Cloudflare API token scoped to Workers AI. */
  CF_API_TOKEN?: string;
  /** Optional: post "Today in LitRPG" to Bluesky (an app password, never the account password). */
  BLUESKY_HANDLE?: string;
  BLUESKY_APP_PASSWORD?: string;
  /** Optional: post it to Mastodon (the instance's https URL and an access token with write:statuses). */
  MASTODON_URL?: string;
  MASTODON_TOKEN?: string;
  /** Optional: a private Discord channel's webhook for the owner's instant alerts (DESIGN §8.4). */
  DISCORD_ALERT_WEBHOOK?: string;
}

// Bundled binaries (wrangler.jsonc "rules"): WebAssembly as a compiled module, fonts as bytes.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
