import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
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
  awaitIndependentQualificationReview,
  INDEPENDENT_REVIEW_OUTCOMES,
  IndependentQualificationReviewRejected,
  signaturePathFor,
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

type Outcome = (typeof INDEPENDENT_REVIEW_OUTCOMES)[number];

function response(
  criteria: readonly string[] = CRITERIA,
  outcomes: Readonly<Record<string, Outcome>> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      reviewId: "independent-review-1",
      binding: BINDING,
      criteria: criteria.map((id) => ({
        id,
        outcome: outcomes[id] ?? "passed",
        reason: `checked ${id} against the exact head`,
      })),
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
      verdict: "approved",
      review: {
        ...BINDING,
        reviewId: "independent-review-1",
        reviewDigest: createHash("sha256").update(bytes).digest("hex"),
        verdict: "approved",
        criteriaTotal: 4,
        criteriaPassed: 4,
      },
    });
  });

  // Epic #3384: a reviewer who finds a real defect used to have no way to say so — the schema
  // accepted only "passed", so a rejection was written nowhere and the flow died in the same
  // silent timeout as an absent reviewer. A withheld approval is now its own recorded answer.
  it("records a withheld approval as the reviewer's own outcome, not an absent answer", () => {
    const rejected = response(CRITERIA, { "average-empty": "rejected" });
    expect(validateIndependentQualificationReview(rejected, BINDING, RUBRIC)).toEqual({
      verdict: "rejected",
      reviewId: "independent-review-1",
      reviewDigest: createHash("sha256").update(rejected).digest("hex"),
      unmet: [
        {
          id: "average-empty",
          outcome: "rejected",
          reason: "checked average-empty against the exact head",
        },
      ],
    });

    const changes = response(CRITERIA, { "exact-head-required-ci": "needs-changes" });
    expect(validateIndependentQualificationReview(changes, BINDING, RUBRIC)).toMatchObject({
      verdict: "changes-requested",
      unmet: [{ id: "exact-head-required-ci", outcome: "needs-changes" }],
    });

    // A rejection outranks a change request: the strongest recorded outcome names the verdict.
    expect(
      validateIndependentQualificationReview(
        response(CRITERIA, { "average-empty": "needs-changes", "average-finite-only": "rejected" }),
        BINDING,
        RUBRIC,
      ),
    ).toMatchObject({ verdict: "rejected" });
  });

  it("requires a reason on every outcome and refuses an unknown outcome word", () => {
    const withoutReason = JSON.stringify({
      schemaVersion: 2,
      reviewId: "independent-review-1",
      binding: BINDING,
      criteria: CRITERIA.map((id) => ({ id, outcome: "passed" })),
    });
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(withoutReason), BINDING, RUBRIC),
    ).toThrow("unapproved criterion");
    const blankReason = response()
      .toString()
      .replace(/"reason":"[^"]*"/u, '"reason":"   "');
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(blankReason), BINDING, RUBRIC),
    ).toThrow("unapproved criterion");
    const unknown = response().toString().replace('"outcome":"passed"', '"outcome":"maybe"');
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(unknown), BINDING, RUBRIC),
    ).toThrow("unapproved criterion");
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
    const legacySchema = response().toString().replace('"schemaVersion":2', '"schemaVersion":1');
    expect(() =>
      validateIndependentQualificationReview(Buffer.from(legacySchema), BINDING, RUBRIC),
    ).toThrow("exact requested flow");
    const extra = response()
      .toString()
      .replace('"schemaVersion":2', '"schemaVersion":2,"criteriaTotal":4');
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
      schemaVersion: 2,
      binding: BINDING,
      criterionIds: CRITERIA,
      outcomes: ["passed", "rejected", "needs-changes"],
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

// Epic #3384: a dropped file was previously the whole approval. The answer is now a detached SSH
// signature over the exact review bytes, verified under this lane's own namespace, and the wait is
// event-driven with no deadline of its own unless an operator configures one.
describe("signed, parked independent-review answers", () => {
  let directory: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function ssh(args: readonly string[]): void {
    execFileSync("/usr/bin/ssh-keygen", [...args], { stdio: ["ignore", "ignore", "pipe"] });
  }

  function signedWorkspace(): { readonly reviews: string; readonly keyPath: string } {
    directory = mkdtempSync(join(tmpdir(), "keiko-signed-review-"));
    const source = join(directory, "source");
    const controlled = join(directory, "controlled");
    const reviews = join(directory, "reviews");
    for (const path of [source, controlled, reviews]) mkdirSync(path, { mode: 0o700 });
    const rubricDirectory = join(source, "docs/qa/evidence/coding-issue-journey/3390");
    mkdirSync(rubricDirectory, { recursive: true });
    writeFileSync(join(rubricDirectory, "rubric.md"), RUBRIC);
    const keyPath = join(directory, "reviewer-key");
    ssh(["-t", "ed25519", "-N", "", "-C", "reviewer", "-f", keyPath]);
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8")
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    const allowedSigners = join(directory, "allowed-signers");
    writeFileSync(
      allowedSigners,
      `reviewer@example.test namespaces="keiko-qualification-review" ${publicKey}\n`,
    );
    vi.spyOn(process, "cwd").mockReturnValue(source);
    vi.stubEnv("KEIKO_QUALIFICATION_CONTROLLED_REPOSITORY_ROOT", controlled);
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_DIR", reviews);
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_ALLOWED_SIGNERS", allowedSigners);
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_SIGNER", "reviewer@example.test");
    return { reviews, keyPath };
  }

  function answer(responsePath: string, keyPath: string, bytes: Buffer): void {
    writeFileSync(responsePath, bytes);
    ssh(["-Y", "sign", "-f", keyPath, "-n", "keiko-qualification-review", responsePath]);
  }

  it("parks until a signed answer appears and then resumes with the contract row", async () => {
    const { keyPath } = signedWorkspace();
    const request = requestIndependentQualificationReview(IDENTITY);
    const pending = awaitIndependentQualificationReview(IDENTITY);
    // Written only after the wait has started: the flow resumes on the answer, not on a poll clock.
    setTimeout(() => {
      answer(request.responsePath, keyPath, response());
    }, 50);
    await expect(pending).resolves.toMatchObject({
      verdict: "approved",
      criteriaTotal: 4,
      criteriaPassed: 4,
      pullRequestNumber: IDENTITY.pullRequestNumber,
    });
  });

  it("fails closed on an unsigned, foreign-signed or edited answer", async () => {
    const { keyPath } = signedWorkspace();
    const request = requestIndependentQualificationReview(IDENTITY);
    writeFileSync(request.responsePath, response());
    writeFileSync(signaturePathFor(request.responsePath), "not a signature");
    await expect(awaitIndependentQualificationReview(IDENTITY)).rejects.toThrow(
      "signature is missing or invalid",
    );

    answer(request.responsePath, keyPath, response());
    const edited = response().toString().replace("checked", "cheched");
    writeFileSync(request.responsePath, edited);
    await expect(awaitIndependentQualificationReview(IDENTITY)).rejects.toThrow(
      "signature is missing or invalid",
    );
  });

  it("reports a signed withheld approval as a rejection, never as a missing answer", async () => {
    const { keyPath } = signedWorkspace();
    const request = requestIndependentQualificationReview(IDENTITY);
    answer(request.responsePath, keyPath, response(CRITERIA, { "average-empty": "rejected" }));
    await expect(awaitIndependentQualificationReview(IDENTITY)).rejects.toThrow(
      IndependentQualificationReviewRejected,
    );
    await expect(awaitIndependentQualificationReview(IDENTITY)).rejects.toThrow("average-empty");
  });

  it("bounds the park only when an operator configures a bound", async () => {
    signedWorkspace();
    vi.stubEnv("KEIKO_QUALIFICATION_REVIEW_TIMEOUT_MS", "150");
    await expect(awaitIndependentQualificationReview(IDENTITY)).rejects.toThrow(
      "did not answer within the configured bound",
    );
  });
});
