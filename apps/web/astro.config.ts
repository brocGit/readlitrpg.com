import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import preact from "@astrojs/preact";
import { astroCsp } from "@rlr/core/security";
import { defineConfig } from "astro/config";

const csp = astroCsp({
  mediaOrigin: "https://media.readlitrpg.com",
  turnstile: true,
  webAnalytics: true,
  formActions: ["https://checkout.stripe.com", "https://billing.stripe.com"],
});

export default defineConfig({
  site: "https://readlitrpg.com",
  output: "server",
  trailingSlash: "never",
  adapter: cloudflare({
    // Covers and blog images are served from media.readlitrpg.com as pre-built variants (DESIGN §15.7).
    imageService: "passthrough",
    // Astro sessions are unused; point the adapter at an existing namespace so none is provisioned.
    sessionKVBindingName: "CONFIG",
    persistState: { path: "../../.wrangler/state" },
  }),
  integrations: [preact()],
  // Shiki uses inline styles, which the CSP forbids. The blog (M7) will use Prism.
  markdown: { syntaxHighlight: false },
  security: {
    // The same check runs in src/middleware.ts, which can exempt signed webhooks and one-click links.
    checkOrigin: false,
    csp: {
      algorithm: "SHA-256",
      directives: [...csp.directives],
      scriptDirective: { resources: csp.scriptResources },
      styleDirective: { resources: csp.styleResources },
    },
  },
  // Public HTML is the same for every visitor and cached at the edge (DESIGN §4.6).
  // Pages add tags with Astro.cache.set({ tags }) so writes can purge them.
  cache: { provider: cacheCloudflare() },
  // Nothing purges across Workers yet, so TTLs are the freshness bound: quiz go-live shows within
  // five minutes, and match results follow the hourly model build (DESIGN §7.8).
  routeRules: {
    "/": { maxAge: 300, swr: 3600 },
    "/match": { maxAge: 3600, swr: 86400 },
    "/match/quiz": { maxAge: 3600, swr: 86400 },
    "/match/r": { maxAge: 900, swr: 3600 },
    "/find": { maxAge: 900, swr: 3600 },
    "/books-like/[slug]": { maxAge: 3600, swr: 86400 },
    "/lists": { maxAge: 3600, swr: 86400 },
    "/lists/[slug]": { maxAge: 1800, swr: 3600 },
    "/quiz": { maxAge: 300, swr: 600 },
    "/quiz/[slug]": { maxAge: 300, swr: 600 },
    "/quiz/[slug]/r/[outcome]": { maxAge: 900, swr: 3600 },
    // Entity pages: 30 minutes (DESIGN §4.6); tags and releases change more often than books.
    "/books/[slug]": { maxAge: 1800, swr: 86400 },
    "/series/[slug]": { maxAge: 1800, swr: 86400 },
    "/authors/[slug]": { maxAge: 1800, swr: 86400 },
    "/narrators/[slug]": { maxAge: 1800, swr: 86400 },
    "/tags": { maxAge: 1800, swr: 86400 },
    "/tags/[slug]": { maxAge: 1800, swr: 86400 },
    "/new": { maxAge: 300, swr: 3600 },
    "/search": { maxAge: 300, swr: 3600 },
    // Crawler files regenerate daily (DESIGN §17.2); feeds follow the release pages.
    "/robots.txt": { maxAge: 86400, swr: 86400 },
    "/sitemap.xml": { maxAge: 86400, swr: 86400 },
    "/sitemaps/[name].xml": { maxAge: 86400, swr: 86400 },
    "/feeds/releases.xml": { maxAge: 1800, swr: 3600 },
    "/feeds/releases.ics": { maxAge: 1800, swr: 3600 },
    "/feeds/tags/[slug].xml": { maxAge: 1800, swr: 3600 },
    "/feeds/tags/[slug].ics": { maxAge: 1800, swr: 3600 },
    // Blog and news: the news pages change every morning and whenever a brief lands.
    "/blog": { maxAge: 600, swr: 3600 },
    "/blog/[slug]": { maxAge: 1800, swr: 86400 },
    "/blog/type/[type]": { maxAge: 1800, swr: 3600 },
    "/news": { maxAge: 300, swr: 900 },
    "/news/today": { maxAge: 300, swr: 600 },
    "/news/[slug]": { maxAge: 900, swr: 3600 },
    "/news/[yyyy]/[mm]/[dd]": { maxAge: 900, swr: 3600 },
    "/feeds/blog.xml": { maxAge: 900, swr: 3600 },
    "/feeds/news.xml": { maxAge: 300, swr: 900 },
  },
});
