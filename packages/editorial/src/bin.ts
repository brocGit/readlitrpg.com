// Entry point for `pnpm editorial` (see cli.ts).
import { run } from "./cli";

await run(process.argv.slice(2));
