import { describe, expect, it } from "vitest";

import {
  acceptedSocketRisks,
  checkFailures,
  commentIsCurrent,
  currentCheckStart,
  evaluateBankingQualityGate,
  isBotEvidence,
  packageAlerts,
  parseGitarFindings,
  requiredChecks,
  stabilityFailures,
  validatedSet,
  validatedRiskAllowlist,
} from "../banking-quality-gate-core.mjs";

const headSha = "a".repeat(40);
const completedAt = "2026-07-11T10:00:00.000Z";
const now = Date.parse("2026-07-11T10:02:00.000Z");
const risk = "npm/execa@9.6.1";

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
      {
        author: "gitar-bot",
        appId: 827041,
        authorAssociation: "NONE",
        authorId: 159877585,
        authorType: "Bot",
        body: "0 resolved / 0 findings",
        updatedAt: completedAt,
      },
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
    reviews: [{ authorId: 159877585, authorType: "Bot", commitSha: headSha, state: "COMMENTED" }],
    socketRiskAllowlist: [risk],
    socketRiskActors: ["oscharko"],
  };
}

function evaluate(update = {}) {
  return evaluateBankingQualityGate({ ...passingInput(), ...update });
}

describe("Banking Quality Gate core", () => {
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
      { appId: 15368, name: "Mutation quality gate" },
      { appId: 12526, name: "SonarCloud Code Analysis" },
      { appId: 156372, name: "Socket Security: Project Report" },
      { appId: 156372, name: "Socket Security: Pull Request Alerts" },
      { appId: 827041, name: "Gitar" },
    ]);
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

  it("parses Gitar totals only from the exact bounded review format", () => {
    expect(parseGitarFindings("12 resolved / 15 findings")).toBe(3);
    expect(parseGitarFindings("12  resolved /  15  findings")).toBe(3);
    expect(parseGitarFindings("12 resolved/15 findings")).toBe(3);
    expect(parseGitarFindings("2 resolved / 1 findings")).toBeUndefined();
    expect(parseGitarFindings("12 resolved / findings")).toBeUndefined();
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
    const checks = [
      { headSha, name: "Gitar", startedAt: "2026-07-11T09:00:00.000Z" },
      { headSha, name: "Gitar", started_at: "2026-07-11T09:30:00.000Z" },
      { headSha, name: "Gitar", startedAt: "invalid" },
      { headSha: "b".repeat(40), name: "Gitar", startedAt: completedAt },
      { headSha, name: "Other", startedAt: completedAt },
    ];
    const start = currentCheckStart(checks, headSha, ["Gitar"]);
    expect(start).toBe(Date.parse("2026-07-11T09:30:00.000Z"));
    expect(commentIsCurrent({ updatedAt: "2026-07-11T09:30:00.000Z" }, start)).toBe(true);
    expect(commentIsCurrent({ updatedAt: "2026-07-11T09:29:59.999Z" }, start)).toBe(false);
    expect(commentIsCurrent(undefined, start)).toBe(false);
    expect(commentIsCurrent({ updatedAt: completedAt }, Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("uses the newest duplicate check and rejects incomplete terminal state", () => {
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
    expect(checkFailures(checks, headSha)).toContain(`Check is not successful: ${policy.name}.`);
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
    const checks = input.checks.map((check) =>
      check.name === "Gitar" ? { ...check, completedAt: "2026-07-11T10:01:00.000Z" } : check,
    );
    expect(
      stabilityFailures(checks, input.comments, Date.parse("2026-07-11T10:02:00.000Z"), 60_000),
    ).toEqual([]);
    expect(
      stabilityFailures(checks, input.comments, Date.parse("2026-07-11T10:01:59.999Z"), 60_000),
    ).toEqual(["Review-product evidence is inside the stability window."]);
    expect(
      stabilityFailures(
        [...input.checks, { completedAt: "2026-07-11T10:01:59.999Z", name: "Untrusted check" }],
        input.comments,
        now,
        60_000,
      ),
    ).toEqual([]);
  });

  it("accepts only complete current-head evidence after the stability window", () => {
    expect(evaluate()).toEqual({ failures: [], passed: true });
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

  it("rejects current-head Gitar change requests and unresolved findings", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === 159877585 ? { ...comment, body: "0 resolved / 2 findings" } : comment,
    );
    const reviews = [
      {
        authorId: 159877585,
        authorType: "Bot",
        commitSha: headSha,
        state: "CHANGES_REQUESTED",
      },
    ];
    expect(evaluate({ comments, reviews }).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CHANGES_REQUESTED"),
        expect.stringContaining("2 unresolved"),
      ]),
    );
  });

  it("blocks only an exact current-head Gitar bot change request among mixed reviews", () => {
    const harmless = {
      authorId: 2,
      authorType: "User",
      commitSha: headSha,
      state: "CHANGES_REQUESTED",
    };
    const stale = {
      authorId: 159877585,
      authorType: "Bot",
      commitSha: "b".repeat(40),
      state: "CHANGES_REQUESTED",
    };
    const current = { ...stale, commitSha: headSha };
    expect(evaluate({ reviews: [harmless, stale] }).passed).toBe(true);
    expect(evaluate({ reviews: [harmless, stale, current] }).failures).toContain(
      "Gitar has an active CHANGES_REQUESTED review for the current head.",
    );
  });

  it("rejects dismissed or stale Gitar evidence and changed formats", () => {
    expect(
      evaluate({
        comments: passingInput().comments.filter((comment) => comment.authorId !== 159877585),
        reviews: [],
      }).failures,
    ).toContain("Current Gitar finding evidence is missing or unparseable.");
  });

  it("derives unresolved Gitar findings from resolved and total counts", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.authorId === 159877585 ? { ...comment, body: "2 resolved / 2 findings" } : comment,
    );
    expect(evaluate({ comments }).passed).toBe(true);

    const invalid = comments.map((comment) =>
      comment.authorId === 159877585 ? { ...comment, body: "3 resolved / 2 findings" } : comment,
    );
    expect(evaluate({ comments: invalid }).failures).toContain(
      "Current Gitar finding evidence is missing or unparseable.",
    );
  });

  it("rejects review-product comments that predate the current-head checks", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.author === "oscharko"
        ? comment
        : { ...comment, updatedAt: "2026-07-11T08:58:00.000Z" },
    );
    expect(evaluate({ comments }).failures).toEqual(
      expect.arrayContaining([
        "Current Gitar finding evidence is missing or unparseable.",
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
    expect(evaluateBankingQualityGate(input).failures).toEqual(
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
      {
        author: "gitar-bot",
        appId: 827041,
        authorAssociation: "NONE",
        authorId: 159877585,
        authorType: "Bot",
        body: "0 resolved / 9 findings",
        updatedAt: "2026-07-11T08:00:00.000Z",
      },
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
      comment.authorId === 159877585
        ? { ...comment, authorId: 1, authorType: "User" }
        : comment.authorId === 95510084
          ? { ...comment, appId: 1 }
          : comment,
    );
    expect(evaluate({ comments }).failures).toEqual(
      expect.arrayContaining([
        "Current Gitar finding evidence is missing or unparseable.",
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
