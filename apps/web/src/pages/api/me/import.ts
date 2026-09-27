import { createLibraryImport, LibraryImportError } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { formBody, readerId, slowDown, unauthorized, writeAllowed } from "../../../lib/api";
import { getDb } from "../../../lib/runtime";

const MAX_BYTES = 5 * 1024 * 1024;

// A Goodreads or StoryGraph CSV export (DESIGN §9.7 option A). The file is parsed now and matched
// to the catalog in chunks by the library.import job; nothing is fetched from those sites.
export const POST: APIRoute = async (ctx) => {
  const userId = await readerId(ctx);
  if (!userId) return unauthorized();
  if (!(await writeAllowed(ctx, "import"))) return slowDown();
  if (Number(ctx.request.headers.get("content-length") ?? 0) > MAX_BYTES + 10_000)
    return ctx.redirect("/account/import?error=size", 303);
  const file = (await formBody(ctx.request)).get("file");
  if (!(file instanceof File) || file.size === 0) return ctx.redirect("/account/import?error=missing", 303);
  if (file.size > MAX_BYTES) return ctx.redirect("/account/import?error=size", 303);
  try {
    const { total } = await createLibraryImport(getDb(), userId, await file.text());
    return ctx.redirect(`/account/import?started=${total}`, 303);
  } catch (error) {
    if (error instanceof LibraryImportError) return ctx.redirect("/account/import?error=format", 303);
    throw error;
  }
};
