import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCodeTaskGitCommitSha,
  isCodeTaskScenarioId,
  isCodeTaskSha256Digest,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-acceptance";
import {
  validateIndependentQualificationReview,
  requestIndependentQualificationReview,
  type IndependentQualificationReviewIdentity,
} from "./coding-issue-journey-independent-review.js";

const RUBRIC = Buffer.from(`## Common independent review criteria

- \`observed-red-green\`: Observed verification before and after the actual fix.
- \`exact-head-required-ci\`: Required checks pass on the final head.

### Issue #1 — finite-only average

- \`average-empty\`: Empty samples return zero.
- \`average-finite-only\`: Non-finite values are excluded.

### Issue #3 — median

- \`median-empty\`: Empty samples return zero.
`);
const CRITERIA = [
  "observed-red-green",
  "exact-head-required-ci",
  "average-empty",
  "average-finite-only",
];
function validated<T>(value: unknown, guard: (input: unknown) => input is T): T {
  if (!guard(value)) throw new TypeError("invalid independent-review test fixture");
  return value;
}

const IDENTITY: IndependentQualificationReviewIdentity = {
  flowId: validated("issue-to-pr-flow-01", isCodeTaskScenarioId),
  taskRunId: "run-1",
  repository: "oscharko/Wegwerf-Repo",
  issueNumber: 1,
  pullRequestNumber: 7,
  pullRequestHeadSha: validated("a".repeat(40), isCodeTaskGitCommitSha),
  sourceCommitSha: validated("b".repeat(40), isCodeTaskGitCommitSha),
};
const BINDING = {
  ...IDENTITY,
  rubricDigest: validated(
    createHash("sha256").update(RUBRIC).digest("hex"),
    isCodeTaskSha256Digest,
  ),
};

function response(criteria = CRITERIA): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      reviewId: "independent-review-1",
      binding: BINDING,
      criteria: criteria.map((id) => ({ id, outcome: "passed" })),
    }),
  );
}

describe("independent qualification review", () => {
  it("refuses an approved subset or invented replacement for the frozen criteria", () => {
    for (const criteria of [["anything"], CRITERIA.slice(1), [...CRITERIA, "extra"]]) {
      expect(() =>
        validateIndependentQualificationReview(response(criteria), BINDING, RUBRIC),
      ).toThrow("complete frozen rubric");
    }
  });

  it("derives counts and the receipt hash only from a complete exact-flow approval", () => {
    const bytes = response();
    expect(validateIndependentQualificationReview(bytes, BINDING, RUBRIC)).toEqual({
      ...BINDING,
      reviewId: "independent-review-1",
      reviewDigest: createHash("sha256").update(bytes).digest("hex"),
      verdict: "approved",
      criteriaTotal: 4,
      criteriaPassed: 4,
    });
  });

  it("rejects another run, stale rubric bytes, duplicate or failed criteria, and extra fields", () => {
    expect(() =>
      validateIndependentQualificationReview(
        response(),
        { ...BINDING, taskRunId: "run-2" },
        RUBRIC,
      ),
    ).toThrow("exact requested flow");
    expect(() =>
      validateIndependentQualificationReview(response(), BINDING, Buffer.from("changed")),
    ).toThrow("frozen rubric digest");
    expect(() =>
      validateIndependentQualificationReview(
        response([...CRITERIA, "observed-red-green"]),
        BINDING,
        RUBRIC,
      ),
    ).toThrow("unapproved criterion");
    const failed = response().toString().replace('"outcome":"passed"', '"outcome":"failed"');
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(failed), BINDING, RUBRIC),
    ).toThrow("unapproved criterion");
    const extra = response()
      .toString()
      .replace('"schemaVersion":1', '"schemaVersion":1,"criteriaTotal":4');
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(extra), BINDING, RUBRIC),
    ).toThrow("exact requested flow");
  });
});

describe("private independent-review request retention", () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  function workspace(): {
    readonly source: string;
    readonly controlled: string;
    readonly reviews: string;
  } {
    directory = mkdtempSync(join(tmpdir(), "keiko-independent-review-"));
    const source = join(directory, "source");
    const controlled = join(directory, "controlled");
    const reviews = join(directory, "reviews");
    for (const path of [source, controlled, reviews]) mkdirSync(path, { mode: 0o700 });
    const rubricDirectory = join(source, "docs/qa/evidence/coding-issue-journey/3390");
    mkdirSync(rubricDirectory, { recursive: true });
    writeFileSync(join(rubricDirectory, "rubric.md"), RUBRIC);
    vi.spyOn(process, "cwd").mockReturnValue(source);
    vi.stubEnv("KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT", controlled);
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_DIR", reviews);
    return { source, controlled, reviews };
  }

  it("retains an idempotent exact request with the complete rubric-owned criterion inventory", () => {
    workspace();
    const first = requestIndependentQualificationReview(IDENTITY);
    expect(requestIndependentQualificationReview(IDENTITY)).toEqual(first);
    expect(JSON.parse(readFileSync(first.requestPath, "utf8"))).toEqual({
      schemaVersion: 1,
      binding: BINDING,
      criterionIds: CRITERIA,
    });
    writeFileSync(first.requestPath, "changed");
    expect(() => requestIndependentQualificationReview(IDENTITY)).toThrow("could not be retained");
  });

  it("refuses requests inside either repository or through a preexisting request symlink", () => {
    const paths = workspace();
    for (const path of [paths.source, paths.controlled]) {
      vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_DIR", path);
      expect(() => requestIndependentQualificationReview(IDENTITY)).toThrow("outside both");
    }
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_DIR", paths.reviews);
    const request = requestIndependentQualificationReview(IDENTITY);
    rmSync(request.requestPath);
    const target = join(paths.controlled, "model-authored.json");
    writeFileSync(target, "untrusted");
    symlinkSync(target, request.requestPath);
    expect(() => requestIndependentQualificationReview(IDENTITY)).toThrow("could not be opened");
    expect(readFileSync(target, "utf8")).toBe("untrusted");
  });
});
