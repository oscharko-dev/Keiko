import { describe, expect, it } from "vitest";

import {
  evaluateBankingEvidence,
  normalizeComments,
  triggeringPullRequest,
} from "../check-banking-quality-gate.mjs";

const headSha = "a".repeat(40);
const requiredChecks = [
  { appId: 15368, name: "ci" },
  { appId: 827041, name: "Gitar" },
];

function check(name, appId, conclusion = "success") {
  return {
    appId,
    completedAt: "2026-07-11T16:00:00.000Z",
    conclusion,
    headSha,
    name,
    startedAt: "2026-07-11T15:59:00.000Z",
    status: "completed",
  };
}

describe("Banking Quality Gate", () => {
  it("passes only complete app-bound checks after Gitar stabilization", () => {
    expect(
      evaluateBankingEvidence({
        checks: [check("ci", 15368), check("Gitar", 827041)],
        gitarAppId: 827041,
        gitarGraceMs: 60_000,
        headSha,
        now: Date.parse("2026-07-11T16:02:00.000Z"),
        requiredChecks,
        reviews: [],
      }),
    ).toEqual({ failures: [], pending: [] });
  });

  it("keeps missing, pending, and stale evidence fail-closed", () => {
    const result = evaluateBankingEvidence({
      checks: [
        { ...check("ci", 15368), headSha: "b".repeat(40) },
        { ...check("Gitar", 827041), status: "in_progress", conclusion: null },
      ],
      gitarAppId: 827041,
      gitarGraceMs: 60_000,
      headSha,
      now: Date.parse("2026-07-11T16:02:00.000Z"),
      requiredChecks,
      reviews: [],
    });
    expect(result.pending).toEqual(expect.arrayContaining(["ci (missing)", "Gitar (in_progress)"]));
  });

  it("turns a current-head Gitar blocking review into a failed technical gate", () => {
    const result = evaluateBankingEvidence({
      checks: [check("ci", 15368), check("Gitar", 827041)],
      gitarAppId: 827041,
      gitarGraceMs: 60_000,
      headSha,
      now: Date.parse("2026-07-11T16:02:00.000Z"),
      requiredChecks,
      reviews: [{ appId: 827041, commitSha: headSha, state: "CHANGES_REQUESTED" }],
    });
    expect(result.failures).toEqual(["Gitar has unresolved findings on the current head commit."]);
  });

  it("still fails when a blocking review was dismissed but the dashboard has findings", () => {
    const result = evaluateBankingEvidence({
      checks: [check("ci", 15368), check("Gitar", 827041)],
      comments: [
        {
          appId: 827041,
          findingCount: 2,
          updatedAt: "2026-07-11T16:00:30.000Z",
        },
      ],
      gitarAppId: 827041,
      gitarGraceMs: 60_000,
      headSha,
      now: Date.parse("2026-07-11T16:02:00.000Z"),
      requiredChecks,
      reviews: [{ appId: 827041, commitSha: headSha, state: "DISMISSED" }],
    });
    expect(result.failures).toEqual(["Gitar has unresolved findings on the current head commit."]);
  });

  it("rejects a green context emitted by the wrong GitHub App", () => {
    const result = evaluateBankingEvidence({
      checks: [check("ci", 999), check("Gitar", 827041)],
      gitarAppId: 827041,
      gitarGraceMs: 60_000,
      headSha,
      now: Date.parse("2026-07-11T16:02:00.000Z"),
      requiredChecks,
      reviews: [],
    });
    expect(result.pending).toContain("ci (missing)");
  });

  it("recognizes singular and plural Gitar dashboard findings", () => {
    const comments = normalizeComments([
      {
        body: "1 finding",
        updated_at: "2026-07-11T16:00:00.000Z",
        user: { login: "gitar-bot[bot]" },
      },
      {
        body: "2 findings",
        updated_at: "2026-07-11T16:01:00.000Z",
        user: { login: "gitar-bot[bot]" },
      },
    ]);
    expect(comments.map((comment) => comment.findingCount)).toEqual([2, 1]);
  });

  it("fails when Socket reports alerts despite a green processing check", () => {
    const result = evaluateBankingEvidence({
      checks: [
        check("ci", 15368),
        check("Gitar", 827041),
        check("Socket Security: Pull Request Alerts", 156372),
      ],
      comments: [{ alertCount: 2, appId: 156372, updatedAt: "2026-07-11T16:00:30.000Z" }],
      gitarAppId: 827041,
      gitarGraceMs: 60_000,
      headSha,
      now: Date.parse("2026-07-11T16:02:00.000Z"),
      requiredChecks,
      reviews: [],
      socketAppId: 156372,
    });
    expect(result.failures).toContain("Socket reports 2 unresolved dependency alert(s).");
  });

  it("extracts blocking Socket Warn and Error rows", () => {
    const comments = normalizeComments([
      {
        body: '<td valign="top">Warn</td><td>Error text</td>',
        updated_at: "2026-07-11T16:00:00.000Z",
        user: { login: "socket-security[bot]" },
      },
      {
        body: '<td valign="top">Error</td>',
        updated_at: "2026-07-11T16:01:00.000Z",
        user: { login: "socket-security[bot]" },
      },
    ]);
    expect(comments.map((comment) => comment.alertCount)).toEqual([1, 1]);
  });

  it("accepts only an exact-head CI workflow run for a dev pull request", async () => {
    const event = {
      workflow_run: {
        event: "pull_request",
        head_sha: headSha,
        pull_requests: [{ base: { ref: "dev" }, head: { sha: headSha }, number: 2316 }],
      },
    };
    await expect(triggeringPullRequest(event)).resolves.toMatchObject({ number: 2316 });
    await expect(
      triggeringPullRequest({
        workflow_run: {
          ...event.workflow_run,
          pull_requests: [{ base: { ref: "main" }, head: { sha: headSha }, number: 2316 }],
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      triggeringPullRequest({
        workflow_run: { ...event.workflow_run, head_sha: "b".repeat(40) },
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves fork pull requests from the commit API fallback", async () => {
    const forkPullRequest = { base: { ref: "dev" }, head: { sha: headSha }, number: 2317 };
    const result = await triggeringPullRequest(
      {
        workflow_run: { event: "pull_request", head_sha: headSha, pull_requests: [] },
      },
      async () => [forkPullRequest],
    );
    expect(result).toEqual(forkPullRequest);
  });
});
