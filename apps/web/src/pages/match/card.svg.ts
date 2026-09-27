import { buildProfile, decodeInputs, readerClass } from "@rlr/core/match";
import { classCardText } from "@rlr/core/media";
import { STATS } from "@rlr/core/taxonomy";
import { cardSvg } from "@rlr/ui/cards";
import type { APIRoute } from "astro";
import { svgResponse } from "../../lib/cards";
import { getMatrix, quizSignal } from "../../lib/match";

const STAT_NAMES = new Map(STATS.map((s) => [s.key, s.name]));
const NO_LABELS: Record<string, string> = {
  harem: "harem",
  heavy_romance: "heavy romance",
  explicit: "explicit content",
  grimdark: "grimdark",
  unfinished: "unfinished series",
};

/** The reader class card (DESIGN §9.1 "Share"): class, must-haves and hard no's. Never the person. */
export const GET: APIRoute = async ({ url, locals }) => {
  const inputs = decodeInputs(url.searchParams.get("p") ?? "");
  const m = await getMatrix();
  if (!inputs || !m) return new Response("Not found", { status: 404 });
  const profile = buildProfile(m, inputs, quizSignal(inputs, await locals.settings()));
  const { cls } = readerClass(profile);
  const musts = (inputs.musts ?? []).map((k) => STAT_NAMES.get(k) ?? k);
  const noes = (inputs.noes ?? []).map((n) => NO_LABELS[n]).filter(Boolean);
  return svgResponse(
    cardSvg(classCardText(cls, { musts, noes: noes.filter((n): n is string => Boolean(n)) })),
  );
};
