import { describe, expect, it } from "vitest";

import {
  evaluateRequest,
  releaseTriggeringWorkflows,
  requestPublishForHead,
} from "../lib/release-publish-request-event.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const TAG = "v1.0.1";
const PRERELEASE_TAG = "v1.0.1-beta.1";

function greenRunsForEveryRequiredWorkflow() {
  const runs = {};
  for (const name of releaseTriggeringWorkflows()) {
    runs[name] = {
      status: "completed",
      conclusion: "success",
      runId: 1,
      updatedAt: "2026-09-15T00:00:00Z",
    };
  }
  return runs;
}

describe("releaseTriggeringWorkflows", () => {
  it("returns the four release-authorising workflows in the pinned order", () => {
    expect([...releaseTriggeringWorkflows()]).toStrictEqual([
      "CI",
      "CodeQL",
      "Workflow hygiene",
      "Portable assets",
    ]);
  });
});

describe("evaluateRequest", () => {
  it("dispatches when every required workflow is green on a stable v* tag", () => {
    const verdict = evaluateRequest({
      headSha: HEAD,
      tagAtSha: TAG,
      workflowRunsForSha: greenRunsForEveryRequiredWorkflow(),
    });
    expect(verdict.decision).toBe("dispatch");
    expect(verdict.reason).toContain(TAG);
    expect(verdict.reason).toContain(HEAD);
  });

  it("refuses a head sha that is not a 40-hex commit id", () => {
    expect(
      evaluateRequest({ headSha: "not-a-sha", tagAtSha: TAG, workflowRunsForSha: {} }).decision,
    ).toBe("refused");
    expect(evaluateRequest({ headSha: "", tagAtSha: TAG, workflowRunsForSha: {} }).decision).toBe(
      "refused",
    );
  });

  it("refuses a head that carries no v* tag", () => {
    const verdict = evaluateRequest({
      headSha: HEAD,
      tagAtSha: undefined,
      workflowRunsForSha: greenRunsForEveryRequiredWorkflow(),
    });
    expect(verdict.decision).toBe("refused");
    expect(verdict.reason).toContain("no v* tag");
  });

  it("refuses a prerelease tag (v1.0.1-beta.1)", () => {
    const verdict = evaluateRequest({
      headSha: HEAD,
      tagAtSha: PRERELEASE_TAG,
      workflowRunsForSha: greenRunsForEveryRequiredWorkflow(),
    });
    expect(verdict.decision).toBe("refused");
    expect(verdict.reason).toContain("not a stable release tag");
  });

  it("reports not_ready when a required workflow is still in progress", () => {
    const runs = greenRunsForEveryRequiredWorkflow();
    runs.CodeQL = {
      status: "in_progress",
      conclusion: null,
      runId: 1,
      updatedAt: "2026-09-15T00:00:00Z",
    };
    const verdict = evaluateRequest({ headSha: HEAD, tagAtSha: TAG, workflowRunsForSha: runs });
    expect(verdict.decision).toBe("not_ready");
    expect(verdict.reason).toContain("in progress: CodeQL");
    expect(verdict.missing).toContain("CodeQL");
  });

  it("reports not_ready when a required workflow concluded failure", () => {
    const runs = greenRunsForEveryRequiredWorkflow();
    runs["Portable assets"] = {
      status: "completed",
      conclusion: "failure",
      runId: 1,
      updatedAt: "2026-09-15T00:00:00Z",
    };
    const verdict = evaluateRequest({ headSha: HEAD, tagAtSha: TAG, workflowRunsForSha: runs });
    expect(verdict.decision).toBe("not_ready");
    expect(verdict.reason).toContain("non-success: Portable assets");
  });

  it("reports not_ready when a required workflow is missing from the head sha", () => {
    const runs = greenRunsForEveryRequiredWorkflow();
    delete runs.CI;
    const verdict = evaluateRequest({ headSha: HEAD, tagAtSha: TAG, workflowRunsForSha: runs });
    expect(verdict.decision).toBe("not_ready");
    expect(verdict.reason).toContain("missing or non-success: CI");
  });
});

describe("requestPublishForHead", () => {
  function seams({ tagAtSha, runsByWorkflow, dispatchImpl } = {}) {
    const dispatched = [];
    return {
      dispatched,
      listLatestRunForWorkflow: async (name) => runsByWorkflow?.[name],
      readTagAtSha: () => tagAtSha,
      dispatchRelease: async (tag) => {
        dispatched.push(tag);
        if (dispatchImpl !== undefined) await dispatchImpl(tag);
      },
    };
  }

  it("dispatches release.yml in enforce mode when the decision is dispatch", async () => {
    const s = seams({ tagAtSha: TAG, runsByWorkflow: greenRunsForEveryRequiredWorkflow() });
    const verdict = await requestPublishForHead({
      headSha: HEAD,
      mode: "enforce",
      listLatestRunForWorkflow: s.listLatestRunForWorkflow,
      readTagAtSha: s.readTagAtSha,
      dispatchRelease: s.dispatchRelease,
    });
    expect(verdict.decision).toBe("dispatch");
    expect(verdict.dispatched).toBe(true);
    expect(s.dispatched).toStrictEqual([TAG]);
  });

  it("never dispatches in dry-run mode, even when the decision would be dispatch", async () => {
    const s = seams({ tagAtSha: TAG, runsByWorkflow: greenRunsForEveryRequiredWorkflow() });
    const verdict = await requestPublishForHead({
      headSha: HEAD,
      mode: "dry-run",
      listLatestRunForWorkflow: s.listLatestRunForWorkflow,
      readTagAtSha: s.readTagAtSha,
      dispatchRelease: s.dispatchRelease,
    });
    expect(verdict.decision).toBe("dispatch");
    expect(verdict.dispatched).toBe(false);
    expect(s.dispatched).toStrictEqual([]);
  });

  it("never dispatches when the head has no v* tag, even in enforce mode", async () => {
    const s = seams({ tagAtSha: undefined, runsByWorkflow: greenRunsForEveryRequiredWorkflow() });
    const verdict = await requestPublishForHead({
      headSha: OTHER,
      mode: "enforce",
      listLatestRunForWorkflow: s.listLatestRunForWorkflow,
      readTagAtSha: s.readTagAtSha,
      dispatchRelease: s.dispatchRelease,
    });
    expect(verdict.decision).toBe("refused");
    expect(verdict.dispatched).toBe(false);
    expect(s.dispatched).toStrictEqual([]);
  });

  it("never dispatches when one required workflow is not yet green", async () => {
    const runs = greenRunsForEveryRequiredWorkflow();
    runs["Workflow hygiene"] = undefined;
    const s = seams({ tagAtSha: TAG, runsByWorkflow: runs });
    const verdict = await requestPublishForHead({
      headSha: HEAD,
      mode: "enforce",
      listLatestRunForWorkflow: s.listLatestRunForWorkflow,
      readTagAtSha: s.readTagAtSha,
      dispatchRelease: s.dispatchRelease,
    });
    expect(verdict.decision).toBe("not_ready");
    expect(verdict.dispatched).toBe(false);
    expect(s.dispatched).toStrictEqual([]);
  });
});
