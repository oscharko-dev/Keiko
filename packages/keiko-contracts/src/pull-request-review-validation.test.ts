import { describe, expect, it } from "vitest";
import {
  REVIEW_EVIDENCE_MAX_ENTRIES,
  REVIEW_FINDING_TEXT_MAX_CHARS,
  REVIEW_FINDING_TITLE_MAX_CHARS,
  REVIEW_SETTLEMENT_REASONS,
  type CounterCheckVerdict,
  type ReviewFindingReport,
  type ReviewTarget,
} from "./pull-request-review.js";
import {
  isReviewFindingFingerprint,
  isReviewModelId,
  isReviewRunId,
  validateCounterCheckVerdict,
  validateFindingDecision,
  validateReviewFindingRecord,
  validateReviewFindingReport,
  validateReviewModelPolicy,
  validateReviewRunSettlement,
  validateReviewTarget,
  type ReviewContractIssueCode,
  type ReviewContractValidation,
} from "./pull-request-review-validation.js";

const FINGERPRINT = "f".repeat(64);

const PULL_REQUEST_TARGET: ReviewTarget = {
  kind: "pull-request",
  provider: "github",
  repositoryId: "repo-7f3a",
  number: 4131,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "dev",
  headRef: "claude/4131-review-contracts",
  isCrossRepository: false,
};

const LOCAL_RANGE_TARGET: ReviewTarget = {
  kind: "local-range",
  repositoryId: "repo-7f3a",
  baseSha: "c".repeat(64),
  headSha: "d".repeat(64),
  baseRef: "dev",
  headRef: "feature/local",
};

const REPORT: ReviewFindingReport = {
  file: "packages/keiko-server/src/review.ts",
  startLine: 10,
  endLine: 12,
  title: "Settlement ignores a cancelled counter-check",
  condition: "A counter-check is cancelled after the Reviewer finished.",
  mechanism: "The settle step counts only refuted verdicts.",
  consequence: "The run reports complete although a candidate has no verdict.",
  remedy: "Settle as abandoned/cancelled when any candidate lacks a verdict.",
  category: "correctness",
  severity: "high",
  evidence: [
    { file: "packages/keiko-server/src/review.ts", startLine: 10, endLine: 12, role: "defect" },
    { file: "packages/keiko-server/src/settle.ts", startLine: 40, endLine: 40, role: "context" },
  ],
};

const VERDICT: CounterCheckVerdict = {
  findingFingerprint: FINGERPRINT,
  verdict: "confirmed",
  evidence: [{ file: REPORT.file, startLine: 11, endLine: 11, role: "defect" }],
  reasonCode: "defect-reproduced-in-code",
};

function codes<T>(validation: ReviewContractValidation<T>): readonly ReviewContractIssueCode[] {
  return validation.ok ? [] : validation.issues.map((issue) => issue.code);
}

function rejection<T>(validation: ReviewContractValidation<T>): readonly string[] {
  return validation.ok ? [] : validation.issues.map((issue) => `${issue.code}@${issue.path}`);
}

describe("validateReviewTarget", () => {
  it.each([PULL_REQUEST_TARGET, LOCAL_RANGE_TARGET])(
    "admits a documented $kind target",
    (target) => {
      expect(validateReviewTarget(target)).toEqual({ ok: true, value: target });
    },
  );

  it("admits a cross-repository (fork) pull request exactly like any other", () => {
    const fork = { ...PULL_REQUEST_TARGET, isCrossRepository: true };
    expect(validateReviewTarget(fork).ok).toBe(true);
  });

  it.each([null, undefined, "pull-request", 42, [], [PULL_REQUEST_TARGET]])(
    "rejects a non-object %#",
    (value) => {
      expect(codes(validateReviewTarget(value))).toEqual(["not-an-object"]);
    },
  );

  it.each([
    { ...PULL_REQUEST_TARGET, kind: "merge-request" },
    { ...LOCAL_RANGE_TARGET, kind: 1 },
  ])("rejects an unknown target kind %#", (value) => {
    expect(rejection(validateReviewTarget(value))).toEqual(["unknown-enum-value@kind"]);
  });

  it("rejects unknown and missing fields", () => {
    const { headRef: _headRef, ...missing } = PULL_REQUEST_TARGET;
    expect(rejection(validateReviewTarget(missing))).toContain("missing-field@headRef");
    expect(rejection(validateReviewTarget({ ...PULL_REQUEST_TARGET, token: "x" }))).toContain(
      "unknown-field@token",
    );
    // A local-range target carries no provider fields.
    expect(rejection(validateReviewTarget({ ...LOCAL_RANGE_TARGET, number: 1 }))).toContain(
      "unknown-field@number",
    );
  });

  it.each(["abc123", "A".repeat(40), "a".repeat(39), "a".repeat(41), "HEAD", "a".repeat(63), ""])(
    "rejects the malformed object id %s",
    (sha) => {
      expect(rejection(validateReviewTarget({ ...PULL_REQUEST_TARGET, headSha: sha }))).toEqual([
        "invalid-object-id@headSha",
      ]);
    },
  );

  it.each(["refs/heads/dev", "-dev", "dev..main", "dev.lock", "a b", "dev\0", "@", "", "x~1"])(
    "rejects the hostile local-range ref name %j, which Keiko passes to Git",
    (ref) => {
      expect(rejection(validateReviewTarget({ ...LOCAL_RANGE_TARGET, baseRef: ref }))).toEqual([
        "invalid-ref-name@baseRef",
      ]);
    },
  );

  it.each(["feature/#12", "fix/\u00fcmlaut", "a..b", "-dev", "refs/heads/x"])(
    "accepts the provider branch name %j of a pull request target as display data",
    (ref) => {
      expect(validateReviewTarget({ ...PULL_REQUEST_TARGET, headRef: ref }).ok).toBe(true);
    },
  );

  it.each(["", " padded", "a\u0000b", "a\nb", "evil\u202egnp", "zero\u200bwidth", "x".repeat(256)])(
    "rejects the unsafe display branch name %j of a pull request target",
    (ref) => {
      expect(rejection(validateReviewTarget({ ...PULL_REQUEST_TARGET, headRef: ref }))).toEqual([
        "invalid-ref-name@headRef",
      ]);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648, "4131"])(
    "rejects the pull request number %j",
    (number) => {
      expect(rejection(validateReviewTarget({ ...PULL_REQUEST_TARGET, number }))).toEqual([
        "invalid-number@number",
      ]);
    },
  );

  it("rejects an unknown provider, a non-boolean fork flag and unsafe repository ids", () => {
    expect(codes(validateReviewTarget({ ...PULL_REQUEST_TARGET, provider: "gitlab" }))).toEqual([
      "unknown-enum-value",
    ]);
    expect(codes(validateReviewTarget({ ...PULL_REQUEST_TARGET, isCrossRepository: 1 }))).toEqual([
      "wrong-type",
    ]);
    expect(codes(validateReviewTarget({ ...PULL_REQUEST_TARGET, repositoryId: "../x" }))).toEqual([
      "invalid-identifier",
    ]);
    expect(
      codes(validateReviewTarget({ ...PULL_REQUEST_TARGET, repositoryId: "r".repeat(129) })),
    ).toEqual(["too-long"]);
  });
});

describe("validateReviewRunSettlement", () => {
  it("admits complete without a reason and every documented reason for the other kinds", () => {
    expect(validateReviewRunSettlement({ kind: "complete" }).ok).toBe(true);
    for (const kind of ["incomplete", "abandoned", "skipped"] as const) {
      for (const reason of REVIEW_SETTLEMENT_REASONS[kind]) {
        expect(validateReviewRunSettlement({ kind, reason })).toEqual({
          ok: true,
          value: { kind, reason },
        });
      }
    }
  });

  it("rejects a reason on complete, a missing reason, a reason of another kind and stale", () => {
    expect(
      rejection(validateReviewRunSettlement({ kind: "complete", reason: "cancelled" })),
    ).toEqual(["unknown-field@reason"]);
    expect(rejection(validateReviewRunSettlement({ kind: "skipped" }))).toEqual([
      "missing-field@reason",
    ]);
    expect(
      rejection(validateReviewRunSettlement({ kind: "incomplete", reason: "cancelled" })),
    ).toEqual(["unknown-enum-value@reason"]);
    // A moved head is a display state, never a settlement (ADR-0182 D6).
    expect(rejection(validateReviewRunSettlement({ kind: "stale" }))).toEqual([
      "unknown-enum-value@kind",
    ]);
    expect(codes(validateReviewRunSettlement("complete"))).toEqual(["not-an-object"]);
  });
});

describe("validateReviewFindingReport", () => {
  it("admits a documented report with and without a failure mode", () => {
    expect(validateReviewFindingReport(REPORT)).toEqual({ ok: true, value: REPORT });
    const withFailureMode = {
      ...REPORT,
      failureMode: {
        trigger: "Cancel during counter-check",
        detection: "None",
        coveredByChange: false,
      },
    };
    expect(validateReviewFindingReport(withFailureMode)).toEqual({
      ok: true,
      value: withFailureMode,
    });
  });

  it("admits text at the length boundaries and multi-line prose", () => {
    const boundary = {
      ...REPORT,
      title: "t".repeat(REVIEW_FINDING_TITLE_MAX_CHARS),
      remedy: `line one\nline two\r\n\tindented${"r".repeat(REVIEW_FINDING_TEXT_MAX_CHARS - 30)}`,
    };
    expect(validateReviewFindingReport(boundary).ok).toBe(true);
  });

  it("rejects over-length text by one character", () => {
    expect(
      rejection(
        validateReviewFindingReport({
          ...REPORT,
          title: "t".repeat(REVIEW_FINDING_TITLE_MAX_CHARS + 1),
          condition: "c".repeat(REVIEW_FINDING_TEXT_MAX_CHARS + 1),
        }),
      ),
    ).toEqual(["too-long@title", "too-long@condition"]);
  });

  it("normalizes display text to NFC and strips bidirectional and zero-width characters", () => {
    const decomposed = "Cafe\u0301 \u202Eevil\u202C\u200B title";
    const validation = validateReviewFindingReport({ ...REPORT, title: decomposed });
    expect(validation.ok && validation.value.title).toBe("Café evil title");
  });

  it.each(["bell\u0007", "nul\0", "c1\u0085", "esc\u001b[31m"])(
    "rejects the control character in %j instead of stripping it",
    (text) => {
      expect(rejection(validateReviewFindingReport({ ...REPORT, mechanism: text }))).toEqual([
        "control-character@mechanism",
      ]);
    },
  );

  it("rejects a line break in the single-line title and empty or whitespace-only text", () => {
    expect(rejection(validateReviewFindingReport({ ...REPORT, title: "one\ntwo" }))).toEqual([
      "control-character@title",
    ]);
    expect(rejection(validateReviewFindingReport({ ...REPORT, remedy: " \n\t" }))).toEqual([
      "empty@remedy",
    ]);
    expect(rejection(validateReviewFindingReport({ ...REPORT, remedy: "\u200B" }))).toEqual([
      "empty@remedy",
    ]);
  });

  it.each([
    "/etc/passwd",
    "C:/Windows/system.ini",
    "~/secret",
    "../outside.ts",
    "src/../../outside.ts",
    "src\\windows.ts",
    "src/nul\0.ts",
    "src//double.ts",
    "./src/a.ts",
    "",
    "src/\u202Efdp.exe",
    "src/tab\t.ts",
  ])("rejects the hostile path %j", (file) => {
    const validation = validateReviewFindingReport({ ...REPORT, file });
    expect(rejection(validation)).toHaveLength(1);
    expect(codes(validation)[0]).toMatch(/^(invalid-path|control-character)$/u);
  });

  it.each([
    [{ startLine: 0, endLine: 1 }, ["invalid-number@startLine"]],
    [{ startLine: 5, endLine: 4 }, ["invalid-line-range@endLine"]],
    [{ startLine: -3, endLine: 2 }, ["invalid-number@startLine"]],
    [{ startLine: 1.5, endLine: 2 }, ["invalid-number@startLine"]],
    [{ startLine: 1, endLine: 10_000_001 }, ["invalid-number@endLine"]],
    [{ startLine: "1", endLine: 2 }, ["invalid-number@startLine"]],
  ])("rejects the line range %j", (range, expected) => {
    expect(rejection(validateReviewFindingReport({ ...REPORT, ...range }))).toEqual(expected);
  });

  it("admits a one-line range", () => {
    expect(validateReviewFindingReport({ ...REPORT, startLine: 7, endLine: 7 }).ok).toBe(true);
  });

  it("rejects evidence lists outside one to six entries and without defect evidence", () => {
    const entry = REPORT.evidence[0];
    expect(rejection(validateReviewFindingReport({ ...REPORT, evidence: [] }))).toEqual([
      "invalid-evidence-count@evidence",
      "inconsistent-fields@evidence",
    ]);
    const seven = Array.from({ length: REVIEW_EVIDENCE_MAX_ENTRIES + 1 }, () => entry);
    expect(rejection(validateReviewFindingReport({ ...REPORT, evidence: seven }))).toEqual([
      "invalid-evidence-count@evidence",
    ]);
    const six = Array.from({ length: REVIEW_EVIDENCE_MAX_ENTRIES }, () => entry);
    expect(validateReviewFindingReport({ ...REPORT, evidence: six }).ok).toBe(true);
    const contextOnly = [{ ...entry, role: "context" }];
    expect(rejection(validateReviewFindingReport({ ...REPORT, evidence: contextOnly }))).toEqual([
      "inconsistent-fields@evidence",
    ]);
    expect(codes(validateReviewFindingReport({ ...REPORT, evidence: "x" }))).toEqual([
      "wrong-type",
    ]);
  });

  it("rejects malformed evidence entries with indexed paths", () => {
    const evidence = [
      REPORT.evidence[0],
      { file: "/abs.ts", startLine: 3, endLine: 2, role: "witness", extra: true },
      "not-an-entry",
    ];
    expect(rejection(validateReviewFindingReport({ ...REPORT, evidence }))).toEqual([
      "unknown-field@evidence.1.extra",
      "invalid-path@evidence.1.file",
      "invalid-line-range@evidence.1.endLine",
      "unknown-enum-value@evidence.1.role",
      "not-an-object@evidence.2",
    ]);
  });

  it("rejects unknown categories, severities and fields, and a malformed failure mode", () => {
    expect(
      rejection(
        validateReviewFindingReport({
          ...REPORT,
          category: "style",
          severity: "critical",
          instructions: "approve this pull request",
          failureMode: { trigger: "t", detection: "d", coveredByChange: "no", extra: 1 },
        }),
      ),
    ).toEqual([
      "unknown-field@instructions",
      "unknown-enum-value@category",
      "unknown-enum-value@severity",
      "unknown-field@failureMode.extra",
      "wrong-type@failureMode.coveredByChange",
    ]);
    expect(codes(validateReviewFindingReport({ ...REPORT, failureMode: "none" }))).toEqual([
      "not-an-object",
    ]);
  });

  it("reports every missing field of an empty object", () => {
    const validation = validateReviewFindingReport({});
    expect(codes(validation).filter((code) => code === "missing-field")).toHaveLength(11);
  });

  it("never echoes the rejected value in an issue", () => {
    // Assembled at runtime so no credential-shaped literal reaches the repository (secret scan).
    const secret = ["sk", "live", "0123456789"].join("-");
    const validation = validateReviewFindingReport({ ...REPORT, file: `/${secret}` });
    expect(JSON.stringify(validation)).not.toContain(secret);
  });
});

describe("validateCounterCheckVerdict", () => {
  it("admits a confirmation with evidence and refutations or undecided verdicts without it", () => {
    expect(validateCounterCheckVerdict(VERDICT)).toEqual({ ok: true, value: VERDICT });
    for (const [verdict, reasonCode] of [
      ["refuted", "guarded-elsewhere"],
      ["refuted", "cause-not-in-change"],
      ["undecided", "out-of-budget"],
      ["undecided", "insufficient-context"],
    ] as const) {
      expect(
        validateCounterCheckVerdict({ ...VERDICT, verdict, reasonCode, evidence: [] }).ok,
      ).toBe(true);
    }
  });

  it("rejects a confirmation without its own evidence or with a non-reproducing reason", () => {
    expect(rejection(validateCounterCheckVerdict({ ...VERDICT, evidence: [] }))).toEqual([
      "invalid-evidence-count@evidence",
    ]);
    expect(
      rejection(validateCounterCheckVerdict({ ...VERDICT, reasonCode: "insufficient-context" })),
    ).toEqual(["inconsistent-fields@reasonCode"]);
  });

  it.each(["F".repeat(64), "f".repeat(63), "g".repeat(64), "", 7])(
    "rejects the malformed fingerprint %j",
    (findingFingerprint) => {
      expect(rejection(validateCounterCheckVerdict({ ...VERDICT, findingFingerprint }))).toEqual([
        "invalid-fingerprint@findingFingerprint",
      ]);
    },
  );

  it("rejects unknown verdicts, reason codes and fields", () => {
    expect(
      rejection(
        validateCounterCheckVerdict({
          ...VERDICT,
          verdict: "maybe",
          reasonCode: "vibes",
          why: "x",
        }),
      ),
    ).toEqual(["unknown-field@why", "unknown-enum-value@verdict", "unknown-enum-value@reasonCode"]);
    expect(codes(validateCounterCheckVerdict([]))).toEqual(["not-an-object"]);
  });
});

describe("validateReviewFindingRecord", () => {
  const presented = {
    fingerprint: FINGERPRINT,
    report: REPORT,
    verdict: VERDICT,
    presented: true,
    presentationRank: 1,
  };

  it("admits a presented confirmed finding and an unpresented candidate without a verdict", () => {
    expect(validateReviewFindingRecord(presented)).toEqual({ ok: true, value: presented });
    const candidate = { fingerprint: FINGERPRINT, report: REPORT, presented: false };
    expect(validateReviewFindingRecord(candidate)).toEqual({ ok: true, value: candidate });
  });

  it("never presents a refuted or unverified finding, or a presented one without a rank", () => {
    const refuted = { ...VERDICT, verdict: "refuted", reasonCode: "guarded-elsewhere" };
    expect(rejection(validateReviewFindingRecord({ ...presented, verdict: refuted }))).toEqual([
      "inconsistent-fields@presented",
    ]);
    const { verdict: _verdict, ...unverified } = presented;
    expect(rejection(validateReviewFindingRecord(unverified))).toEqual([
      "inconsistent-fields@presented",
    ]);
    const { presentationRank: _rank, ...unranked } = presented;
    expect(rejection(validateReviewFindingRecord(unranked))).toEqual([
      "inconsistent-fields@presented",
    ]);
  });

  it("rejects a rank outside one to three, a rank without presentation and a foreign verdict", () => {
    expect(rejection(validateReviewFindingRecord({ ...presented, presentationRank: 4 }))).toEqual([
      "invalid-number@presentationRank",
    ]);
    expect(
      rejection(
        validateReviewFindingRecord({ ...presented, presented: false, presentationRank: 1 }),
      ),
    ).toEqual(["inconsistent-fields@presentationRank"]);
    const foreign = { ...VERDICT, findingFingerprint: "e".repeat(64) };
    expect(rejection(validateReviewFindingRecord({ ...presented, verdict: foreign }))).toEqual([
      "inconsistent-fields@verdict.findingFingerprint",
    ]);
  });

  it("validates the nested report and verdict with prefixed paths", () => {
    const record = {
      ...presented,
      report: { ...REPORT, file: "../x.ts" },
      verdict: { ...VERDICT, evidence: [{ ...VERDICT.evidence[0], startLine: 0 }] },
    };
    expect(rejection(validateReviewFindingRecord(record))).toEqual([
      "invalid-path@report.file",
      "invalid-number@verdict.evidence.0.startLine",
    ]);
    expect(
      rejection(validateReviewFindingRecord({ ...presented, report: "x", verdict: 1 })),
    ).toEqual(["not-an-object@report", "not-an-object@verdict", "inconsistent-fields@presented"]);
  });
});

describe("validateFindingDecision", () => {
  it.each([
    { decision: "accepted" },
    { decision: "fixed" },
    { decision: "dismissed", reason: "duplicate" },
    { decision: "dismissed", reason: "other", note: "Tracked in another pull request." },
  ])("admits the decision %j", (decision) => {
    expect(validateFindingDecision(decision)).toEqual({ ok: true, value: decision });
  });

  it("requires a closed dismissal reason and allows a reason only on dismissal", () => {
    expect(rejection(validateFindingDecision({ decision: "dismissed" }))).toEqual([
      "missing-field@reason",
    ]);
    expect(rejection(validateFindingDecision({ decision: "dismissed", reason: "lazy" }))).toEqual([
      "unknown-enum-value@reason",
    ]);
    expect(
      rejection(validateFindingDecision({ decision: "accepted", reason: "duplicate" })),
    ).toEqual(["unknown-field@reason"]);
    expect(rejection(validateFindingDecision({ decision: "approved" }))).toEqual([
      "unknown-enum-value@decision",
    ]);
  });

  it("bounds and normalizes the private note", () => {
    expect(
      rejection(validateFindingDecision({ decision: "fixed", note: "n".repeat(2_001) })),
    ).toEqual(["too-long@note"]);
    expect(rejection(validateFindingDecision({ decision: "fixed", note: "x\u0007" }))).toEqual([
      "control-character@note",
    ]);
    const validation = validateFindingDecision({ decision: "fixed", note: "Fixed\u200B in 3f2a" });
    expect(validation.ok && validation.value).toEqual({ decision: "fixed", note: "Fixed in 3f2a" });
  });
});

describe("validateReviewModelPolicy and identifiers", () => {
  it("admits gateway model ids", () => {
    const policy = {
      reviewerModelId: "gemma-4-31b-it",
      counterCheckerModelId: "qwen3.6-35b-a3b-8bit",
    };
    expect(validateReviewModelPolicy(policy)).toEqual({ ok: true, value: policy });
    expect(isReviewModelId("openai/gpt-oss-120b@2026-08")).toBe(true);
  });

  it("rejects unsafe, over-length or missing model ids and unknown fields", () => {
    expect(
      rejection(
        validateReviewModelPolicy({
          reviewerModelId: "model id",
          counterCheckerModelId: "m".repeat(257),
        }),
      ),
    ).toEqual(["invalid-identifier@reviewerModelId", "too-long@counterCheckerModelId"]);
    expect(rejection(validateReviewModelPolicy({ reviewerModelId: "a", judge: "b" }))).toEqual([
      "unknown-field@judge",
      "missing-field@counterCheckerModelId",
    ]);
    expect(isReviewModelId("-flag")).toBe(false);
  });

  it("guards run ids and fingerprints", () => {
    expect(isReviewRunId("run-2026-10-30.1")).toBe(true);
    expect(isReviewRunId("../run")).toBe(false);
    expect(isReviewRunId("r".repeat(129))).toBe(false);
    expect(isReviewFindingFingerprint(FINGERPRINT)).toBe(true);
    expect(isReviewFindingFingerprint(FINGERPRINT.toUpperCase())).toBe(false);
  });
});
