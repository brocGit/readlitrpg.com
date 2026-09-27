// The publish policy engine (DESIGN §7.6). Pure functions with truth-table tests: editorial runs and
// submissions propose, and these rules decide what publishes, what waits in the Owner Inbox, and
// what is refused. Every threshold comes from settings so the owner can widen or narrow automation.

export interface InboxPlan {
  type: string;
  /** Higher is more urgent (100 pages the owner). */
  priority: number;
  defaultAction: "approve" | "reject" | "none";
  /** Hours until the default action runs; null means it waits for the owner. */
  afterHours: number | null;
}

// ---------------------------------------------------------------------------------------------
// New listings (author submissions from M6, reader suggestions, owner and seed records)

export type Submitter = "author_t2" | "author_t1" | "author_t0" | "reader" | "owner" | "seed" | "import";

export interface ListingInput {
  submitter: Submitter;
  inScope: "yes" | "borderline" | "no" | "unknown";
  anomalies: readonly string[];
  /** Entity resolution's answer (§7.4); an editorial run may have pre-judged it. */
  duplicate: "new" | "own_stub" | "same_work" | "unsure";
  linksOk: boolean;
  /** null when there is no cover. */
  coverOk: boolean | null;
  lowConfidenceTags: boolean;
  haremOrRomanceUnknown: boolean;
  autoPublish: boolean;
  t0DefaultHours: number;
  readerSuggestionDays: number;
}

export type ListingDecision =
  | { outcome: "publish"; followUp?: InboxPlan; reasons: string[] }
  | { outcome: "inbox"; inbox: InboxPlan; reasons: string[] }
  | { outcome: "reject"; reasons: string[] }
  /** Owner, seed and import records stay drafts until the publication gate passes (§7.15). */
  | { outcome: "draft"; reasons: string[] };

const WAIT = (type: string, priority: number): InboxPlan => ({
  type,
  priority,
  defaultAction: "none",
  afterHours: null,
});

const TAG_CHECK: InboxPlan = {
  type: "tag_check",
  priority: 20,
  defaultAction: "approve",
  afterHours: 7 * 24,
};

/** The §7.6 table, first matching row wins. */
export function decideListing(input: ListingInput): ListingDecision {
  const { submitter } = input;
  if (input.anomalies.includes("instructions_in_text")) {
    return {
      outcome: "inbox",
      inbox: WAIT("listing_flagged", 90),
      reasons: ["the text contains instructions aimed at our tools"],
    };
  }
  if (input.inScope === "no" || input.anomalies.includes("not_fiction")) {
    if (submitter === "owner" || submitter === "seed" || submitter === "import") {
      return { outcome: "draft", reasons: ["out of scope: stays a draft for the owner to decide"] };
    }
    return { outcome: "reject", reasons: ["out of scope for LitRPG and progression fantasy"] };
  }
  if (input.duplicate === "unsure" || input.duplicate === "same_work") {
    return { outcome: "inbox", inbox: WAIT("possible_duplicate", 50), reasons: ["may duplicate a listing"] };
  }
  if (submitter === "owner" || submitter === "seed" || submitter === "import") {
    return { outcome: "draft", reasons: ["published by the owner once confirmed (publication gate)"] };
  }
  if (input.inScope === "borderline") {
    return { outcome: "inbox", inbox: WAIT("scope_check", 40), reasons: ["borderline scope"] };
  }
  if (!input.linksOk || input.coverOk === false) {
    return {
      outcome: "inbox",
      inbox: WAIT("listing_checks_failed", 50),
      reasons: [!input.linksOk ? "a link failed the allowlist" : "the cover failed its checks"],
    };
  }
  if (submitter === "author_t1" || submitter === "author_t2") {
    if (!input.autoPublish) {
      return {
        outcome: "inbox",
        inbox: WAIT("listing_review", 50),
        reasons: ["auto-publish is switched off"],
      };
    }
    if (input.lowConfidenceTags || input.haremOrRomanceUnknown) {
      return {
        outcome: "publish",
        followUp: TAG_CHECK,
        reasons: ["verified author; some tags need a check"],
      };
    }
    return { outcome: "publish", reasons: ["verified author, all checks passed"] };
  }
  if (submitter === "author_t0") {
    return {
      outcome: "inbox",
      inbox: {
        type: "listing_unverified",
        priority: 50,
        defaultAction: input.autoPublish ? "approve" : "none",
        afterHours: input.autoPublish ? input.t0DefaultHours : null,
      },
      reasons: ["unverified author, all checks passed"],
    };
  }
  return {
    outcome: "inbox",
    inbox: {
      type: "reader_suggestion",
      priority: 30,
      defaultAction: input.autoPublish ? "approve" : "none",
      afterHours: input.autoPublish ? input.readerSuggestionDays * 24 : null,
    },
    reasons: ["reader suggestion, all checks passed"],
  };
}

// ---------------------------------------------------------------------------------------------
// Editorial classifications of books already in the catalog (§7.5)

export interface ClassificationInput {
  visibility: "draft" | "pending" | "published" | "hidden" | "removed";
  inScope: "yes" | "borderline" | "no";
  anomalies: readonly string[];
  autoPublish: boolean;
  /** The run tripped the circuit breaker (§7.11). */
  circuitOpen: boolean;
}

export type ClassificationDecision =
  | { outcome: "apply"; followUp?: InboxPlan; reasons: string[] }
  | { outcome: "hold"; inbox: InboxPlan; reasons: string[] };

export function decideClassification(input: ClassificationInput): ClassificationDecision {
  if (input.circuitOpen) {
    return {
      outcome: "hold",
      inbox: WAIT("editorial_run_held", 70),
      reasons: ["too many of this run's proposals failed validation"],
    };
  }
  if (input.anomalies.includes("instructions_in_text")) {
    return {
      outcome: "hold",
      inbox: WAIT("classification_review", 90),
      reasons: ["the book's text contains instructions aimed at our tools"],
    };
  }
  if (input.anomalies.includes("not_fiction")) {
    return {
      outcome: "hold",
      inbox: WAIT("classification_review", 50),
      reasons: ["the run thinks this isn't fiction"],
    };
  }
  // Tags on a public page change what readers see, so they only change without review when the
  // owner lets the policy engine publish.
  if (input.visibility === "published" && !input.autoPublish) {
    return {
      outcome: "hold",
      inbox: WAIT("classification_review", 30),
      reasons: ["auto-publish is off and the book is public"],
    };
  }
  if (input.inScope === "no") {
    return {
      outcome: "apply",
      followUp: { type: "scope_check", priority: 40, defaultAction: "approve", afterHours: 7 * 24 },
      reasons: ["marked out of scope: the book can't be published until the owner decides"],
    };
  }
  return { outcome: "apply", reasons: [] };
}

// ---------------------------------------------------------------------------------------------
// The circuit breaker (§7.11)

export function circuitTrips(
  counts: { accepted: number; rejected: number; held: number },
  settings: { rejectShare: number; minProposals: number },
): boolean {
  const total = counts.accepted + counts.rejected + counts.held;
  return total >= settings.minProposals && counts.rejected / total > settings.rejectShare;
}
