import { pickSponsoredMatch, toAdPoint } from "@rlr/core/ads";
import { isAutomated } from "@rlr/core/analytics";
import { bookCards, buildProfile, indexOfBook, matchInputsSchema, matchPercent } from "@rlr/core/match";
import { signLink } from "@rlr/core/readers";
import type { APIRoute } from "astro";
import { z } from "zod";
import { log } from "../../lib/log";
import { getMatrix, matchOptions, quizSignal, withinLimit } from "../../lib/match";
import { env, getDb, getLinkKeys } from "../../lib/runtime";
import { type SponsoredCard, validPageToken } from "../../lib/sponsored";

const bodySchema = z.object({ inputs: z.unknown(), shown: z.array(z.string().max(200)).max(30).default([]) });
const none = () => Response.json({ card: null }, { headers: { "cache-control": "no-store" } });

/**
 * One Sponsored Match for this reader's results, counted here (DESIGN §11.3): only for our own
 * pages (a same-origin call with the results page's token), never for bots or prefetches. The
 * count is the charge, so anything doubtful gets no ad rather than a charge.
 */
export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const settings = await locals.settings();
  if (!settings["flags.ads_serving"] || isAutomated(request.headers)) return none();
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return none();
  if (!(await validPageToken(request.headers.get("x-rlr-pt")))) return none();
  if (!(await withinLimit(env.RL_READ, "sponsored", request, clientAddress))) return none();
  const text = await request.text();
  if (text.length > 20_000) return none();
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(text));
  } catch {
    return none();
  }
  const inputs = matchInputsSchema.safeParse(body.inputs);
  if (!inputs.success) return none();
  const m = await getMatrix();
  if (!m || m.n === 0) return none();
  try {
    const profile = buildProfile(m, inputs.data, quizSignal(inputs.data, settings));
    const index = indexOfBook(m);
    const exclude = new Set(body.shown.map((s) => index.get(s)).filter((i): i is number => i !== undefined));
    const db = getDb();
    const pick = await pickSponsoredMatch(db, m, profile, matchOptions(settings), settings, { exclude });
    if (!pick) return none();
    const cf = (request as Request & { cf?: { country?: string } }).cf;
    env.EVENTS.writeDataPoint(
      toAdPoint("ad_served", pick.campaignId, "sponsored_match", (cf?.country ?? "").slice(0, 2)),
    );
    const book = (await bookCards(db, [pick.bookId])).get(pick.bookId);
    if (!book) return none();
    const card: SponsoredCard = {
      campaignKey: pick.campaignId,
      headline: pick.headline,
      body: pick.body,
      cta: pick.cta,
      href: `/go/${await signLink(getLinkKeys(), "go", [pick.campaignId, "sponsored_match"])}`,
      percent: matchPercent(pick.score),
      book: {
        slug: book.slug,
        title: book.title,
        series: book.series?.name ?? null,
        authors: book.authors.map((a) => a.name).join(", "),
      },
    };
    return Response.json({ card }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    // An ad must never break results.
    log.error("sponsored.failed", { error });
    return none();
  }
};
