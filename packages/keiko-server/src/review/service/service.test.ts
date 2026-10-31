// The review run service through its production entry point, `POST /api/git-review/runs`
// (Issue #4136, AC1, AC2, AC4, AC5): the real target resolver, hardened review worktree, diff
// package and run store, with a scripted Reviewer (its candidates pass the real finding intake) and
// scripted counter-checks.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";
import type {
  ReviewRunSettlement,
  ReviewRunView,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { RouteResult } from "../../routes.js";
import { git } from "../reviewFixtures.test-support.js";
import {
  handleReviewRunCancel,
  handleReviewRunDiff,
  handleReviewRunGet,
  handleReviewRunHistory,
  handleReviewRunStart,
  handleReviewStates,
} from "../routes.js";
import {
  capability,
  counterCheckBy,
  createReviewRunHarness,
  delegatingServices,
  pullRequestServices,
  reportAt,
  reviewerFiling,
  reviewerUntilCancelled,
  startBody,
  type HarnessOptions,
  type ReviewRunHarness,
  type RuntimeScript,
} from "./reviewRunHarness.test-support.js";
import type { CounterCheckOutcome } from "../counter-check/counterCheck.js";
import { createReviewRuntimeService, type ReviewRuntimeService } from "../runtime/instance.js";
import {
  fakeReviewComposition,
  newReviewRuntimeObservations,
  reviewLayers,
  type ScriptedReviewRun,
} from "../runtime/reviewRuntimeFakes.test-support.js";
import { createReviewRunService } from "./service.js";
import { ReviewRunStore } from "./store.js";

let harness: ReviewRunHarness | undefined;

/**
 * Reviewers on one real review runtime service and run driver, over scripted instances: one
 * script per composed instance, in composition order (the last repeats).
 */
function reviewerOnRuntime(...scripts: readonly ScriptedReviewRun[]): RuntimeScript {
  let runtime: ReviewRuntimeService | undefined;
  let composed = 0;
  return (request, h) => {
    runtime ??= createReviewRuntimeService({
      compose: (instanceId, port) => {
        const script = scripts[Math.min(composed, scripts.length - 1)] ?? { reports: [] };
        composed += 1;
        return fakeReviewComposition(instanceId, port, script, newReviewRuntimeObservations());
      },
      layersFor: () => reviewLayers(),
      runner: () => createGitReviewProcessRunner(),
      activityLog: h.log.sink,
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    return runtime.run(request);
  };
}

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function setUp(options: HarnessOptions = {}): ReviewRunHarness {
  harness = createReviewRunHarness(options);
  return harness;
}

async function start(h: ReviewRunHarness, body = startBody()): Promise<RouteResult> {
  const query = `?root=${encodeURIComponent(h.repo)}`;
  return handleReviewRunStart(h.ctx(`/api/git-review/runs${query}`, { body }), h.deps());
}

function runOf(result: RouteResult): ReviewRunView {
  return (result.body as { readonly run: ReviewRunView }).run;
}

async function settled(h: ReviewRunHarness, result: RouteResult): Promise<ReviewRunView> {
  const runId = runOf(result).runId;
  await h.service.whenSettled(runId);
  const view = await h.service.get(runId);
  if (view === undefined) throw new TypeError("run missing");
  return view;
}

async function settlementOf(
  options: HarnessOptions,
  body = startBody(),
): Promise<ReviewRunSettlement | null> {
  const h = setUp(options);
  const result = await start(h, body);
  expect(result.status).toBe(202);
  return (await settled(h, result)).settlement;
}

function noWorktreeLeft(h: ReviewRunHarness, runId: string): void {
  const request = h.runtimeRequests.find((entry) => entry.reviewRunId === runId);
  if (request !== undefined) expect(existsSync(request.worktreeRoot)).toBe(false);
  expect(git(h.repo, "worktree", "list", "--porcelain")).not.toContain("review-root");
}

describe("review run service: complete runs and presentation (AC2)", () => {
  it("presents at most three confirmed findings and stores the others", async () => {
    const h = setUp({
      runtime: reviewerFiling([
        reportAt(3, "high"),
        reportAt(7, "low"),
        reportAt(10, "high"),
        reportAt(4, "medium"),
        reportAt(2, "medium"),
      ]),
      counterCheck: counterCheckBy({
        3: "confirmed",
        7: "confirmed",
        10: "confirmed",
        4: "confirmed",
        2: "refuted",
      }),
    });
    const view = await settled(h, await start(h));
    expect(view.settlement).toEqual({ kind: "complete" });
    expect(view.presentedFindings.map((finding) => finding.report.startLine)).toEqual([3, 10, 4]);
    expect(view.presentedFindings.map((finding) => finding.presentationRank)).toEqual([1, 2, 3]);
    expect(view.candidateCount).toBe(5);
    const stored = h.store.findings(view.runId);
    expect(stored).toHaveLength(5);
    expect(
      stored.filter((finding) => !finding.presented).map((finding) => finding.verdict?.verdict),
    ).toEqual(expect.arrayContaining(["confirmed", "refuted"]));
    expect(view.totals.reviewer.promptTokens).toBe(4_321);
    expect(view.totals.counterChecker.promptTokens).toBe(2_500);
    expect(view.coverageEntries.map((entry) => entry.path).sort()).toEqual([
      "src/total.ts",
      "src/util.ts",
    ]);
    noWorktreeLeft(h, view.runId);
  });

  it("counter-checks in severity order and never presents refuted or undecided findings", async () => {
    const h = setUp({
      runtime: reviewerFiling([reportAt(7, "low"), reportAt(3, "high"), reportAt(4, "medium")]),
      counterCheck: counterCheckBy({ 3: "refuted", 4: "undecided", 7: "undecided" }),
    });
    const view = await settled(h, await start(h));
    expect(h.counterInputs.map((input) => input.candidate.report.startLine)).toEqual([3, 4, 7]);
    expect(h.counterInputs.every((input) => input.modelId === "checker-model")).toBe(true);
    expect(view.presentedFindings).toEqual([]);
    expect(view.settlement).toEqual({ kind: "complete" });
  });
});

describe("review run service: every settlement of the child 1 table (AC1)", () => {
  it("skips with policy-invalid and model-unavailable", async () => {
    expect(await settlementOf({ capabilities: { "checker-model": undefined } })).toEqual({
      kind: "skipped",
      reason: "policy-invalid",
    });
    await harness?.cleanup();
    expect(
      await settlementOf({
        capabilities: {
          "reviewer-model": capability("reviewer-model", { conversationReady: false }),
        },
      }),
    ).toEqual({ kind: "skipped", reason: "model-unavailable" });
  });

  it("skips with target-changed, no-reviewable-changes and worktree-failed", async () => {
    const missing = startBody({
      target: { kind: "local-range", baseRef: "main", headRef: "gone" },
    });
    expect(await settlementOf({}, missing)).toEqual({ kind: "skipped", reason: "target-changed" });
    await harness?.cleanup();
    const same = startBody({ target: { kind: "local-range", baseRef: "topic", headRef: "topic" } });
    expect(await settlementOf({}, same)).toEqual({
      kind: "skipped",
      reason: "no-reviewable-changes",
    });
    await harness?.cleanup();
    expect(await settlementOf({ services: { maxPaths: 1 } })).toEqual({
      kind: "skipped",
      reason: "worktree-failed",
    });
  });

  it("skips with diff-too-large, rules-file-invalid and model-unavailable from the runtime", async () => {
    expect(await settlementOf({ services: { diffPackageLimits: { maxChangedFiles: 1 } } })).toEqual(
      {
        kind: "skipped",
        reason: "diff-too-large",
      },
    );
    await harness?.cleanup();
    const refusing = (
      reason: "rules-file-invalid" | "task-too-large" | "runtime-unavailable",
    ): HarnessOptions => ({ runtime: () => Promise.resolve({ ok: false as const, reason }) });
    expect(await settlementOf(refusing("rules-file-invalid"))).toEqual({
      kind: "skipped",
      reason: "rules-file-invalid",
    });
    await harness?.cleanup();
    expect(await settlementOf(refusing("task-too-large"))).toEqual({
      kind: "skipped",
      reason: "diff-too-large",
    });
    await harness?.cleanup();
    expect(await settlementOf(refusing("runtime-unavailable"))).toEqual({
      kind: "skipped",
      reason: "model-unavailable",
    });
  });

  it("settles incomplete with files-unprocessed, model-failed, budget-exhausted and deadline-exceeded", async () => {
    expect(
      await settlementOf({ services: { diffPackageLimits: { fileMaxChangedLines: 5 } } }),
    ).toEqual({ kind: "incomplete", reason: "files-unprocessed" });
    await harness?.cleanup();
    expect(
      await settlementOf({
        runtime: reviewerFiling([reportAt(3, "high")], "failed", "model-turn-failed"),
      }),
    ).toEqual({ kind: "incomplete", reason: "model-failed" });
    await harness?.cleanup();
    expect(
      await settlementOf({
        runtime: reviewerFiling([reportAt(3, "high")]),
        counterCheck: counterCheckBy({ 3: "undecided" }, "budget-exhausted"),
      }),
    ).toEqual({ kind: "incomplete", reason: "budget-exhausted" });
    await harness?.cleanup();
    expect(
      await settlementOf({
        runtime: reviewerFiling([reportAt(3, "high")], "failed", "envelope-duration-exhausted"),
      }),
    ).toEqual({ kind: "incomplete", reason: "deadline-exceeded" });
  });

  it("still presents findings confirmed before an incomplete settlement", async () => {
    const h = setUp({
      runtime: reviewerFiling([reportAt(3, "high")], "failed", "prompt-allowance-exhausted"),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });
    const view = await settled(h, await start(h));
    expect(view.settlement).toEqual({ kind: "incomplete", reason: "budget-exhausted" });
    expect(view.presentedFindings).toHaveLength(1);
  });

  // #4136, first live run on macOS (issue comment 6536975223): both models finished, the Reviewer's
  // finding was confirmed, and the review still settled incomplete/model-failed because the
  // gateway profile's runtime end could not be proven (ADR-0140 D3) and the run settled
  // recovery-required. The Reviewer runs on the real review runtime service and run driver here.
  it("settles on coverage and findings when only the Reviewer runtime's reap is unproven", async () => {
    const h = setUp({
      runtime: reviewerOnRuntime({
        reports: [reportAt(3, "high")],
        terminal: "recovery-required",
        reapUnproven: true,
      }),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });

    const view = await settled(h, await start(h));

    expect(view.settlement).toEqual({ kind: "complete" });
    expect(view.runtimeCleanup).toBe("unproven");
    expect(view.presentedFindings).toHaveLength(1);
    const [line] = h.log.withOp("review.run.settled");
    expect(line?.level).toBe("warn");
    expect(line?.extra).toMatchObject({ settlement: "complete", runtimeCleanup: "unproven" });
  });

  it("keeps any other recovery of the Reviewer run incomplete/model-failed", async () => {
    const h = setUp({
      runtime: reviewerOnRuntime({
        reports: [reportAt(3, "high")],
        terminal: "recovery-required",
        reapUnproven: false,
      }),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });

    const view = await settled(h, await start(h));

    expect(view.settlement).toEqual({ kind: "incomplete", reason: "model-failed" });
    expect(view.runtimeCleanup).toBe("unproven");
    expect(h.log.withOp("review.run.settled")[0]?.extra).toMatchObject({
      reason: "model-failed",
      runtimeCleanup: "unproven",
    });
  });

  // #4136: the instance whose Reviewer run is left recovery-required stays quarantined, and the
  // next review of the same repository runs on a fresh instance instead of being skipped.
  it("settles the next review of the repository normally after an unproven reap", async () => {
    const h = setUp({
      runtime: reviewerOnRuntime(
        { reports: [reportAt(3, "high")], terminal: "recovery-required", reapUnproven: true },
        { reports: [reportAt(3, "high")] },
      ),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });

    const first = await settled(h, await start(h));
    const second = await settled(
      h,
      await start(h, startBody({ clientRequestId: "client-request-2" })),
    );

    expect(first).toMatchObject({ settlement: { kind: "complete" }, runtimeCleanup: "unproven" });
    expect(second).toMatchObject({ settlement: { kind: "complete" }, runtimeCleanup: "proven" });
    expect(second.presentedFindings).toHaveLength(1);
    const started = h.log.withOp("review.run.runtime-started");
    expect(started.map((event) => event.extra?.placement)).toEqual([
      undefined,
      "beside-quarantined",
    ]);
  });

  it("records a proven runtime cleanup at info for a clean review", async () => {
    const h = setUp({ runtime: reviewerOnRuntime({ reports: [] }) });

    const view = await settled(h, await start(h));

    expect(view.settlement).toEqual({ kind: "complete" });
    expect(view.runtimeCleanup).toBe("proven");
    const [line] = h.log.withOp("review.run.settled");
    expect(line?.level).toBe("info");
    expect(line?.extra).toMatchObject({ runtimeCleanup: "proven" });
  });

  it("abandons with interrupted on shutdown and at the next start after a restart", async () => {
    const h = setUp({ runtime: reviewerUntilCancelled });
    const first = runOf(await start(h));
    // A second server process over the same database: the first process never settled the run.
    const restarted = createReviewRunService({
      store: new ReviewRunStore(h.db),
      reviewServices: h.services,
      reviewRuntime: undefined,
      counterCheck: counterCheckBy({}),
      models: { capability: (id) => capability(id) },
      activityLog: h.log.sink,
    });
    expect(h.store.get(first.runId)?.settlement).toEqual({
      kind: "abandoned",
      reason: "interrupted",
    });
    await restarted.dispose();
    const second = runOf(await start(h, startBody({ clientRequestId: "client-request-2" })));
    await h.service.dispose();
    expect((await h.service.get(second.runId))?.settlement).toEqual({
      kind: "abandoned",
      reason: "interrupted",
    });
    noWorktreeLeft(h, second.runId);
  });
});

describe("review run service: concurrency, idempotency and cancellation (AC4)", () => {
  it("refuses a second active review with 409 and replays a request id", async () => {
    const h = setUp({ runtime: reviewerUntilCancelled });
    const first = await start(h);
    expect(first.status).toBe(202);
    const replay = await start(h);
    expect(replay.status).toBe(200);
    expect(runOf(replay).runId).toBe(runOf(first).runId);
    const second = await start(h, startBody({ clientRequestId: "client-request-2" }));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      activeRunId: runOf(first).runId,
      error: { code: "REVIEW_ACTIVE" },
    });
    expect(h.log.events.find((event) => event.op === "review.run.refused")).toMatchObject({
      extra: { reason: "active-review-exists" },
    });
    const cancel = handleReviewRunCancel(
      h.ctx(`/api/git-review/runs/${runOf(first).runId}/cancel`, {
        params: { runId: runOf(first).runId },
      }),
      h.deps(),
    );
    expect(cancel.status).toBe(202);
    await h.service.whenSettled(runOf(first).runId);
  });

  it.each(["preparing", "reviewing", "counter-checking", "settling"] as const)(
    "settles abandoned/cancelled after a cancellation while %s, leaving no worktree or stream",
    async (phase) => {
      let reached: () => void = () => undefined;
      const inPhase = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pause = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const options: HarnessOptions = {
        runtime:
          phase === "reviewing"
            ? (request, h): ReturnType<RuntimeScript> => {
                reached();
                return reviewerUntilCancelled(request, h);
              }
            : reviewerFiling([reportAt(3, "high")]),
        counterCheck:
          phase === "counter-checking"
            ? (input): Promise<CounterCheckOutcome> => {
                reached();
                return new Promise((resolve) => {
                  input.signal.addEventListener("abort", () => {
                    void counterCheckBy({ 3: "undecided" }, "cancelled")(input).then(resolve);
                  });
                });
              }
            : counterCheckBy({ 3: "confirmed" }),
        wrapServices: (services) => {
          if (phase === "preparing") {
            return delegatingServices(services, {
              resolveTarget: async (input) => {
                reached();
                await pause(50);
                return services.resolveTarget(input);
              },
            });
          }
          return phase === "settling"
            ? pullRequestServices(services, 5, async () => {
                reached();
                await pause(100);
                return undefined;
              })
            : services;
        },
      };
      const h = setUp(options);
      const target = phase === "settling" ? { kind: "pull-request", number: 5 } : undefined;
      const started = await start(h, target === undefined ? startBody() : startBody({ target }));
      expect(started.status).toBe(202);
      await inPhase;
      expect(h.service.cancel(runOf(started).runId)).toBe("cancelling");
      const view = await settled(h, started);
      expect(view.settlement).toEqual({ kind: "abandoned", reason: "cancelled" });
      expect(view.presentedFindings).toEqual([]);
      noWorktreeLeft(h, view.runId);
      const listener = { onEvent: (): void => undefined, onClose: (): void => undefined };
      expect(h.service.subscribe(view.runId, listener)).toBeUndefined();
      expect(h.service.cancel(view.runId)).toBe("settled");
    },
  );
});

describe("review run service: stale heads and the reviewed diff (AC5)", () => {
  function pullRequestOptions(head: { value: string | undefined }): HarnessOptions {
    return {
      runtime: reviewerFiling([reportAt(3, "high")]),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
      wrapServices: (services) =>
        pullRequestServices(services, 9, () => Promise.resolve(head.value)),
    };
  }

  it("flags a moved pull request head as stale without changing the settlement", async () => {
    const head = { value: undefined as string | undefined };
    const h = setUp(pullRequestOptions(head));
    head.value = h.headSha;
    const view = await settled(
      h,
      await start(h, startBody({ target: { kind: "pull-request", number: 9 } })),
    );
    expect(view).toMatchObject({
      stale: false,
      settlement: { kind: "complete" },
      pullRequestNumber: 9,
    });
    head.value = "c".repeat(40);
    // The head cache holds for 30 seconds; a fresh service instance reads the moved head.
    const fresh = createReviewRunService({
      store: h.store,
      reviewServices: h.services,
      reviewRuntime: undefined,
      counterCheck: counterCheckBy({}),
      models: { capability: (id) => capability(id) },
      activityLog: h.log.sink,
    });
    expect(await fresh.get(view.runId)).toMatchObject({
      stale: true,
      settlement: { kind: "complete" },
    });
    const states = await fresh.reviewStates(view.repositoryId);
    expect(states).toEqual([{ pullRequestNumber: 9, state: "stale", runId: view.runId }]);
  });

  it("serves the reviewed diff after the worktree is gone and refuses it after the refs were swept", async () => {
    const h = setUp({ runtime: reviewerFiling([]) });
    const view = await settled(h, await start(h));
    noWorktreeLeft(h, view.runId);
    const diff = async (path: string, context?: string): Promise<RouteResult> =>
      handleReviewRunDiff(
        h.ctx(
          `/api/git-review/runs/${view.runId}/diff?path=${encodeURIComponent(path)}${context === undefined ? "" : `&context=${context}`}`,
          { params: { runId: view.runId } },
        ),
        h.deps(),
      );
    const served = await diff("src/total.ts", "10");
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({
      status: "available",
      headSha: h.headSha,
      contextLines: 10,
    });
    expect((served.body as { diff: string }).diff).toContain(
      "+  for (let i = 0; i <= items.length; i++)",
    );
    expect((await diff("src/util.ts")).body).toMatchObject({ status: "available" });
    expect((await diff("src/not-reviewed.ts")).body).toMatchObject({ status: "not-in-review" });
    expect((await diff("src/total.ts", "abc")).status).toBe(400);
    for (const ref of h.store.get(view.runId)?.privateRefs ?? [])
      git(h.repo, "update-ref", "-d", ref);
    expect((await diff("src/total.ts")).body).toMatchObject({ status: "objects-unavailable" });
  });
});

describe("review run service: reads, dry run and evaluation switches", () => {
  it("serves the record, history and review states", async () => {
    const h = setUp({
      runtime: reviewerFiling([reportAt(3, "high")]),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });
    const view = await settled(h, await start(h));
    const got = await handleReviewRunGet(
      h.ctx(`/api/git-review/runs/${view.runId}`, { params: { runId: view.runId } }),
      h.deps(),
    );
    expect(got.body).toMatchObject({ runId: view.runId, presentedFindings: [{ presented: true }] });
    expect(
      (
        await handleReviewRunGet(
          h.ctx("/api/git-review/runs/x", { params: { runId: "missing" } }),
          h.deps(),
        )
      ).status,
    ).toBe(404);
    const history = await handleReviewRunHistory(
      h.ctx(`/api/git-review/runs?repositoryId=${view.repositoryId}`),
      h.deps(),
    );
    expect(history.body).toMatchObject({ runs: [{ runId: view.runId }] });
    expect(
      (await handleReviewRunHistory(h.ctx("/api/git-review/runs?repositoryId=../x"), h.deps()))
        .status,
    ).toBe(400);
    const states = await handleReviewStates(
      h.ctx(`/api/git-review/review-states?repositoryId=${view.repositoryId}`),
      h.deps(),
    );
    expect(states.body).toMatchObject({ states: [] });
  });

  it("estimates a dry run without starting and refuses an ineligible model", async () => {
    const h = setUp();
    const dry = await start(h, startBody({ dryRun: true }));
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      kind: "dry-run",
      estimate: { changedLines: 13, estimatedDurationMs: null },
    });
    expect(h.runtimeRequests).toEqual([]);
    expect(h.store.unsettled()).toEqual([]);
    await harness?.cleanup();
    const refusing = setUp({ capabilities: { "reviewer-model": undefined } });
    const refused = await start(refusing, startBody({ dryRun: true }));
    expect(refused.status).toBe(422);
    expect(refusing.log.events.find((event) => event.op === "review.run.refused")).toMatchObject({
      extra: { reason: "policy-invalid", dryRun: true },
    });
  });

  it("refuses evaluation switches and malformed requests on the product route", async () => {
    const h = setUp();
    for (const body of [
      startBody({ counterCheck: "off" }),
      startBody({ swapRoles: true }),
      startBody({ reviewerModelId: "bad model" }),
      startBody({ target: { kind: "pull-request", number: 0 } }),
      { target: { kind: "local-range", baseRef: "main", headRef: "topic" } },
    ]) {
      const result = await start(h, body);
      expect(result.status).toBe(400);
    }
    expect(h.runtimeRequests).toEqual([]);
    expect(h.log.events.filter((event) => event.op === "review.run.refused")).toHaveLength(5);
  });

  it("applies the evaluation switches only through the evaluation service", async () => {
    const h = setUp({
      evaluation: { counterCheck: "off", swapRoles: true },
      runtime: reviewerFiling([reportAt(3, "high"), reportAt(4, "low")]),
    });
    const view = await settled(h, await start(h));
    expect(h.counterInputs).toEqual([]);
    expect(h.runtimeRequests[0]?.modelId).toBe("checker-model");
    expect(view.presentedFindings.map((finding) => finding.report.startLine)).toEqual([3, 4]);
    expect(h.log.events.find((event) => event.op === "review.run.started")).toMatchObject({
      extra: { counterCheckEnabled: false },
    });
  });
});

describe("review run service: fault injection", () => {
  it("settles abandoned/interrupted when the database is full at settlement", async () => {
    const h = setUp({
      runtime: reviewerFiling([reportAt(3, "high")]),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
      store: (db) => {
        const store = new ReviewRunStore(db);
        store.settle = (): void => {
          throw Object.assign(new Error("database or disk is full"), {
            code: "ERR_SQLITE_ERROR",
            errcode: 13,
          });
        };
        return store;
      },
    });
    const result = await start(h);
    await h.service.whenSettled(runOf(result).runId);
    const settledLine = h.log.events.find((event) => event.op === "review.run.settled");
    expect(settledLine).toMatchObject({
      extra: { settlement: "abandoned", reason: "interrupted", presentedCount: 0 },
    });
    noWorktreeLeft(h, runOf(result).runId);
    // The stored row stays unsettled; the next start settles it the same way.
    const restarted = createReviewRunService({
      store: new ReviewRunStore(h.db),
      reviewServices: h.services,
      reviewRuntime: undefined,
      counterCheck: counterCheckBy({}),
      models: { capability: (id) => capability(id) },
      activityLog: h.log.sink,
    });
    expect(h.store.get(runOf(result).runId)?.settlement).toEqual({
      kind: "abandoned",
      reason: "interrupted",
    });
    await restarted.dispose();
  });

  it("interrupts a run whose phase record cannot be written", async () => {
    const db = new DatabaseSync(":memory:");
    const h = setUp({
      db,
      store: (database) => {
        const store = new ReviewRunStore(database);
        store.setCoverage = (): void => {
          throw new Error("database or disk is full");
        };
        return store;
      },
    });
    const view = await settled(h, await start(h));
    expect(view.settlement).toEqual({ kind: "abandoned", reason: "interrupted" });
    db.close();
  });
});
