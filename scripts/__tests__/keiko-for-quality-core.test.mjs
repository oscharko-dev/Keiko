import { describe, expect, it } from "vitest";

import {
  evaluateKeikoForQuality,
  isBotEvidence,
  isValidHeadSha,
  latestQodoReview,
  parseQodoFindings,
  stabilityFailures,
} from "../keiko-for-quality-core.mjs";

const headSha = "a".repeat(40);
const reviewedAt = "2026-07-11T10:00:00.000Z";
const now = Date.parse("2026-07-11T10:02:00.000Z");
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
    updatedAt: reviewedAt,
    ...overrides,
  };
}

function passingInput() {
  return { comments: [qodoComment()], headSha, now };
}

function evaluate(update = {}) {
  return evaluateKeikoForQuality({ ...passingInput(), ...update });
}

describe("Keiko for Quality core", () => {
  it("validates only full 40-hex head SHAs", () => {
    expect(isValidHeadSha(headSha)).toBe(true);
    expect(isValidHeadSha("A".repeat(40))).toBe(false);
    expect(isValidHeadSha("a".repeat(39))).toBe(false);
    expect(isValidHeadSha(`a${"b".repeat(40)}`)).toBe(false);
    expect(isValidHeadSha({ toString: () => headSha })).toBe(false);
    expect(isValidHeadSha(undefined)).toBe(false);
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
    const older = qodoComment({ ...base, body: qodoBody({ bugs: 5 }), updatedAt: reviewedAt });
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
    const comments = [qodoComment({ body: qodoBody({ bugs: 2, sha: parent }) })];
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

  it("ignores malformed merge-context input shapes instead of widening currency", () => {
    const parent = "f".repeat(40);
    const comments = [qodoComment({ body: qodoBody({ sha: parent }) })];
    // A non-array mergeParents and a non-numeric mergeCommitTime read as "no merge context".
    const result = evaluate({ comments, mergeParents: parent, mergeCommitTime: reviewedAt });
    expect(result.failures).toContain("Current Qodo finding evidence is missing or unparseable.");
  });

  it("accepts only complete current-head evidence after the stability window", () => {
    expect(evaluate()).toEqual({ failures: [], passed: true });
  });

  it("uses the newest review evidence and an inclusive stability boundary", () => {
    const comments = [qodoComment({ updatedAt: "2026-07-11T10:01:00.000Z" })];
    expect(
      stabilityFailures(comments, Date.parse("2026-07-11T10:02:00.000Z"), 60_000, headSha),
    ).toEqual([]);
    expect(
      stabilityFailures(comments, Date.parse("2026-07-11T10:01:59.999Z"), 60_000, headSha),
    ).toEqual(["Review-product evidence is inside the stability window."]);
  });

  it("fails closed when stability evidence is missing or not current", () => {
    expect(stabilityFailures([], now, 60_000, headSha)).toEqual([
      "Review-product stability evidence is incomplete.",
    ]);
    const staleHead = [qodoComment({ body: qodoBody({ sha: "b".repeat(40) }) })];
    expect(stabilityFailures(staleHead, now, 60_000, headSha)).toEqual([
      "Review-product stability evidence is incomplete.",
    ]);
    const invalidTime = [qodoComment({ updatedAt: "not-a-date" })];
    expect(stabilityFailures(invalidTime, now, 60_000, headSha)).toEqual([
      "Review-product stability evidence is incomplete.",
    ]);
  });

  it("applies the stability window to a fresh parent-pinned merge-commit review", () => {
    const parent = "f".repeat(40);
    const mergeAt = Date.parse("2026-07-11T09:59:00.000Z");
    const comments = [qodoComment({ body: qodoBody({ sha: parent }) })];
    // The parent-bound review is the stability subject too — no merge context means no evidence.
    expect(stabilityFailures(comments, now, 60_000, headSha)).toEqual([
      "Review-product stability evidence is incomplete.",
    ]);
    expect(stabilityFailures(comments, now, 60_000, headSha, [parent], mergeAt)).toEqual([]);
    expect(
      stabilityFailures(
        comments,
        Date.parse("2026-07-11T10:00:59.999Z"),
        60_000,
        headSha,
        [parent],
        mergeAt,
      ),
    ).toEqual(["Review-product evidence is inside the stability window."]);
  });

  it("waits for a bounded review-product stability window with the default width", () => {
    // passingInput carries no stabilityMs, so the 60-second default is exercised here.
    expect(evaluate({ now: Date.parse("2026-07-11T10:00:30.000Z") }).failures).toEqual([
      "Review-product evidence is inside the stability window.",
    ]);
    expect(evaluate({ now: Date.parse("2026-07-11T10:01:00.000Z") }).passed).toBe(true);
    // An explicit wider window keeps the same evidence unsettled.
    expect(evaluate({ stabilityMs: 10 * 60_000 }).failures).toEqual([
      "Review-product evidence is inside the stability window.",
    ]);
  });

  it("rejects unresolved current-head Qodo findings as a hard failure", () => {
    const comments = [qodoComment({ body: qodoBody({ bugs: 2 }) })];
    expect(evaluate({ comments }).failures).toContain("Qodo has 2 unresolved finding(s).");
    expect(evaluate({ comments }).passed).toBe(false);
  });

  it("fails closed when current-head Qodo evidence is absent", () => {
    expect(evaluate({ comments: [] }).failures).toEqual([
      "Current Qodo finding evidence is missing or unparseable.",
      "Review-product stability evidence is incomplete.",
    ]);
  });

  it("passes on all-clear Qodo output and fails closed on an unparseable summary", () => {
    expect(evaluate({ comments: [qodoComment({ body: qodoBody({ skills: 7 }) })] }).passed).toBe(
      true,
    );
    const unparseable = [
      qodoComment({
        body: `<h3>Code Review by Qodo</h3>\nReviewing your changes... ${headSha}`,
      }),
    ];
    expect(evaluate({ comments: unparseable }).failures).toContain(
      "Current Qodo finding evidence is missing or unparseable.",
    );
  });

  it("rejects review evidence that is not bound to the current head", () => {
    const comments = [qodoComment({ body: qodoBody({ sha: "b".repeat(40) }) })];
    expect(evaluate({ comments }).failures).toContain(
      "Current Qodo finding evidence is missing or unparseable.",
    );
  });

  it("invalidates old evidence after a new commit", () => {
    expect(evaluate({ headSha: "c".repeat(40) }).passed).toBe(false);
  });

  it("rejects spoofed human and wrong-app review evidence", () => {
    for (const spoofed of [
      qodoComment({ authorId: 1 }),
      qodoComment({ authorType: "User" }),
      qodoComment({ appId: 1 }),
    ]) {
      expect(evaluate({ comments: [spoofed] }).failures).toContain(
        "Current Qodo finding evidence is missing or unparseable.",
      );
    }
  });

  it("selects the newest duplicate review deterministically", () => {
    const comments = [
      qodoComment({ body: qodoBody({ bugs: 9 }), updatedAt: "2026-07-11T08:00:00.000Z" }),
      qodoComment(),
    ];
    expect(evaluate({ comments }).passed).toBe(true);
  });
});
