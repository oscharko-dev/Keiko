import { describe, expect, it } from "vitest";

import { evaluateBankingQualityGate, requiredChecks } from "../banking-quality-gate-core.mjs";

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
        authorAssociation: "NONE",
        body: "0 resolved / 0 findings",
        updatedAt: completedAt,
      },
      {
        author: "socket-security",
        authorAssociation: "NONE",
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
    reviews: [{ author: "gitar-bot", commitSha: headSha, state: "COMMENTED" }],
    socketRiskAllowlist: [risk],
    socketRiskActors: ["oscharko"],
  };
}

function evaluate(update = {}) {
  return evaluateBankingQualityGate({ ...passingInput(), ...update });
}

describe("Banking Quality Gate core", () => {
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
      comment.author === "gitar-bot" ? { ...comment, body: "0 resolved / 2 findings" } : comment,
    );
    const reviews = [{ author: "gitar-bot", commitSha: headSha, state: "CHANGES_REQUESTED" }];
    expect(evaluate({ comments, reviews }).failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CHANGES_REQUESTED"),
        expect.stringContaining("2 unresolved"),
      ]),
    );
  });

  it("rejects dismissed or stale Gitar evidence and changed formats", () => {
    expect(
      evaluate({
        comments: passingInput().comments.filter((comment) => comment.author !== "gitar-bot"),
        reviews: [],
      }).failures,
    ).toContain("Current Gitar finding evidence is missing or unparseable.");
  });

  it("derives unresolved Gitar findings from resolved and total counts", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.author === "gitar-bot" ? { ...comment, body: "2 resolved / 2 findings" } : comment,
    );
    expect(evaluate({ comments }).passed).toBe(true);

    const invalid = comments.map((comment) =>
      comment.author === "gitar-bot" ? { ...comment, body: "3 resolved / 2 findings" } : comment,
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
        comment.author === "socket-security" ? { ...comment, body: "No alerts" } : comment,
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
        authorAssociation: "NONE",
        body: "0 resolved / 9 findings",
        updatedAt: "2026-07-11T08:00:00.000Z",
      },
      ...input.comments,
    ];
    expect(evaluate({ checks: [...olderChecks, ...input.checks], comments }).passed).toBe(true);
  });

  it("parses direct and scoped Socket package identifiers exactly", () => {
    const comments = passingInput().comments.map((comment) =>
      comment.author === "socket-security"
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
      comment.author === "socket-security"
        ? { ...comment, body: `${comment.body} Error` }
        : comment,
    );
    expect(evaluate({ comments }).failures).toContain("Socket reports an error alert.");
  });

  it("invalidates old evidence after a new commit", () => {
    expect(evaluate({ headSha: "c".repeat(40) }).passed).toBe(false);
  });

  it("waits for a bounded review-product stability window", () => {
    expect(evaluate({ now: Date.parse("2026-07-11T10:00:30.000Z") }).failures).toContain(
      "Review-product evidence is inside the stability window.",
    );
  });
});
