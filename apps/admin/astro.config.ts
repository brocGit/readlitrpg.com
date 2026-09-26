import cloudflare from "@astrojs/cloudflare";
import preact from "@astrojs/preact";
import { astroCsp } from "@rlr/core/security";
import { defineConfig } from "astro/config";

const csp = astroCsp({});

export default defineConfig({
  site: "https://admin.readlitrpg.com",
  output: "server",
  trailingSlash: "never",
  adapter: cloudflare({
    imageService: "passthrough",
    sessionKVBindingName: "CONFIG",
    persistState: { path: "../../.wrangler/state" },
    // web uses the default inspector port; run both locally without a clash.
    inspectorPort: 9230,
  }),
  integrations: [preact()],
  markdown: { syntaxHighlight: false },
  security: {
    checkOrigin: true,
    csp: {
      algorithm: "SHA-256",
      directives: [...csp.directives],
      scriptDirective: { resources: csp.scriptResources },
      styleDirective: { resources: csp.styleResources },
    },
  },
});
