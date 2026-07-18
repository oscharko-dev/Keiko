import { describe, expect, it } from "vitest";

import {
  acceptedSocketRisks,
  checkFailures,
  commentIsCurrent,
  currentCheckStart,
  evaluateKeikoForQuality,
  hasCurrentSocketNoAlertEvidence,
  isBotEvidence,
  latestQodoReview,
  nativeRequiredChecks,
  packageAlerts,
  parseQodoFindings,
  requiredChecks,
  requiredChecksForProfile,
  stabilityFailures,
  validatedSet,
  validatedRiskAllowlist,
} from "../keiko-for-quality-core.mjs";

const headSha = "a".repeat(40);
const completedAt = "2026-07-11T10:00:00.000Z";
const now = Date.parse("2026-07-11T10:02:00.000Z");
const risk = "npm/execa@9.6.1";
const qodoAuthorId = 151058649;
const qodoAppId = 484649;

// Faithful reproduction of Qodo's summary comment: an <h3> header, the exact
// emoji/HTML counts line (Qodo omits a category when it does not apply — `omit` models that), and
// the footer commit marker Qodo emits for every review, which anchors even a clean review (no
// finding permalinks) to its reviewed head.
function qodoBody({ bugs = 0, rules = 0, gaps = 0, skills = 0, sha = headSha, omit = [] } = {}) {
  const categories = [
    ["bugs", `🐞 Bugs (${String(bugs)})`],
    ["rules", `📘 Rule violations (${String(rules)})`],
    ["gaps", `📎 Requirement gaps (${String(gaps)})`],
    ["skills", `📜 Skill insights (${String(skills)})`],
  ];
  const countsLine = categories
    .filter(([key]) => !omit.includes(key))
    .map(([, label]) => `<code>${label}</code>`)
    .join("  ");
  return [
    "<h3>Code Review by Qodo</h3>",
    "",
    countsLine,
    "",
    `<!-- https://github.com/oscharko-dev/Keiko/commit/${sha} -->`,
  ].join("\n");
}

function qodoComment(overrides = {}) {
  return {
    author: "qodo-code-review[bot]",
    appId: qodoAppId,
    authorAssociation: "NONE",
    authorId: qodoAuthorId,
    authorType: "Bot",
    body: qodoBody(),
    updatedAt: completedAt,
    ...overrides,
  };
}

function passingInput() {
  return {
    checks: requiredChecks.map(({ appId, name }) => ({
      appId,
      completedAt,
      conclusion: "success",
      headSha,
      name,
      startedAt: "2026-07-11T08:59:00.000Z",
      status: "completed",
    })),
    comments: [
      qodoComment(),
      {
        author: "socket-security",
        appId: 156372,
        authorAssociation: "NONE",
        authorId: 95510084,
        authorType: "Bot",
        body: `[!WARNING] <a href="https://socket.dev/npm/package/execa/overview/9.6.1">risk</a>`,
        updatedAt: completedAt,
      },
      {
        author: "oscharko",
        authorAssociation: "MEMBER",
        body: `@SocketSecurity ignore ${risk}`,
        updatedAt: completedAt,
      },
    ],
    headSha,
    now,
    socketRiskAllowlist: [risk],
    socketRiskActors: ["oscharko"],
  };
}

function evaluate(update = {}) {
  return evaluateKeikoForQuality({ ...passingInput(), ...update });
}

describe("Keiko for Quality core", () => {
  it("pins the complete required-check policy to exact producer app IDs", () => {
    expect(requiredChecks).toEqual([
      { appId: 15368, name: "ci" },
      { appId: 15368, name: "actionlint" },
      { appId: 15368, name: "Verify pinned action SHAs" },
      { appId: 15368, name: "zizmor" },
      { appId: 15368, name: "Analyze (actions)" },
      { appId: 15368, name: "Analyze (javascript-typescript)" },
      { appId: 15368, name: "Build, scan, SBOM, smoke" },
      { appId: 15368, name: "Review dependency diff (dev/main)" },
      { appId: 15368, name: "ui" },
      { appId: 15368, name: "Scan dependency lockfiles" },
      { appId: 12526, name: "SonarCloud Code Analysis" },
      { appId: 156372, name: "Socket Security: Project Report" },
      { appId: 156372, name: "Socket Security: Pull Request Alerts" },
    ]);
  });

  it("pins the Keiko Native profile without Keiko-specific UI or mutation contexts", () => {
    expect(nativeRequiredChecks).toEqual([
      { appId: 15368, name: "ci" },
      { appId: 15368, name: "actionlint" },
      { appId: 15368, name: "Verify pinned action SHAs" },
      { appId: 15368, name: "zizmor" },
      { appId: 15368, name: "Analyze (actions)" },
      { appId: 15368, name: "Analyze (javascript-typescript)" },
      { appId: 15368, name: "Build, scan, SBOM, smoke" },
      { appId: 15368, name: "Review dependency diff (dev/main)" },
      { appId: 15368, name: "native" },
      { appId: 15368, name: "Scan dependency lockfiles" },
      { appId: 12526, name: "SonarCloud Code Analysis" },
      { appId: 156372, name: "Socket Security: Project Report" },
      { appId: 156372, name: "Socket Security: Pull Request Alerts" },
    ]);
    expect(requiredChecksForProfile("keiko")).toBe(requiredChecks);
    expect(requiredChecksForProfile("keiko-native")).toBe(nativeRequiredChecks);
    expect(() => requiredChecksForProfile("unknown")).toThrow("Unsupported quality-gate profile.");
  });

  it("evaluates the explicitly selected required-check profile", () => {
    const input = passingInput();
    input.requiredChecks = nativeRequiredChecks;
    input.checks = [
      ...input.checks.filter(({ name }) =>
        ["Socket Security: Project Report", "Socket Security: Pull Request Alerts"].includes(name),
      ),
      ...nativeRequiredChecks.map(({ appId, name }) => ({
        appId,
        completedAt,
        conclusion: "success",
        headSha,
        name,
        startedAt: "2026-07-11T08:59:00.000Z",
        status: "completed",
      })),
    ];
    expect(evaluateKeikoForQuality(input)).toEqual({ failures: [], passed: true });
  });

  it("keeps running checks pending and reserves failure for terminal conclusions", () => {
    const [expected] = requiredChecks;
    const running = {
      appId: expected.appId,
      conclusion: null,
      headSha,
      name: expected.name,
      status: "in_progress",
    };
    expect(checkFailures([running], headSha, [expected])).toEqual([
      `Check is pending: ${expected.name}.`,
    ]);
    expect(
      checkFailures([{ ...running, conclusion: "failure", status: "completed" }], headSha, [
        expected,
      ]),
    ).toEqual([`Check is not successful: ${expected.name}.`]);
  });

  it("binds bot evidence to immutable user, type, and app identities", () => {
    const identity = { appId: 7, userId: 9 };
    const exact = { appId: 7, authorId: 9, authorType: "Bot" };
    expect(isBotEvidence(exact, identity, true)).toBe(true);
    expect(isBotEvidence({ ...exact, appId: 8 }, identity, true)).toBe(false);
    expect(isBotEvidence({ ...exact, authorId: 8 }, identity, true)).toBe(false);
    expect(isBotEvidence({ ...exact, authorType: "User" }, identity, true)).toBe(false);
    expect(isBotEvidence({ ...exact, appId: 8 }, identity, false)).toBe(true);
  });

  it("sums Qodo findings across present categories and excludes skill insights", () => {
    // Real 4-category counts line (captured from a /review).
    const fourCategories =
      "<h3>Code Review by Qodo</h3>\n\n" +
      "<code>🐞 Bugs (2)</code>  <code>📘 Rule violations (1)</code>  " +
      "<code>📎 Requirement gaps (3)</code>  <code>📜 Skill insights (4)</code>";
    expect(parseQodoFindings(fourCategories)).toBe(6);
    // Real variable line: Qodo omits Requirement gaps when it does not apply (captured from PR #2497).
    const noGaps =
      "<h3>Code Review by Qodo</h3>\n\n" +
      "<code>🐞 Bugs (3)</code>  <code>📘 Rule violations (0)</code>  <code>📜 Skill insights (0)</code>";
    expect(parseQodoFindings(noGaps)).toBe(3);
    expect(parseQodoFindings(qodoBody({ bugs: 1, rules: 2, gaps: 3, skills: 9 }))).toBe(6);
    expect(parseQodoFindings(qodoBody({ bugs: 3, omit: ["gaps"] }))).toBe(3);
    expect(parseQodoFindings(qodoBody())).toBe(0);
    expect(parseQodoFindings(qodoBody({ skills: 7 }))).toBe(0);
  });

  it("rejects Qodo bodies without the header or any recognizable blocking count", () => {
    const header = "<h3>Code Review by Qodo</h3>\n";
    expect(parseQodoFindings("Bugs (1) Rule violations (0)")).toBeUndefined();
    expect(parseQodoFindings(`${header}Reviewing your changes...`)).toBeUndefined();
    expect(parseQodoFindings(`${header}Skill insights (4)`)).toBeUndefined();
    expect(parseQodoFindings(`${header}Bugs (2)`)).toBe(2);
    expect(parseQodoFindings(`${header}Requirement gaps (1)`)).toBe(1);
  });

  it("selects the newest parseable current-head Qodo summary over shadows", () => {
    const base = { appId: qodoAppId, authorAssociation: "NONE", authorId: qodoAuthorId };
    const older = qodoComment({ ...base, body: qodoBody({ bugs: 5 }), updatedAt: completedAt });
    // A clean review anchored to the head only by the footer commit marker (no finding permalinks).
    const clean = qodoComment({ body: qodoBody(), updatedAt: "2026-07-11T10:01:00.000Z" });
    // A newer Qodo comment that is not a parseable summary must not shadow the real summary.
    const shadow = qodoComment({
      body: `<h3>Code Review by Qodo</h3>\n\nRe-running the review... ${headSha}`,
      updatedAt: "2026-07-11T10:02:00.000Z",
    });
    const wrongHead = qodoComment({ body: qodoBody({ sha: "b".repeat(40) }) });
    const wrongApp = qodoComment({ appId: 1 });
    expect(latestQodoReview([older, clean, shadow, wrongHead, wrongApp], headSha)).toBe(clean);
    expect(latestQodoReview([shadow], headSha)).toBeUndefined();
    expect(latestQodoReview([wrongHead], headSha)).toBeUndefined();
    expect(latestQodoReview([wrongApp], headSha)).toBeUndefined();
  });

  it("binds Qodo currency to a merge-commit head via a fresh parent-pinned review", () => {
    const parent = "f".repeat(40);
    // The merge commit was created just before Qodo re-posted its parent-pinned review (10:00).
    const mergeAt = Date.parse("2026-07-11T09:59:00.000Z");
    const review = qodoComment({ body: qodoBody({ bugs: 2, sha: parent }) });
    // Normal commit (no merge parents): a parent-pinned review is NOT current for the head.
    expect(latestQodoReview([review], headSha)).toBeUndefined();
    expect(latestQodoReview([review], headSha, [])).toBeUndefined();
    // A merge parent without the merge time is not enough — parent binding needs the freshness gate.
    expect(latestQodoReview([review], headSha, [parent])).toBeUndefined();
    // Merge-commit head with the merge time: the fresh parent-pinned review binds.
    expect(latestQodoReview([review], headSha, [parent], mergeAt)).toBe(review);
    expect(latestQodoReview([review], headSha, ["c".repeat(40), parent], mergeAt)).toBe(review);
  });

  it("rejects a pre-merge parent review and ignores malformed merge parents", () => {
    const parent = "f".repeat(40);
    const review = qodoComment({ body: qodoBody({ bugs: 2, sha: parent }) }); // updatedAt 10:00
    // A parent-pinned review created AFTER the merge commit's time is stale — never current (#1).
    const afterReview = Date.parse("2026-07-11T10:01:00.000Z");
    expect(latestQodoReview([review], headSha, [parent], afterReview)).toBeUndefined();
    // An empty/short merge parent must not match every comment body via includes() (#4).
    const mergeAt = Date.parse("2026-07-11T09:59:00.000Z");
    expect(latestQodoReview([review], headSha, [""], mergeAt)).toBeUndefined();
    expect(latestQodoReview([review], headSha, ["fff"], mergeAt)).toBeUndefined();
  });

  it("reads Qodo findings on a merge-commit head through fresh merge parents", () => {
    const parent = "f".repeat(40);
    const mergeAt = Date.parse("2026-07-11T09:59:00.000Z");
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === qodoAuthorId
        ? { ...comment, body: qodoBody({ bugs: 2, sha: parent }) }
        : comment,
    );
    // Without the merge parent, the parent-pinned review looks missing (fail closed, still blocks).
    expect(evaluate({ comments }).failures).toContain(
      "Current Qodo finding evidence is missing or unparseable.",
    );
    // A merge parent alone (no merge time) is still treated as missing — no stale acceptance.
    expect(evaluate({ comments, mergeParents: [parent] }).failures).toContain(
      "Current Qodo finding evidence is missing or unparseable.",
    );
    // With the merge parent AND the merge commit time, KFQ reports the 2 unresolved findings.
    expect(
      evaluate({ comments, mergeParents: [parent], mergeCommitTime: mergeAt }).failures,
    ).toContain("Qodo has 2 unresolved finding(s).");
  });

  it("extracts and deduplicates exact Socket package versions", () => {
    expect(packageAlerts("No warnings: npm/execa@9.6.1")).toEqual([]);
    expect(
      packageAlerts(
        "[!WARNING] npm/execa@9.6.1 npm/@scope/pkg@1.2.3 " +
          "https://socket.dev/npm/package/execa/overview/9.6.1 " +
          "https://socket.dev/npm/package/pkg/overview/2.0.0",
      ),
    ).toEqual(["npm/execa@9.6.1", "npm/@scope/pkg@1.2.3", "npm/pkg@2.0.0"]);
  });

  it("accepts Socket risk commands only at the exact actor, role, time, and allowlist boundary", () => {
    const comments = [
      {
        author: "owner",
        authorAssociation: "OWNER",
        body: "@SocketSecurity ignore npm/execa@9.6.1",
        updatedAt: completedAt,
      },
      {
        author: "member",
        authorAssociation: "MEMBER",
        body: "@SocketSecurity  ignore  npm/pkg@1.0.0",
        updatedAt: completedAt,
      },
      {
        author: "owner",
        authorAssociation: "CONTRIBUTOR",
        body: "@SocketSecurity ignore npm/rejected@1.0.0",
        updatedAt: completedAt,
      },
    ];
    expect(
      acceptedSocketRisks(
        comments,
        new Set(["npm/execa@9.6.1", "npm/pkg@1.0.0"]),
        new Set(["owner", "member"]),
        Date.parse(completedAt),
      ),
    ).toEqual(new Set(["npm/execa@9.6.1", "npm/pkg@1.0.0"]));
    expect(
      acceptedSocketRisks(
        comments,
        new Set(["npm/execa@9.6.1"]),
        new Set(["owner"]),
        Date.parse(completedAt) + 1,
      ),
    ).toEqual(new Set());
  });

  it("selects only the latest current-head start and exact current comment boundary", () => {
    const name = "Socket Security: Pull Request Alerts";
    const checks = [
      { headSha, name, startedAt: "2026-07-11T09:00:00.000Z" },
      { headSha, name, started_at: "2026-07-11T09:30:00.000Z" },
      { headSha, name, startedAt: "invalid" },
      { headSha: "b".repeat(40), name, startedAt: completedAt },
      { headSha, name: "Other", startedAt: completedAt },
    ];
    const start = currentCheckStart(checks, headSha, [name]);
    expect(start).toBe(Date.parse("2026-07-11T09:30:00.000Z"));
    expect(commentIsCurrent({ updatedAt: "2026-07-11T09:30:00.000Z" }, start)).toBe(true);
    expect(commentIsCurrent({ updatedAt: "2026-07-11T09:29:59.999Z" }, start)).toBe(false);
    expect(commentIsCurrent(undefined, start)).toBe(false);
    expect(commentIsCurrent({ updatedAt: completedAt }, Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("uses the newest duplicate check and keeps an incomplete state pending", () => {
    const policy = requiredChecks[0];
    const checks = [
      {
        appId: policy.appId,
        completedAt: "2026-07-11T09:00:00.000Z",
        conclusion: "success",
        headSha,
        name: policy.name,
        status: "completed",
      },
      {
        appId: policy.appId,
        completed_at: completedAt,
        conclusion: "success",
        headSha,
        name: policy.name,
        status: "in_progress",
      },
    ];
    expect(checkFailures(checks, headSha)).toContain(`Check is pending: ${policy.name}.`);
    expect(
      checkFailures(
        [
          ...passingInput().checks.filter((check) => check.name !== policy.name),
          { ...checks[0], conclusion: "failure" },
          { ...checks[1], completed_at: "2026-07-11T10:01:00.000Z", status: "completed" },
        ],
        headSha,
      ),
    ).toEqual([]);

    expect(
      checkFailures(
        [
          ...passingInput().checks.filter((check) => check.name !== policy.name),
          {
            ...checks[0],
            completedAt: undefined,
            conclusion: "failure",
          },
          { ...checks[1], status: "completed" },
        ],
        headSha,
      ),
    ).toEqual([]);
  });

  it("uses the newest review-product evidence and an inclusive stability boundary", () => {
    const input = passingInput();
    const comments = input.comments.map((comment) =>
      comment.authorId === qodoAuthorId
        ? { ...comment, updatedAt: "2026-07-11T10:01:00.000Z" }
        : comment,
    );
    expect(
      stabilityFailures(
        input.checks,
        comments,
        Date.parse("2026-07-11T10:02:00.000Z"),
        60_000,
        headSha,
      ),
    ).toEqual([]);
    expect(
      stabilityFailures(
        input.checks,
        comments,
        Date.parse("2026-07-11T10:01:59.999Z"),
        60_000,
        headSha,
      ),
    ).toEqual(["Review-product evidence is inside the stability window."]);
    expect(
      stabilityFailures(
        [...input.checks, { completedAt: "2026-07-11T10:01:59.999Z", name: "Untrusted check" }],
        comments,
        now,
        60_000,
        headSha,
      ),
    ).toEqual([]);
  });

  it("accepts only complete current-head evidence after the stability window", () => {
    expect(evaluate()).toEqual({ failures: [], passed: true });
  });

  it("accepts an explicit clean Socket check when Socket correctly posts no comment", () => {
    const input = passingInput();
    input.comments = input.comments.filter((comment) => comment.authorId !== 95510084);
    input.checks = input.checks.map((check) =>
      check.name === "Socket Security: Pull Request Alerts"
        ? { ...check, socketNoAlerts: true }
        : check,
    );

    expect(hasCurrentSocketNoAlertEvidence(input.checks, headSha)).toBe(true);
    expect(evaluateKeikoForQuality(input)).toEqual({ failures: [], passed: true });
  });

  it("binds clean Socket output to every exact current-head check attribute", () => {
    const cleanCheck = {
      appId: 156372,
      completedAt,
      conclusion: "success",
      headSha,
      name: "Socket Security: Pull Request Alerts",
      socketNoAlerts: true,
      status: "completed",
    };
    expect(hasCurrentSocketNoAlertEvidence([cleanCheck], headSha)).toBe(true);
    for (const invalid of [
      { ...cleanCheck, appId: 1 },
      { ...cleanCheck, conclusion: "neutral" },
      { ...cleanCheck, headSha: "b".repeat(40) },
      { ...cleanCheck, name: "Socket Security: Project Report" },
      { ...cleanCheck, socketNoAlerts: false },
      { ...cleanCheck, status: "in_progress" },
    ]) {
      expect(hasCurrentSocketNoAlertEvidence([invalid], headSha)).toBe(false);
    }
    expect(hasCurrentSocketNoAlertEvidence([], headSha)).toBe(false);
  });

  it("fails closed without a current Socket comment or an explicit clean check output", () => {
    const input = passingInput();
    input.comments = input.comments.filter((comment) => comment.authorId !== 95510084);
    expect(hasCurrentSocketNoAlertEvidence(input.checks, headSha)).toBe(false);
    expect(evaluateKeikoForQuality(input).failures).toEqual(
      expect.arrayContaining([
        "Current Socket alert evidence is missing.",
        "Review-product stability evidence is incomplete.",
      ]),
    );
  });

  it("requires both Socket check timestamps when deciding comment freshness", () => {
    const input = passingInput();
    for (const checkName of [
      "Socket Security: Project Report",
      "Socket Security: Pull Request Alerts",
    ]) {
      const checks = input.checks.map((check) =>
        check.name === checkName ? { ...check, startedAt: "2026-07-11T10:00:00.001Z" } : check,
      );
      expect(stabilityFailures(checks, input.comments, now, 60_000, headSha)).toContain(
        "Review-product stability evidence is incomplete.",
      );
    }
  });

  it("does not lower stability completeness when a current Socket comment already exists", () => {
    const input = passingInput();
    const checks = input.checks
      .filter((check) => check.name !== "Socket Security: Project Report")
      .map((check) =>
        check.name === "Socket Security: Pull Request Alerts"
          ? { ...check, socketNoAlerts: true }
          : check,
      );
    expect(stabilityFailures(checks, input.comments, now, 60_000, headSha)).toContain(
      "Review-product stability evidence is incomplete.",
    );
  });

  it.each([
    ["missing", (input) => input.checks.slice(1), "Missing current-head check"],
    [
      "red",
      (input) =>
        input.checks.map((check, index) =>
          index === 0 ? { ...check, conclusion: "failure" } : check,
        ),
      "not successful",
    ],
    [
      "wrong app",
      (input) => input.checks.map((check, index) => (index === 0 ? { ...check, appId: 1 } : check)),
      "Wrong producer",
    ],
    [
      "stale",
      (input) =>
        input.checks.map((check, index) =>
          index === 0 ? { ...check, headSha: "b".repeat(40) } : check,
        ),
      "Missing current-head",
    ],
  ])("rejects %s check evidence", (_name, mutate, message) => {
    const input = passingInput();
    expect(evaluate({ checks: mutate(input) }).failures.join(" ")).toContain(message);
  });

  it("rejects unresolved current-head Qodo findings", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === qodoAuthorId ? { ...comment, body: qodoBody({ bugs: 2 }) } : comment,
    );
    expect(evaluate({ comments }).failures).toContain("Qodo has 2 unresolved finding(s).");
  });

  it("fails closed when current-head Qodo evidence is absent", () => {
    expect(
      evaluate({
        comments: passingInput().comments.filter((comment) => comment.authorId !== qodoAuthorId),
      }).failures,
    ).toContain("Current Qodo finding evidence is missing or unparseable.");
  });

  it("passes on all-clear Qodo output and fails closed on an unparseable summary", () => {
    const clean = passingInput().comments.map((comment) =>
      comment.authorId === qodoAuthorId ? { ...comment, body: qodoBody({ skills: 7 }) } : comment,
    );
    expect(evaluate({ comments: clean }).passed).toBe(true);

    const unparseable = passingInput().comments.map((comment) =>
      comment.authorId === qodoAuthorId
        ? { ...comment, body: `<h3>Code Review by Qodo</h3>\nReviewing your changes... ${headSha}` }
        : comment,
    );
    expect(evaluate({ comments: unparseable }).failures).toContain(
      "Current Qodo finding evidence is missing or unparseable.",
    );
  });

  it("rejects review-product evidence that is not bound to the current head", () => {
    const comments = passingInput().comments.map((comment) => {
      if (comment.authorId === qodoAuthorId) {
        return { ...comment, body: qodoBody({ sha: "b".repeat(40) }) };
      }
      if (comment.authorId === 95510084) {
        return { ...comment, updatedAt: "2026-07-11T08:58:00.000Z" };
      }
      return comment;
    });
    expect(evaluate({ comments }).failures).toEqual(
      expect.arrayContaining([
        "Current Qodo finding evidence is missing or unparseable.",
        "Current Socket alert evidence is missing.",
      ]),
    );
  });

  it("requires Socket evidence after both named Socket checks", () => {
    const checks = passingInput().checks.map((check) =>
      check.name === "Socket Security: Pull Request Alerts"
        ? { ...check, startedAt: "2026-07-11T10:00:00.001Z" }
        : check,
    );
    expect(evaluate({ checks }).failures).toContain("Current Socket alert evidence is missing.");
    const projectChecks = passingInput().checks.map((check) =>
      check.name === "Socket Security: Project Report"
        ? { ...check, startedAt: "2026-07-11T10:00:00.001Z" }
        : check,
    );
    expect(evaluate({ checks: projectChecks }).failures).toContain(
      "Current Socket alert evidence is missing.",
    );
  });

  it("rejects malformed risk policy entries rather than widening authority", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.author === "oscharko" ? { ...comment, author: "invalid actor" } : comment,
    );
    expect(
      evaluate({
        comments,
        socketRiskActors: ["invalid actor"],
        socketRiskAllowlist: [risk, "invalid package"],
      }).failures,
    ).toContain("1 Socket warning(s) remain.");
  });

  it("validates exact unscoped and scoped npm risk identifiers", () => {
    const scoped = "npm/@scope/package@1.2.3";
    expect([...validatedRiskAllowlist([risk, scoped])]).toEqual([risk, scoped]);
    for (const invalid of [
      `prefix-${risk}`,
      `${risk} trailing`,
      { toString: () => risk },
      "npm/@scope with space/package@1.2.3",
    ]) {
      expect(validatedRiskAllowlist([invalid]).size).toBe(0);
    }
    expect(validatedSet(["value"], /^value$/u).size).toBe(1);
  });

  it("fails closed for incomplete stability evidence and default options", () => {
    const input = passingInput();
    delete input.socketRiskAllowlist;
    delete input.stabilityMs;
    input.checks = input.checks.map((check) => ({ ...check, completedAt: undefined }));
    expect(evaluateKeikoForQuality(input).failures).toEqual(
      expect.arrayContaining([
        "1 Socket warning(s) remain.",
        "Review-product stability evidence is incomplete.",
      ]),
    );
  });

  it("accepts a warning-free Socket report without owner commands", () => {
    const comments = passingInput()
      .comments.filter((comment) => comment.author !== "oscharko")
      .map((comment) =>
        comment.authorId === 95510084 ? { ...comment, body: "No alerts" } : comment,
      );
    expect(evaluate({ comments, socketRiskAllowlist: [] }).passed).toBe(true);
  });

  it("selects the newest duplicate checks and comments deterministically", () => {
    const input = passingInput();
    const olderChecks = input.checks.map((check) => ({
      ...check,
      completedAt: undefined,
      completed_at: "2026-07-11T08:00:00.000Z",
      conclusion: "failure",
      startedAt: undefined,
      started_at: "2026-07-11T07:59:00.000Z",
    }));
    const comments = [
      qodoComment({ body: qodoBody({ bugs: 9 }), updatedAt: "2026-07-11T08:00:00.000Z" }),
      ...input.comments,
    ];
    expect(evaluate({ checks: [...olderChecks, ...input.checks], comments }).passed).toBe(true);
  });

  it("parses direct and scoped Socket package identifiers exactly", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === 95510084
        ? {
            ...comment,
            body: "[!WARNING] npm/execa@9.6.1 npm/@scope/package@1.2.3",
          }
        : comment,
    );
    expect(evaluate({ comments }).failures).toContain("1 Socket warning(s) remain.");
  });

  it("rejects Socket warnings without an exact allowlisted owner acceptance", () => {
    expect(evaluate({ socketRiskAllowlist: [] }).failures).toContain("1 Socket warning(s) remain.");
    expect(evaluate({ socketRiskAllowlist: ["npm/execa@9.6.2"] }).failures).toContain(
      "1 Socket warning(s) remain.",
    );
  });

  it("rejects Socket acceptance from an untrusted or stale actor", () => {
    expect(evaluate({ socketRiskActors: ["attacker"] }).failures).toContain(
      "1 Socket warning(s) remain.",
    );
    const comments = passingInput().comments.map((comment) =>
      comment.author === "oscharko"
        ? { ...comment, updatedAt: "2026-07-11T08:58:00.000Z" }
        : comment,
    );
    expect(evaluate({ comments }).failures).toContain("1 Socket warning(s) remain.");
  });

  it("rejects Socket errors even when the package risk is accepted", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === 95510084 ? { ...comment, body: `${comment.body} Error` } : comment,
    );
    expect(evaluate({ comments }).failures).toContain("Socket reports an error alert.");
  });

  it("invalidates old evidence after a new commit", () => {
    expect(evaluate({ headSha: "c".repeat(40) }).passed).toBe(false);
  });

  it("rejects spoofed human and wrong-app review-product evidence", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === qodoAuthorId
        ? { ...comment, authorId: 1, authorType: "User" }
        : comment.authorId === 95510084
          ? { ...comment, appId: 1 }
          : comment,
    );
    expect(evaluate({ comments }).failures).toEqual(
      expect.arrayContaining([
        "Current Qodo finding evidence is missing or unparseable.",
        "Current Socket alert evidence is missing.",
      ]),
    );
  });

  it("waits for a bounded review-product stability window", () => {
    expect(evaluate({ now: Date.parse("2026-07-11T10:00:30.000Z") }).failures).toContain(
      "Review-product evidence is inside the stability window.",
    );
  });
});
