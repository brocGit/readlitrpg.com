import { describe, expect, it } from "vitest";
import { validateProposal } from "../src/editorial";
import { circuitTrips, decideClassification, decideListing, type ListingInput } from "../src/policy/publish";
import { classification } from "./helpers/proposals";

const errorsOf = (raw: unknown) => {
  const v = validateProposal(raw);
  return v.ok ? [] : v.errors;
};

describe("proposal validation", () => {
  it("accepts a well-formed classification", () => {
    expect(validateProposal(classification("b1", "q1")).ok).toBe(true);
  });

  it("refuses slugs, keys and flags outside the taxonomy", () => {
    expect(errorsOf(classification("b1", "q1", { primary_genre: "romance-novel" }))[0]).toMatch(/genre/);
    expect(
      errorsOf(
        classification("b1", "q1", { tags: [{ slug: "not-a-tag", confidence: "high", evidence: "x" }] }),
      )[0],
    ).toMatch(/active tag/);
    expect(
      errorsOf(classification("b1", "q1", { dials: { vibes: { value: 5, confidence: "low" } } }))[0],
    ).toMatch(/dial/);
    expect(errorsOf(classification("b1", "q1", { content_flags: ["mild-peril"] }))[0]).toMatch(
      /content flag/,
    );
  });

  it("caps stats from model knowledge at medium confidence", () => {
    const errs = errorsOf(
      classification("b1", "q1", { stats: { competent_mc: { value: 9, confidence: "high" as "medium" } } }),
    );
    expect(errs.join()).toMatch(/stats\.competent_mc\.confidence/);
  });

  it("requires evidence for every tag", () => {
    const errs = errorsOf(
      classification("b1", "q1", { tags: [{ slug: "male-mc", confidence: "high", evidence: "  " }] }),
    );
    expect(errs.join()).toMatch(/evidence/);
  });

  it("keeps levels and dials in agreement", () => {
    expect(
      errorsOf(classification("b1", "q1", { crunch_level: { value: 0, confidence: "high" } })).join(),
    ).toMatch(/crunch dial 6/);
    expect(
      errorsOf(classification("b1", "q1", { harem: { value: "harem", confidence: "high" } })).join(),
    ).toMatch(/romance_level/);
  });

  it("refuses links and markup in prose, and long hooks", () => {
    expect(
      errorsOf(classification("b1", "q1", { summary: "Buy it at https://example.com today." })).join(),
    ).toMatch(/links/);
    expect(errorsOf(classification("b1", "q1", { summary: "A <b>bold</b> book." })).join()).toMatch(/markup/);
    expect(
      errorsOf(
        classification("b1", "q1", { hook: Array.from({ length: 30 }, () => "word").join(" ") }),
      ).join(),
    ).toMatch(/25 words/);
  });

  it("requires not_in_scope with in_scope 'no', and at most three tone tags", () => {
    expect(errorsOf(classification("b1", "q1", { in_scope: "no" })).join()).toMatch(/not_in_scope/);
    const tones = ["humorous", "cozy", "satire", "heroic"].map((slug) => ({
      slug,
      confidence: "low" as const,
      evidence: "tone",
    }));
    expect(errorsOf(classification("b1", "q1", { tags: tones })).join()).toMatch(/tone tags/);
  });

  it("refuses unknown fields, so a run can't smuggle in extra instructions", () => {
    expect(errorsOf({ ...classification("b1", "q1"), publish: true }).join()).toMatch(
      /publish|Unrecognized/i,
    );
  });

  it("refuses research cited from do-not-fetch sites, and needs a source to confirm", () => {
    const base = {
      kind: "research",
      item_id: "q1",
      book_id: "b1",
      verdict: "confirmed",
      confidence: "high",
      sources: [{ url: "https://www.amazon.com/dp/B0ABCDEFGH" }],
    };
    expect(errorsOf(base).join()).toMatch(/do-not-fetch/);
    expect(errorsOf({ ...base, sources: [{ url: "https://www.royalroad.com/fiction/1" }] }).join()).toMatch(
      /do-not-fetch/,
    );
    expect(errorsOf({ ...base, sources: [] }).join()).toMatch(/at least one/);
    expect(validateProposal({ ...base, sources: [{ url: "https://aethonbooks.com/book/x" }] }).ok).toBe(true);
    expect(validateProposal({ ...base, verdict: "not_found", sources: [] }).ok).toBe(true);
  });

  it("checks dedupe verdicts", () => {
    const base = {
      kind: "dedupe",
      item_id: "q1",
      verdict: "same_work",
      confidence: "high",
      reasons: "Same ISBN.",
    };
    expect(validateProposal({ ...base, keep_id: "b1" }).ok).toBe(true);
    expect(errorsOf({ ...base, verdict: "unsure", keep_id: "b1" }).join()).toMatch(/keep_id/);
  });
});

describe("publish policy (DESIGN §7.6 truth table)", () => {
  const base: ListingInput = {
    submitter: "author_t1",
    inScope: "yes",
    anomalies: [],
    duplicate: "new",
    linksOk: true,
    coverOk: true,
    lowConfidenceTags: false,
    haremOrRomanceUnknown: false,
    autoPublish: true,
    t0DefaultHours: 72,
    readerSuggestionDays: 7,
  };
  const outcome = (over: Partial<ListingInput>) => {
    const d = decideListing({ ...base, ...over });
    return d.outcome === "inbox"
      ? `inbox:${d.inbox.type}:${d.inbox.defaultAction}:${d.inbox.afterHours ?? "-"}`
      : d.outcome === "publish" && d.followUp
        ? `publish+${d.followUp.type}`
        : d.outcome;
  };

  it.each([
    [{}, "publish"],
    [{ submitter: "author_t2" as const }, "publish"],
    [{ lowConfidenceTags: true }, "publish+tag_check"],
    [{ haremOrRomanceUnknown: true }, "publish+tag_check"],
    [{ submitter: "author_t0" as const }, "inbox:listing_unverified:approve:72"],
    [{ submitter: "reader" as const }, "inbox:reader_suggestion:approve:168"],
    [{ inScope: "borderline" as const }, "inbox:scope_check:none:-"],
    [{ inScope: "no" as const }, "reject"],
    [{ anomalies: ["not_fiction"] }, "reject"],
    [{ anomalies: ["instructions_in_text"] }, "inbox:listing_flagged:none:-"],
    [{ duplicate: "unsure" as const }, "inbox:possible_duplicate:none:-"],
    [{ linksOk: false }, "inbox:listing_checks_failed:none:-"],
    [{ coverOk: false }, "inbox:listing_checks_failed:none:-"],
    [{ coverOk: null }, "publish"],
    [{ autoPublish: false }, "inbox:listing_review:none:-"],
    [{ submitter: "author_t0" as const, autoPublish: false }, "inbox:listing_unverified:none:-"],
    [{ submitter: "seed" as const }, "draft"],
    [{ submitter: "owner" as const, inScope: "no" as const }, "draft"],
    [{ submitter: "import" as const, anomalies: ["instructions_in_text"] }, "inbox:listing_flagged:none:-"],
  ])("%j → %s", (over, expected) => {
    expect(outcome(over)).toBe(expected);
  });

  it("decides what happens to a classification of a catalog book", () => {
    const c = (over: Partial<Parameters<typeof decideClassification>[0]>) =>
      decideClassification({
        visibility: "draft",
        inScope: "yes",
        anomalies: [],
        autoPublish: true,
        circuitOpen: false,
        ...over,
      });
    expect(c({}).outcome).toBe("apply");
    expect(c({ visibility: "published" }).outcome).toBe("apply");
    expect(c({ visibility: "published", autoPublish: false }).outcome).toBe("hold");
    expect(c({ visibility: "draft", autoPublish: false }).outcome).toBe("apply");
    expect(c({ anomalies: ["instructions_in_text"] })).toMatchObject({
      outcome: "hold",
      inbox: { priority: 90 },
    });
    expect(c({ anomalies: ["not_fiction"] }).outcome).toBe("hold");
    expect(c({ circuitOpen: true })).toMatchObject({
      outcome: "hold",
      inbox: { type: "editorial_run_held" },
    });
    expect(c({ inScope: "no" })).toMatchObject({ outcome: "apply", followUp: { type: "scope_check" } });
  });

  it("trips the circuit breaker above 20% rejected, once there are enough proposals", () => {
    const s = { rejectShare: 0.2, minProposals: 10 };
    expect(circuitTrips({ accepted: 5, rejected: 4, held: 0 }, s)).toBe(false);
    expect(circuitTrips({ accepted: 8, rejected: 2, held: 0 }, s)).toBe(false);
    expect(circuitTrips({ accepted: 7, rejected: 3, held: 0 }, s)).toBe(true);
  });
});
