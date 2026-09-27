// Receiving proposals (DESIGN §7.1 step 4). Each proposal is validated again here, checked against
// the item the run claimed, and handed to the policy engine (§7.6). Only then is it applied, through
// the same provenance code as every other write (source "ai"), or held for the Owner Inbox.

import { and, eq } from "drizzle-orm";
import { appendAudit } from "../audit";
import { notifyAuthor } from "../authors/notices";
import { type FieldWrite, writeBookFields } from "../catalog/fields";
import { titleKey } from "../catalog/normalize";
import { writeAiScores } from "../catalog/scores";
import { replaceAiTags } from "../catalog/tags";
import type { Db } from "../db";
import {
  authorPastes,
  authorSubmissions,
  bookAuthors,
  books,
  editorialProposals,
  inboxItems,
  type ProposalStatus,
} from "../db/schema";
import { ulid } from "../ids";
import { decideInboxItem, getInboxItem, openInboxItem } from "../inbox";
import { rejectMedia } from "../media/pipeline";
import { decideClassification, type InboxPlan } from "../policy/publish";
import type { Settings } from "../settings";
import { crunchLevelFromDial, romanceLevelFromDial } from "../taxonomy";
import { addHours, nowIso } from "../time";
import {
  DEFAULT_RENDER_ENV,
  handleGuestReview,
  handleInterviewFormat,
  handleNewsScan,
  handlePostDraft,
} from "./content";
import { claimedByRun, closeItem, type QueueItem } from "./queue";
import { type EditorialRun, getRun, recordOutcomes } from "./runs";
import {
  type ClassifyProposal,
  confidenceValue,
  type DedupeProposal,
  type ImageReviewProposal,
  type ImportExtractProposal,
  type ModerateProposal,
  type Proposal,
  proposalItemId,
  type ResearchProposal,
  validateProposal,
} from "./schemas";

/** Stamped on books when a classification is applied; bump when the classify skill changes a lot. */
export const CLASSIFY_VERSION = 1;

export interface PushOutcome {
  item_id: string | null;
  proposal_id: string;
  status: ProposalStatus;
  reasons: string[];
}

interface Handled {
  status: ProposalStatus;
  reasons: string[];
  result?: unknown;
  inboxItemId?: string | null;
  /** Close the queue item: done when answered, rejected when the subject is gone. */
  close: "done" | "rejected" | null;
}

export interface PushContext {
  db: Db;
  runId: string;
  settings: Settings;
  /** Where links in posts a proposal creates point (the public site). */
  renderEnv?: { origin: string; mediaOrigin: string };
}

const MAX_STORED_PAYLOAD = 20_000;

function storable(raw: unknown): unknown {
  const text = JSON.stringify(raw ?? null);
  return text.length > MAX_STORED_PAYLOAD ? { truncated: true, length: text.length } : raw;
}

/** Validate, decide and apply a batch of proposals from one run. */
export async function pushProposals(ctx: PushContext, raws: unknown[]): Promise<PushOutcome[]> {
  const { db, runId, settings } = ctx;
  const circuit = {
    rejectShare: settings["editorial.circuit_reject_share"],
    minProposals: settings["editorial.circuit_min_proposals"],
  };
  const ids = raws.map(proposalItemId).filter((id): id is string => id !== null);
  const claimed = await claimedByRun(db, runId, ids);
  let run = await getRun(db, runId);
  const outcomes: PushOutcome[] = [];

  for (const raw of raws) {
    const itemId = proposalItemId(raw);
    const item = itemId ? claimed.get(itemId) : undefined;
    let handled: Handled;
    let proposal: Proposal | null = null;
    const validation = validateProposal(raw);
    if (!validation.ok) {
      // The item stays claimed, so the run can fix the proposal and push it again.
      handled = { status: "rejected", reasons: validation.errors, close: null };
    } else if (!item) {
      handled = {
        status: "rejected",
        reasons: ["item_id is not claimed by this run (never claimed, expired, or already answered)"],
        close: null,
      };
    } else if (item.kind !== validation.proposal.kind) {
      handled = {
        status: "rejected",
        reasons: [`item ${item.id} is ${item.kind} work, not ${validation.proposal.kind}`],
        close: null,
      };
    } else {
      proposal = validation.proposal;
      handled = await handle(db, proposal, item, run, settings, ctx.renderEnv ?? DEFAULT_RENDER_ENV);
    }

    const proposalId = ulid();
    let inboxItemId = handled.inboxItemId ?? null;
    await db.insert(editorialProposals).values({
      id: proposalId,
      runId,
      queueItemId: item?.id ?? null,
      kind: proposal?.kind ?? item?.kind ?? "classify",
      subjectType: item?.subjectType ?? null,
      subjectId: item?.subjectId ?? null,
      payload: storable(proposal ?? raw),
      status: handled.status,
      reasons: handled.reasons,
      result: handled.result ?? null,
      inboxItemId,
      createdAt: nowIso(),
    });
    if (handled.status === "held" && proposal && item) {
      inboxItemId = await openHoldItem(db, run, proposalId, item, handled);
      if (inboxItemId) {
        await db.update(editorialProposals).set({ inboxItemId }).where(eq(editorialProposals.id, proposalId));
      }
    }
    if (item && handled.close) {
      await closeItem(db, item.id, handled.close);
      claimed.delete(item.id);
    }
    run = await recordOutcomes(
      db,
      runId,
      {
        accepted: handled.status === "accepted" || handled.status === "pending_check" ? 1 : 0,
        rejected: handled.status === "rejected" ? 1 : 0,
        held: handled.status === "held" ? 1 : 0,
      },
      circuit,
    );
    outcomes.push({
      item_id: itemId,
      proposal_id: proposalId,
      status: handled.status,
      reasons: handled.reasons,
    });
  }
  return outcomes;
}

async function handle(
  db: Db,
  p: Proposal,
  item: QueueItem,
  run: EditorialRun | null,
  settings: Settings,
  renderEnv: { origin: string; mediaOrigin: string },
): Promise<Handled> {
  switch (p.kind) {
    case "classify":
      return handleClassify(db, p, item, run, settings);
    case "dedupe":
      return handleDedupe(db, p, item, run);
    case "research":
      return handleResearch(db, p, item);
    case "moderate":
    case "image_review":
      return handleModeration(db, p, item);
    case "import_extract":
      return handleImportExtract(db, p, item);
    case "news_scan":
      return handleNewsScan(db, p, item);
    case "post_draft":
      return handlePostDraft(db, p, item, settings, renderEnv);
    case "guest_review":
      return handleGuestReview(db, p, item, settings);
    case "interview_format":
      return handleInterviewFormat(db, p, item);
  }
}

// ---------------------------------------------------------------------------------------------
// import_extract ("paste anything", DESIGN §10.3 step 0)

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Turn the run's reading of a paste into drafts the author confirms. Only what the paste itself
 * contains is kept (titles, links, blurbs), and books the author already has are skipped, so the
 * drafts can't carry anything invented. Nothing is published here.
 */
async function handleImportExtract(db: Db, p: ImportExtractProposal, item: QueueItem): Promise<Handled> {
  if (item.subjectType !== "author_paste" || item.subjectId !== p.paste_id)
    return { status: "rejected", reasons: [`paste_id must be ${item.subjectId}`], close: null };
  const [paste] = await db.select().from(authorPastes).where(eq(authorPastes.id, p.paste_id));
  if (paste?.status !== "queued")
    return { status: "rejected", reasons: ["the paste is gone or done"], close: "rejected" };
  const text = squash(paste.text);
  const existing = new Set(
    (
      await db
        .select({ key: books.titleKey })
        .from(bookAuthors)
        .innerJoin(books, eq(books.id, bookAuthors.bookId))
        .where(eq(bookAuthors.authorId, paste.authorId))
    ).map((b) => b.key),
  );
  const seen = new Set<string>();
  const drafts: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  for (const b of p.books) {
    const key = titleKey(b.title);
    if (!text.includes(squash(b.title))) {
      dropped.push(`"${b.title.slice(0, 60)}" isn't in the pasted text`);
      continue;
    }
    if (!key || existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    drafts.push({
      title: b.title,
      ...(b.series_name ? { series: { name: b.series_name, position: b.series_position } } : {}),
      coAuthors: b.coauthors ?? [],
      primaryGenre: b.genre ?? "",
      blurb: b.blurb && text.includes(squash(b.blurb)) ? b.blurb : undefined,
      links: (b.links ?? []).filter((l) => paste.text.includes(l)),
      releases: b.releases ?? [],
    });
  }
  const now = nowIso();
  const rows = drafts.map((payload) => ({
    id: ulid(),
    authorId: paste.authorId,
    userId: paste.userId,
    source: "paste" as const,
    status: "draft" as const,
    payload,
    pasteId: paste.id,
    createdAt: now,
    updatedAt: now,
  }));
  // Nine bound parameters a row: stay under D1's 100 per statement.
  for (let i = 0; i < rows.length; i += 10) await db.insert(authorSubmissions).values(rows.slice(i, i + 10));
  await db
    .update(authorPastes)
    .set({ status: "extracted", drafts: drafts.length, extractedAt: now })
    .where(eq(authorPastes.id, paste.id));
  await notifyAuthor(db, {
    authorId: paste.authorId,
    userId: paste.userId,
    kind: "drafts_ready",
    payload: { drafts: drafts.length },
  });
  return {
    status: "accepted",
    reasons: dropped.slice(0, 10),
    result: { drafts: drafts.length, dropped: dropped.length },
    close: "done",
  };
}

// ---------------------------------------------------------------------------------------------
// classify

async function handleClassify(
  db: Db,
  p: ClassifyProposal,
  item: QueueItem,
  run: EditorialRun | null,
  settings: Settings,
): Promise<Handled> {
  if (item.subjectType !== "book" || item.subjectId !== p.book_id) {
    return { status: "rejected", reasons: [`book_id must be ${item.subjectId}`], close: null };
  }
  const [book] = await db.select().from(books).where(eq(books.id, p.book_id));
  if (!book || book.redirectTo || book.visibility === "removed") {
    return { status: "rejected", reasons: ["the book was merged or removed"], close: "rejected" };
  }
  const decision = decideClassification({
    visibility: book.visibility,
    inScope: p.in_scope,
    anomalies: p.anomalies,
    autoPublish: settings["flags.auto_publish"],
    circuitOpen: run?.circuitOpen ?? false,
  });
  if (decision.outcome === "hold") {
    return {
      status: "held",
      reasons: decision.reasons,
      result: { plan: decision.inbox, title: book.title },
      close: "done",
    };
  }
  const result = await applyClassification(db, p, run?.id ?? "unknown", settings);
  let inboxItemId: string | null = null;
  if (decision.followUp) {
    const opened = await openInboxItem(db, {
      ...planFields(decision.followUp),
      title: `Out of scope? "${book.title}"`,
      subjectType: "book",
      subjectId: book.id,
      aiSummary: p.notes ?? decision.reasons.join("; "),
      aiRecommendation: "approve",
      payload: { bookId: book.id, runId: run?.id },
      dedupeKey: `scope:${book.id}`,
    });
    inboxItemId = opened?.id ?? null;
  }
  return { status: "accepted", reasons: decision.reasons, result, inboxItemId, close: "done" };
}

export async function applyClassification(
  db: Db,
  p: ClassifyProposal,
  runId: string,
  settings: Settings,
): Promise<Record<string, unknown>> {
  const crunchDial = p.dials.crunch?.value;
  const romanceDial = p.dials.romance?.value;
  const crunch =
    p.crunch_level.value !== "unknown"
      ? p.crunch_level.value
      : typeof crunchDial === "number"
        ? crunchLevelFromDial(crunchDial)
        : undefined;
  const romance =
    p.romance_level.value !== "unknown"
      ? p.romance_level.value
      : typeof romanceDial === "number"
        ? romanceLevelFromDial(romanceDial)
        : undefined;
  const writes: FieldWrite[] = [
    { field: "primaryGenre", value: p.primary_genre, confidence: confidenceValue("medium") },
    { field: "inScope", value: p.in_scope, confidence: confidenceValue("medium") },
    { field: "contentFlags", value: [...p.content_flags].sort() },
  ];
  if (crunch !== undefined) {
    writes.push({
      field: "crunchLevel",
      value: crunch,
      confidence: confidenceValue(p.crunch_level.confidence),
    });
  }
  if (romance !== undefined) {
    writes.push({
      field: "romanceLevel",
      value: romance,
      confidence: confidenceValue(p.romance_level.confidence),
    });
  }
  if (p.harem.value !== "unknown") {
    writes.push({ field: "harem", value: p.harem.value, confidence: confidenceValue(p.harem.confidence) });
  }
  if (p.summary) writes.push({ field: "summaryAi", value: p.summary });
  if (p.hook) writes.push({ field: "hookAi", value: p.hook });
  const ctx = { source: "ai" as const, sourceRef: `run:${runId}` };
  const fields = await writeBookFields(db, p.book_id, writes, ctx);
  const tagResult = await replaceAiTags(
    db,
    p.book_id,
    p.tags.map((t) => ({ slug: t.slug, value: confidenceValue(t.confidence) })),
    settings["tags.crowd_min_votes"],
  );
  const scoreWrites = [...Object.entries(p.dials), ...Object.entries(p.stats)].map(([key, v]) => ({
    key,
    value: v.value === "unknown" ? null : v.value,
    confidence: confidenceValue(v.confidence),
  }));
  const scores = await writeAiScores(db, p.book_id, scoreWrites, settings["stats.display_min_appraisals"]);
  const now = nowIso();
  await db
    .update(books)
    .set({ classifiedAt: now, classificationVersion: CLASSIFY_VERSION, updatedAt: now })
    .where(eq(books.id, p.book_id));
  return {
    fields,
    tags: { written: tagResult.written.length, cleared: tagResult.cleared, unknown: tagResult.unknown },
    scores,
    knownWork: p.known_work,
  };
}

// ---------------------------------------------------------------------------------------------
// dedupe: pre-judge a "Possible duplicate" inbox item (§7.4). Merging stays the owner's click.

async function handleDedupe(
  db: Db,
  p: DedupeProposal,
  item: QueueItem,
  run: EditorialRun | null,
): Promise<Handled> {
  const inboxItem = await getInboxItem(db, item.subjectId);
  if (inboxItem?.type !== "possible_duplicate") {
    return { status: "rejected", reasons: ["the duplicate question is gone"], close: "rejected" };
  }
  if (inboxItem.status !== "open" && inboxItem.status !== "snoozed") {
    return {
      status: "accepted",
      reasons: ["already decided by the owner"],
      result: { skipped: true },
      close: "done",
    };
  }
  const payload = (inboxItem.payload ?? {}) as Record<string, unknown>;
  const pair = [payload.bookId, payload.otherId];
  if (p.keep_id && !pair.includes(p.keep_id)) {
    return { status: "rejected", reasons: ["keep_id must be one of the two books"], close: null };
  }
  const recommendation =
    p.verdict === "same_work" ? "approve" : p.verdict === "different_work" ? "reject" : "escalate";
  const now = nowIso();
  await db
    .update(inboxItems)
    .set({
      aiSummary: `${p.verdict.replace("_", " ")} (${p.confidence}): ${p.reasons}`.slice(0, 1000),
      aiRecommendation: recommendation,
      payload: {
        ...payload,
        ai: { verdict: p.verdict, confidence: p.confidence, keepId: p.keep_id ?? null, runId: run?.id },
      },
      updatedAt: now,
    })
    .where(eq(inboxItems.id, inboxItem.id));
  // A confident "these are different books" closes the question. Nothing is merged or deleted, so
  // a wrong call costs only a duplicate the owner can still merge from the book page.
  let closed = false;
  if (p.verdict === "different_work" && p.confidence === "high") {
    closed = await decideInboxItem(db, inboxItem.id, {
      status: "auto_rejected",
      decidedBy: `editorial:${run?.id ?? "run"}`,
      reasonCode: "ai_different_work",
    });
  }
  return {
    status: "accepted",
    reasons: [],
    result: { recommendation, closed },
    inboxItemId: inboxItem.id,
    close: "done",
  };
}

// ---------------------------------------------------------------------------------------------
// research: cited confirmations for seeds (§7.15). Nothing is applied until the citations job has
// fetched a cited page and found the title and author on it.

async function handleResearch(db: Db, p: ResearchProposal, item: QueueItem): Promise<Handled> {
  if (item.subjectType !== "book" || item.subjectId !== p.book_id) {
    return { status: "rejected", reasons: [`book_id must be ${item.subjectId}`], close: null };
  }
  const [book] = await db.select().from(books).where(eq(books.id, p.book_id));
  if (!book || book.redirectTo || book.visibility === "removed") {
    return { status: "rejected", reasons: ["the book was merged or removed"], close: "rejected" };
  }
  if (p.verdict === "not_found") {
    const opened = await openInboxItem(db, {
      type: "seed_check",
      title: `Research couldn't find "${book.title}"`,
      subjectType: "book",
      subjectId: book.id,
      priority: 30,
      aiSummary: p.notes ?? "No source could confirm this record.",
      aiRecommendation: book.visibility === "published" ? "escalate" : "reject",
      payload: { bookId: book.id, verdict: p.verdict },
      dedupeKey: `seed_check:${book.id}`,
    });
    return {
      status: "accepted",
      reasons: [],
      result: { verdict: p.verdict },
      inboxItemId: opened?.id ?? null,
      close: "done",
    };
  }
  return { status: "pending_check", reasons: ["waiting for the citation check"], close: "done" };
}

// ---------------------------------------------------------------------------------------------
// moderate / image_review: record the verdict; anything but "allow" goes to the owner.

async function handleModeration(
  db: Db,
  p: ModerateProposal | ImageReviewProposal,
  item: QueueItem,
): Promise<Handled> {
  if (p.verdict === "allow")
    return { status: "accepted", reasons: [], result: { verdict: p.verdict }, close: "done" };
  // A blocked image comes down at once; "review" stays up until the owner decides.
  if (p.kind === "image_review" && p.verdict === "block" && item.subjectType === "media") {
    await rejectMedia(db, item.subjectId);
  }
  const opened = await openInboxItem(db, {
    type: "moderation_flag",
    title: `${p.kind === "image_review" ? "Image" : "Text"} flagged (${p.verdict}): ${item.subjectType}`,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    priority: p.verdict === "block" ? 80 : 50,
    aiSummary: [p.categories.join(", "), p.reasons].filter(Boolean).join(" — "),
    aiRecommendation: p.verdict === "block" ? "reject" : "escalate",
    payload: { verdict: p.verdict, categories: p.categories, queueItemId: item.id },
    dedupeKey: `moderation:${item.id}`,
  });
  return {
    status: "accepted",
    reasons: [],
    result: { verdict: p.verdict },
    inboxItemId: opened?.id ?? null,
    close: "done",
  };
}

// ---------------------------------------------------------------------------------------------
// Held proposals: the owner applies or discards them from the inbox or the run page.

function planFields(plan: InboxPlan) {
  return {
    type: plan.type,
    priority: plan.priority,
    defaultAction: plan.defaultAction,
    defaultActionAt: plan.afterHours === null ? undefined : addHours(nowIso(), plan.afterHours),
  };
}

async function openHoldItem(
  db: Db,
  run: EditorialRun | null,
  proposalId: string,
  item: QueueItem,
  handled: Handled,
): Promise<string | null> {
  const plan = (handled.result as { plan?: InboxPlan } | undefined)?.plan;
  const title = (handled.result as { title?: string } | undefined)?.title ?? item.subjectId;
  if (plan?.type === "editorial_run_held" && run) {
    // One item per run: the run page lists everything it holds.
    const opened = await openInboxItem(db, {
      ...planFields(plan),
      title: `An editorial run is on hold: too many proposals failed validation`,
      subjectType: "editorial_run",
      subjectId: run.id,
      aiSummary: handled.reasons.join("; "),
      payload: { runId: run.id },
      dedupeKey: `run_held:${run.id}`,
    });
    if (opened) return opened.id;
    const [existing] = await db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(eq(inboxItems.dedupeKey, `run_held:${run.id}`));
    return existing?.id ?? null;
  }
  const opened = await openInboxItem(db, {
    ...(plan ? planFields(plan) : { type: "classification_review", priority: 50 }),
    title: `Review classification: "${title}"`,
    subjectType: "editorial_proposal",
    subjectId: proposalId,
    aiSummary: handled.reasons.join("; "),
    aiRecommendation: "escalate",
    payload: { proposalId, bookId: item.subjectId, runId: run?.id },
    dedupeKey: `proposal:${proposalId}`,
  });
  return opened?.id ?? null;
}

export class ProposalDecisionError extends Error {}

/** The owner applies a held proposal. It is validated again: the taxonomy may have moved on. */
export async function applyHeldProposal(
  db: Db,
  proposalId: string,
  actorId: string,
  settings: Settings,
): Promise<void> {
  const [row] = await db.select().from(editorialProposals).where(eq(editorialProposals.id, proposalId));
  if (row?.status !== "held") throw new ProposalDecisionError("that proposal isn't waiting for review");
  const validation = validateProposal(row.payload);
  if (!validation.ok) throw new ProposalDecisionError(`no longer valid: ${validation.errors.join("; ")}`);
  const p = validation.proposal;
  if (p.kind !== "classify") throw new ProposalDecisionError("only classifications are held for review");
  const [book] = await db.select().from(books).where(eq(books.id, p.book_id));
  if (!book || book.redirectTo || book.visibility === "removed") {
    throw new ProposalDecisionError("the book was merged or removed");
  }
  const result = await applyClassification(db, p, row.runId, settings);
  await settleHeld(db, row, "accepted", actorId, result);
}

export async function discardHeldProposal(db: Db, proposalId: string, actorId: string): Promise<void> {
  const [row] = await db.select().from(editorialProposals).where(eq(editorialProposals.id, proposalId));
  if (row?.status !== "held") throw new ProposalDecisionError("that proposal isn't waiting for review");
  await settleHeld(db, row, "discarded", actorId, row.result);
}

async function settleHeld(
  db: Db,
  row: typeof editorialProposals.$inferSelect,
  status: "accepted" | "discarded",
  actorId: string,
  result: unknown,
) {
  const now = nowIso();
  const updated = await db
    .update(editorialProposals)
    .set({ status, decidedBy: actorId, decidedAt: now, result: result ?? null })
    .where(and(eq(editorialProposals.id, row.id), eq(editorialProposals.status, "held")))
    .returning({ id: editorialProposals.id });
  if (updated.length === 0) throw new ProposalDecisionError("someone else already decided it");
  if (row.inboxItemId) {
    const item = await getInboxItem(db, row.inboxItemId);
    // A per-run hold item closes once nothing in the run is left waiting.
    const stillHeld =
      item?.type === "editorial_run_held"
        ? await db
            .select({ id: editorialProposals.id })
            .from(editorialProposals)
            .where(and(eq(editorialProposals.runId, row.runId), eq(editorialProposals.status, "held")))
            .limit(1)
        : [];
    if (item && stillHeld.length === 0) {
      await decideInboxItem(db, item.id, {
        status: status === "accepted" ? "approved" : "rejected",
        decidedBy: actorId,
        reasonCode: status === "accepted" ? "applied" : "discarded",
      });
    }
  }
  await appendAudit(db, {
    actor: { type: "admin", id: actorId },
    action: status === "accepted" ? "editorial.proposal_apply" : "editorial.proposal_discard",
    subjectType: "editorial_proposal",
    subjectId: row.id,
    diff: { runId: row.runId, kind: row.kind, subjectId: row.subjectId },
  });
}
