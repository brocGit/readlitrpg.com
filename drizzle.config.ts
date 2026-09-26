import { defineConfig } from "drizzle-kit";

// Migrations are generated from the schema, then reviewed by hand (DESIGN §4.4).
// Apply locally with `pnpm db:migrate:local`; CI applies them to staging and production.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/db/schema/index.ts",
  out: "./migrations",
});
