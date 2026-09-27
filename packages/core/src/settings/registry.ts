// Every tunable, its type and its default (DESIGN Appendix C, §7.13 kill switches).
// The `settings` table stores overrides only. Adding a key here is enough to ship a new setting.

import { z } from "zod";

const hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 90);
const share = z.number().min(0).max(1);
const cents = z.number().int().min(0);

export interface SettingDef<T extends z.ZodType = z.ZodType> {
  schema: T;
  default: z.infer<T>;
  description: string;
  /** Secret-adjacent or dangerous settings are shown read-only in admin. */
  readOnly?: boolean;
}

const def = <T extends z.ZodType>(schema: T, value: z.infer<T>, description: string): SettingDef<T> => ({
  schema,
  default: value,
  description,
});

export const SETTINGS = {
  // Editorial runs (§7.1, §7.13)
  "editorial.stale_hours": def(
    hours,
    36,
    "Alert the owner when no editorial run has succeeded for this long",
  ),
  "editorial.max_claim": def(z.number().int().min(1).max(1000), 200, "Most items one pull may claim"),
  "editorial.claim_hours": def(
    z.number().int().min(1).max(24),
    3,
    "Hours a run may hold claimed items before they go back to the queue",
  ),
  "editorial.priorities": def(
    z.object({
      moderate: z.number().int().min(0).max(100),
      image_review: z.number().int().min(0).max(100),
      classify: z.number().int().min(0).max(100),
      dedupe: z.number().int().min(0).max(100),
      research: z.number().int().min(0).max(100),
      // M7 content kinds; defaults so overrides saved before M7 still parse.
      news_scan: z.number().int().min(0).max(100).default(90),
      guest_review: z.number().int().min(0).max(100).default(75),
      interview_format: z.number().int().min(0).max(100).default(65),
      post_draft: z.number().int().min(0).max(100).default(30),
    }),
    {
      moderate: 80,
      image_review: 80,
      classify: 60,
      dedupe: 55,
      research: 50,
      news_scan: 90,
      guest_review: 75,
      interview_format: 65,
      post_draft: 30,
    },
    "Queue priority per kind of work (higher is claimed first)",
  ),
  "editorial.queue_batch": def(
    z.number().int().min(1).max(1000),
    200,
    "Most items the queue builder adds per kind each time it runs",
  ),
  "editorial.circuit_reject_share": def(
    share,
    0.2,
    "Share of a run's proposals failing validation that holds the rest of the run for review",
  ),
  "editorial.circuit_min_proposals": def(
    z.number().int().min(1).max(1000),
    10,
    "Proposals a run must push before the circuit breaker can trip",
  ),

  // Publishing (§7.6)
  "publish.t0_default_action_hours": def(hours, 72, "Hours before a T0 submission's default action runs"),
  "publish.reader_suggestion_default_days": def(
    z.number().int().min(1).max(60),
    7,
    "Days before a reader suggestion's default action runs",
  ),

  // Tags (§6.2)
  "tags.display_min": def(share, 0.6, "Minimum tag score to show on a book page"),
  "tags.include_min": def(share, 0.5, "Minimum tag score for include filters"),
  "tags.exclude_min": def(share, 0.3, "Minimum tag score for exclude filters"),
  "tags.crowd_min_votes": def(z.number().int().min(1), 8, "Reader votes before crowd tags count"),

  // Catalog (§7.3, §7.4)
  "catalog.fuzzy_title_min": def(
    share,
    0.6,
    "Title similarity (same author) that flags a possible duplicate",
  ),
  "enrich.batch_size": def(
    z.number().int().min(1).max(100),
    25,
    "Books looked up in Open Library and Google Books per run",
  ),
  "enrich.retry_days": def(
    z.number().int().min(1).max(365),
    30,
    "Days before a book with no match is looked up again",
  ),
  "catalog.embedding_dup_min": def(
    share,
    0.92,
    "Embedding similarity (with a shared author) that flags a possible duplicate",
  ),
  "embed.batch_size": def(z.number().int().min(1).max(90), 50, "Books embedded per run of the vectors job"),
  "import.chunk_size": def(
    z.number().int().min(1).max(40),
    20,
    "Rows ingested per import job run (D1 allows 1,000 queries per run)",
  ),

  // Matching (§7.8)
  "match.weights": def(
    z
      .object({ dial: share, stat: share, tag: share, semantic: share, quality: share })
      .refine(
        (w) => Math.abs(w.dial + w.stat + w.tag + w.semantic + w.quality - 1) < 1e-6,
        "weights must sum to 1",
      ),
    { dial: 0.35, stat: 0.2, tag: 0.2, semantic: 0.15, quality: 0.1 },
    "Match score weights",
  ),
  "match.bounced_penalty": def(share, 0.3, "How hard likeness to a bounced-off book pushes a match down"),
  "match.classic_slugs": def(
    z.array(z.string().max(120)).max(60),
    [],
    "Books the Match Quiz asks readers to rate first (slugs; empty = the most complete published books)",
  ),
  "match.max_headsups": def(z.number().int().min(0).max(10), 3, "Most heads-ups shown per result"),
  "match.min_display_score": def(share, 0.6, "Lowest match score shown to readers"),
  "stats.display_min_appraisals": def(
    z.number().int().min(1),
    5,
    "Appraisals before a judgment stat is shown",
  ),

  // Billing (§12)
  "billing.author_pro_price_month": def(
    z.string().max(100),
    "",
    "Stripe Price ID for Author Pro, monthly (price_…); empty keeps it off sale",
  ),
  "billing.author_pro_price_year": def(z.string().max(100), "", "Stripe Price ID for Author Pro, yearly"),
  "billing.author_pro_month_cents": def(
    cents,
    900,
    "Author Pro monthly price as shown (match the Stripe Price)",
  ),
  "billing.author_pro_year_cents": def(
    cents,
    9_000,
    "Author Pro yearly price as shown (match the Stripe Price)",
  ),
  "billing.author_pro_quarterly_credit_cents": def(
    cents,
    2_000,
    "Promo credit Author Pro members get each quarter",
  ),
  "billing.automatic_tax": def(z.boolean(), false, "Ask Stripe Tax to calculate tax at checkout"),

  // Owner Inbox and notifications (§8)
  "inbox.low_risk_max": def(
    z.number().int().min(0).max(100),
    30,
    'Highest risk score "Approve all low-risk" includes',
  ),
  "owner.alert_min_priority": def(
    z.number().int().min(0).max(100),
    90,
    "Inbox items at or above this priority alert the owner at once (email, and Discord if set up)",
  ),
  "owner.daily_digest": def(
    z.boolean(),
    true,
    "Email the owner at 13:00 UTC when something is due or urgent",
  ),
  "owner.weekly_summary": def(z.boolean(), true, "Email the owner a summary every Sunday"),

  // Quizzes (§7.16)
  "quiz.fun_effect_importance": def(share, 0.3, "Weight of fun-quiz answers relative to Match Quiz answers"),
  "quiz.auto_publish_hours": def(
    z.number().int().min(0).max(720),
    48,
    "Hours a new quiz waits in the inbox before it goes live unless vetoed (0 = wait for the owner)",
  ),
  "quiz.balance_max_share": def(
    share,
    0.25,
    "Most any outcome may win in the balance simulation (8 outcomes)",
  ),
  "quiz.balance_min_share": def(
    share,
    0.03,
    "Least any outcome may win in the balance simulation (8 outcomes)",
  ),

  // Ads (§11)
  "ads.sponsored_match_min_score": def(share, 0.7, "Lowest match score for a Sponsored Match"),
  "ads.hold_minutes": def(
    z.number().int().min(5).max(240),
    30,
    "Minutes an inventory hold lasts during checkout",
  ),
  "ads.auto_approve_risk_max": def(
    z.number().int().min(0).max(100),
    20,
    "Highest risk score that auto-approves",
  ),
  "ads.t0_daily_spend_cap_cents": def(cents, 15_000, "Daily spend cap for T0 advertisers"),
  "ads.max_sponsored_per_email": def(z.number().int().min(0).max(5), 2, "Most sponsored slots per email"),
  "ads.prices": def(
    z.record(z.string(), cents),
    {
      home_spotlight: 1_000,
      tag_sponsor: 1_000,
      books_like_sponsor: 1_500,
      newsletter_top: 2_500,
      newsletter_standard: 1_500,
    },
    "Price of each placement period, in cents (new inventory takes a changed price; bookings keep theirs)",
  ),
  "ads.min_lead_days": def(
    z.number().int().min(1).max(60),
    3,
    "Days ahead a paid placement must start (time for the creative review)",
  ),
  "ads.max_periods": def(z.number().int().min(1).max(26), 8, "Most periods (days or weeks) in one booking"),
  "ads.max_open_holds": def(
    z.number().int().min(1).max(100),
    10,
    "Most places one advertiser may hold at once",
  ),
  "ads.checkout_attempts_per_hour": def(
    z.number().int().min(1).max(100),
    6,
    "Checkouts one advertiser may start in an hour",
  ),
  "ads.sponsored_match_cpm_cents": def(cents, 800, "Sponsored Match price per 1,000 qualified impressions"),
  "ads.sponsored_match_min_budget_cents": def(cents, 2_000, "Smallest Sponsored Match budget"),
  "ads.sponsored_match_max_days": def(z.number().int().min(1).max(120), 60, "Longest Sponsored Match flight"),
  "ads.target_cpm_cents": def(
    z.object({ newsletter: cents, web: cents }),
    { newsletter: 200, web: 400 },
    "Target CPMs",
  ),
  "ads.price_floor_cents": def(cents, 1000, "Lowest price for any placement"),

  // Email (§13)
  "email.daily_cap": def(z.number().int().min(0), 50_000, "Most emails per day (raise with warm-up)"),
  "email.circuit.complaint_rate": def(share, 0.0008, "Complaint rate that pauses sending"),
  "email.circuit.bounce_rate": def(share, 0.04, "Bounce rate that pauses sending"),
  "email.direct_affiliate_links": def(z.boolean(), false, "Put affiliate links directly in emails"),
  "email.digest_quiet": def(
    z.enum(["send", "skip"]),
    "send",
    "Readers with nothing new this week: send a short issue with top picks, or skip them",
  ),
  "email.digest_chunk": def(
    z.number().int().min(1).max(60),
    40,
    "Patch Notes readers built per job run (each run stays under D1's query limit)",
  ),
  "email.postal_address": def(
    z.string().max(300),
    "",
    "Postal address in every marketing email's footer (CAN-SPAM); marketing mail waits until it is set",
  ),
  "affiliate.amazon_tag_web": def(
    z.string().regex(/^([a-z0-9-]{1,40}-2\d)?$/),
    "",
    "Amazon Associates tracking ID for store links on the site (empty = plain links, no disclosure)",
  ),

  // Blog (§14)
  "blog.auto_publish_roundups": def(z.boolean(), false, "Publish roundups without review"),
  "blog.min_books_per_roundup": def(z.number().int().min(1), 8, "Fewest books a roundup needs"),
  "blog.calendar": def(
    z.record(
      z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
      z.array(z.enum(["roundup", "news", "editorial", "guest", "owner"])).max(5),
    ),
    { mon: ["roundup"], tue: ["guest"], wed: ["editorial"], thu: ["guest"], fri: [], sat: [], sun: [] },
    "Which kinds of approved post take which weekday's slot (guest covers interviews too)",
  ),
  "blog.publish_hour_utc": def(z.number().int().min(0).max(23), 13, "Hour (UTC) slotted posts go live"),
  "blog.ai_draft_veto_hours": def(hours, 72, "Hours an AI-drafted post waits for a veto before it publishes"),
  "news.auto_publish_briefs": def(
    z.boolean(),
    true,
    "Publish a news brief once its cited page is checked; off sends every brief to the inbox",
  ),
  "news.daily_min_items": def(
    z.number().int().min(0).max(50),
    3,
    'Fewest items a "Today in LitRPG" needs to be indexed by search engines (thinner days still publish)',
  ),
  "blog.guest_review_days": def(
    z.number().int().min(1).max(30),
    5,
    "Days before a clean guest post or interview from a verified author approves itself",
  ),

  // Sessions (§15.3)
  "session.reader_days": def(z.number().int().min(1).max(90), 30, "Reader session length (sliding)"),
  "session.author_days": def(z.number().int().min(1).max(90), 14, "Author session length (sliding)"),
  "session.admin_hours": def(z.number().int().min(1).max(24), 12, "Admin session length (absolute)"),
  "session.epoch": def(
    z.number().int().min(0),
    0,
    "Bump to sign everyone out: sessions created before it are rejected",
  ),

  // Kill switches and feature flags (§7.13)
  "flags.editorial_api": def(z.boolean(), true, "Accept editorial runs"),
  "flags.auto_publish": def(z.boolean(), true, "Let the policy engine publish without review"),
  "flags.signups": def(z.boolean(), true, "Allow new accounts"),
  "flags.author_submissions": def(z.boolean(), true, "Allow author book submissions"),
  "flags.guest_posts": def(z.boolean(), true, "Allow guest post pitches"),
  "flags.ads_paid": def(z.boolean(), false, "Sell paid placements"),
  "flags.author_pro": def(z.boolean(), false, "Sell the Author Pro subscription"),
  "flags.ads_serving": def(z.boolean(), true, "Serve ads, including house ads"),
  "flags.newsletter_send": def(z.boolean(), true, "Send newsletters"),
  "flags.read_only_mode": def(z.boolean(), false, "Refuse all writes (incidents and migrations)"),
  "flags.indexable": def(z.boolean(), false, "Let search engines index the site (turn on at launch)"),
} satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;
export type Settings = { [K in SettingKey]: SettingValue<K> };

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export function defaultSettings(): Settings {
  const out: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(SETTINGS)) out[key] = structuredClone(d.default);
  return out as Settings;
}
