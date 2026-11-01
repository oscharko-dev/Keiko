// The review runtime service's lifecycle (ADR-0182 D1, Issue #4135): on-demand start, one review
// at a time per repository, idle stop, the rules and self-check refusals, and the run-bound intake
// behind `keiko_review_report`. The composition is a hermetic stand-in that drives the same ports
// the production composition exposes; the composition itself is proven in composition.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";

import { createBufferedServerLogSink } from "../../../../../tests/support/buffered-server-log.js";
import type { GovernedCodingToolPort } from "../../coding-runtime/codingToolGovernedDelegate.js";
import { DiffFixtureRepository } from "../diff-package/diffFixtures.test-support.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import {
  createReviewRuntimeService,
  type ReviewRuntimeRunRequest,
  type ReviewRuntimeService,
} from "./instance.js";
import {
  fakeReviewComposition,
  newReviewRuntimeObservations,
  reviewLayers,
  type ReviewRuntimeObservations,
  type ScriptedReviewRun,
} from "./reviewRuntimeFakes.test-support.js";
import type { ReviewRuntimeLayers } from "./selfCheck.js";

const RULES_PATH = ".keiko/review-rules.md";
const SOURCE = "export function first(values: number[]): number {\n  return values[0];\n}\n";

const fixtures: DiffFixtureRepository[] = [];
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

function headRepository(rules?: string | Buffer): {
  readonly repo: DiffFixtureRepository;
  readonly base: string;
  readonly head: string;
} {
  const repo = new DiffFixtureRepository("keiko-review-instance-");
  fixtures.push(repo);
  const base = repo.commit([
    { path: "src/first.ts", content: "export {};\n" },
    ...(rules === undefined ? [] : [{ path: RULES_PATH, content: rules }]),
  ]);
  const head = repo.commit([{ path: "src/first.ts", content: SOURCE }], base);
  return { repo, base, head };
}

function request(
  repo: DiffFixtureRepository,
  base: string,
  head: string,
  overrides: Partial<ReviewRuntimeRunRequest> = {},
): ReviewRuntimeRunRequest {
  return {
    reviewRunId: "review-run-1",
    repositoryRoot: repo.repo,
    worktreeRoot: repo.repo,
    baseSha: base,
    headSha: head,
    modelId: "gemma-4-31b-it",
    diffPackageText: "## File: 'src/first.ts'\n__new hunk__\n2 +  return values[0];\n",
    ...overrides,
  };
}

const VALID_REPORT = {
  file: "src/first.ts",
  startLine: 2,
  endLine: 2,
  title: "Unchecked first element",
  condition: "An empty array is passed.",
  mechanism: "Element zero is read without a length check.",
  consequence: "undefined is returned as a number.",
  remedy: "Check the length first.",
  category: "correctness",
  severity: "medium",
  evidence: [{ file: "src/first.ts", startLine: 2, endLine: 2, role: "defect" }],
  failureMode: { trigger: "first([])", detection: "nothing", coveredByChange: false },
};

interface ServiceFixture {
  readonly subject: ReturnType<typeof createReviewRuntimeService>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly observed: ReviewRuntimeObservations;
  readonly timers: (() => void)[];
  readonly compose: ReturnType<typeof vi.fn>;
}

/** One script for every composed instance, or one per instance in composition order. */
function service(
  script: ScriptedReviewRun | readonly ScriptedReviewRun[],
  options: { readonly layers?: ReviewRuntimeLayers; readonly compose?: boolean } = {},
): ServiceFixture {
  const log = createBufferedServerLogSink();
  const observed = newReviewRuntimeObservations();
  const timers: (() => void)[] = [];
  const scripts: readonly ScriptedReviewRun[] = Array.isArray(script) ? script : [script];
  let composed = 0;
  const compose = vi.fn(
    (
      instanceId: string,
      port: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
    ): ReviewRuntimeComposition | undefined => {
      if (options.compose === false) return undefined;
      const scripted = scripts[Math.min(composed, scripts.length - 1)] ?? { reports: [] };
      composed += 1;
      return fakeReviewComposition(instanceId, port, scripted, observed);
    },
  );
  const subject = createReviewRuntimeService({
    compose,
    layersFor: () => options.layers ?? reviewLayers(),
    runner: () => createGitReviewProcessRunner(),
    activityLog: log,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { subject, log, observed, timers, compose };
}

describe("createReviewRuntimeService", () => {
  it("starts an instance on demand, runs the review and returns the accepted candidates", async () => {
    const { repo, base, head } = headRepository("Flag unchecked indexing.\n");
    const { subject, log, observed } = service({ reports: [VALID_REPORT, { nonsense: true }] });

    const result = await subject.run(request(repo, base, head));

    expect(result).toMatchObject({ ok: true, outcome: "completed", rules: "loaded" });
    if (!result.ok) throw new Error("expected a run");
    expect(result.candidates).toHaveLength(1);
    expect(result.rejections["schema-invalid"]).toBe(1);
    expect(observed.boundRoots).toEqual([repo.repo]);
    expect(observed.starts[0]).toMatchObject({
      requestedMode: "governed-assist",
      modelId: "gemma-4-31b-it",
      projectMemory: { enabled: false },
    });
    expect(JSON.stringify(observed.starts[0])).toContain("<review-data rules");
    expect(subject.instanceCount()).toBe(1);
    expect(log.events.map((event) => event.op)).toEqual(
      expect.arrayContaining([
        "review.run.runtime-started",
        "review.run.rules-file",
        "review.finding.reported",
      ]),
    );
  });

  // #4136, first live run on macOS: the Reviewer filed its finding and ended its turn, the gateway
  // profile's descendant sweep stayed unproven (no sandbox member, ADR-0140 D3), the runtime run
  // settled recovery-required, and the review counted the Reviewer as a failed model.
  it("returns a completed Reviewer whose only failure is the unproven runtime reap", async () => {
    const { repo, base, head } = headRepository();
    const { subject } = service({
      reports: [VALID_REPORT],
      terminal: "recovery-required",
      reapUnproven: true,
    });

    const result = await subject.run(request(repo, base, head));

    expect(result).toMatchObject({ ok: true, outcome: "completed", runtimeCleanup: "unproven" });
    if (!result.ok) throw new Error("expected a run");
    expect(result.failureCode).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
  });

  it("keeps every other recovery a failed Reviewer and names a proven cleanup", async () => {
    const { repo, base, head } = headRepository();
    const run = (script: ScriptedReviewRun): ReturnType<ReviewRuntimeService["run"]> =>
      service(script).subject.run(request(repo, base, head));

    await expect(
      run({ reports: [VALID_REPORT], terminal: "recovery-required", reapUnproven: false }),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "failed",
      failureCode: "recovery-required",
      runtimeCleanup: "unproven",
    });
    // #4138: a failed turn's own cause names the failure, not the recovery state.
    await expect(
      run({
        reports: [],
        terminal: "recovery-required",
        turnFailureCode: "prompt-allowance-exhausted",
      }),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "failed",
      failureCode: "prompt-allowance-exhausted",
      runtimeCleanup: "unproven",
    });
    await expect(run({ reports: [], terminal: "failed" })).resolves.toMatchObject({
      ok: true,
      outcome: "failed",
      runtimeCleanup: "proven",
    });
    await expect(run({ reports: [] })).resolves.toMatchObject({
      ok: true,
      outcome: "completed",
      runtimeCleanup: "proven",
    });
  });

  // #4136: after a Reviewer run left recovery-required, its instance's orchestrator refuses the
  // next start (`active-run-conflict`), so every later review of the repository was skipped until
  // the idle stop. The quarantined instance is set aside untouched and a fresh one serves the review.
  it("composes a fresh instance beside a quarantined one and keeps the quarantine until idle", async () => {
    const { repo, base, head } = headRepository();
    const unproven: ScriptedReviewRun = {
      reports: [],
      terminal: "recovery-required",
      reapUnproven: true,
    };
    const { subject, compose, observed, log, timers } = service([unproven, { reports: [] }]);

    await subject.run(request(repo, base, head));
    const second = await subject.run(request(repo, base, head, { reviewRunId: "review-run-2" }));

    expect(second).toMatchObject({ ok: true, outcome: "completed", runtimeCleanup: "proven" });
    expect(compose).toHaveBeenCalledTimes(2);
    expect(observed.starts).toHaveLength(2);
    expect(observed).toMatchObject({ shutdowns: 0, closes: 0 });
    expect(subject.instanceCount()).toBe(2);
    const started = log.events.filter((event) => event.op === "review.run.runtime-started");
    expect(started.map((event) => event.extra?.placement)).toEqual([
      undefined,
      "beside-quarantined",
    ]);

    // The quarantined instance ends on its own idle stop, armed when its review ended.
    expect(timers).toHaveLength(2);
    timers[0]?.();
    await vi.waitFor(() => {
      expect(subject.instanceCount()).toBe(1);
    });
    expect(observed).toMatchObject({ shutdowns: 1, closes: 1 });
    const stopped = log.events.find((event) => event.op === "review.run.runtime-stopped");
    expect(stopped?.extra).toMatchObject({ trigger: "idle", runCount: 1 });
  });

  it("refuses a review that would need a second quarantined instance", async () => {
    const { repo, base, head } = headRepository();
    const unproven: ScriptedReviewRun = {
      reports: [],
      terminal: "recovery-required",
      reapUnproven: true,
    };
    const { subject, compose, observed } = service([unproven, unproven, { reports: [] }]);

    await subject.run(request(repo, base, head));
    await subject.run(request(repo, base, head, { reviewRunId: "review-run-2" }));
    const third = await subject.run(request(repo, base, head, { reviewRunId: "review-run-3" }));

    expect(third).toEqual({ ok: false, reason: "runtime-unavailable", rules: "absent" });
    expect(compose).toHaveBeenCalledTimes(2);
    expect(observed.starts).toHaveLength(2);
    expect(observed).toMatchObject({ shutdowns: 0, closes: 0 });
    expect(subject.instanceCount()).toBe(2);
  });

  it("unbinds the review worktree after the run and reuses the instance for the next review", async () => {
    const { repo, base, head } = headRepository();
    const { subject, compose } = service({ reports: [] });

    await subject.run(request(repo, base, head));
    const second = await subject.run(request(repo, base, head, { reviewRunId: "review-run-2" }));

    expect(second).toMatchObject({ ok: true, rules: "absent", candidates: [] });
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it("serves one review at a time per repository", async () => {
    const { repo, base, head } = headRepository();
    const { subject } = service({ reports: [] });

    const [first, second] = await Promise.all([
      subject.run(request(repo, base, head)),
      subject.run(request(repo, base, head, { reviewRunId: "review-run-2" })),
    ]);

    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(first.ok ? second : first).toEqual({ ok: false, reason: "busy" });
  });

  it("stops an idle instance after the idle period", async () => {
    const { repo, base, head } = headRepository();
    const { subject, log, observed, timers } = service({ reports: [] });

    await subject.run(request(repo, base, head));
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await vi.waitFor(() => {
      expect(subject.instanceCount()).toBe(0);
    });
    expect(observed).toMatchObject({ shutdowns: 1, closes: 1 });
    const stopped = log.events.find((event) => event.op === "review.run.runtime-stopped");
    expect(stopped?.extra).toMatchObject({ trigger: "idle", runCount: 1 });
  });

  // Security review of #4135, finding 5: an idle stop that fell while a later review held the
  // repository bailed without re-arming; that review then ended before reaching the instance, so
  // the instance was never stopped.
  it("still stops the instance when its idle stop fell during a review that ended early", async () => {
    const { repo, base, head } = headRepository();
    const { subject, observed, timers } = service({ reports: [] });
    await subject.run(request(repo, base, head));
    expect(timers).toHaveLength(1);

    const tooLarge = subject.run(
      request(repo, base, head, { diffPackageText: "x".repeat(70_000) }),
    );
    timers[0]?.();
    await expect(tooLarge).resolves.toMatchObject({ ok: false, reason: "task-too-large" });
    expect(subject.instanceCount()).toBe(1);

    expect(timers).toHaveLength(2);
    timers[1]?.();
    await vi.waitFor(() => {
      expect(subject.instanceCount()).toBe(0);
    });
    expect(observed).toMatchObject({ shutdowns: 1, closes: 1 });
  });

  it("refuses an invalid rules file before any runtime is composed (AC5)", async () => {
    const { repo, base, head } = headRepository(Buffer.from([0xff, 0xfe]));
    const { subject, compose } = service({ reports: [] });

    await expect(subject.run(request(repo, base, head))).resolves.toEqual({
      ok: false,
      reason: "rules-file-invalid",
      rules: "not-utf8",
    });
    expect(compose).not.toHaveBeenCalled();
  });

  it("refuses to run when a read-only layer is missing, before the run starts (AC2)", async () => {
    const { repo, base, head } = headRepository();
    const { subject, log, observed } = service(
      { reports: [] },
      { layers: { ...reviewLayers(), toolProfile: "native" } },
    );

    await expect(subject.run(request(repo, base, head))).resolves.toEqual({
      ok: false,
      reason: "native-profile",
      rules: "absent",
    });
    expect(observed.starts).toEqual([]);
    const refused = log.events.find((event) => event.op === "review.run.profile-refused");
    expect(refused?.extra).toMatchObject({ reason: "native-profile" });
  });

  it("answers runtime-unavailable when no runtime can be composed", async () => {
    const { repo, base, head } = headRepository();
    const { subject } = service({ reports: [] }, { compose: false });

    await expect(subject.run(request(repo, base, head))).resolves.toEqual({
      ok: false,
      reason: "runtime-unavailable",
      rules: "absent",
    });
  });

  it("refuses a task larger than the first prompt can carry", async () => {
    const { repo, base, head } = headRepository();
    const { subject, compose } = service({ reports: [] });

    await expect(
      subject.run(request(repo, base, head, { diffPackageText: "x".repeat(70_000) })),
    ).resolves.toEqual({ ok: false, reason: "task-too-large", rules: "absent" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("finds the instance that owns a runtime capability and stops every instance on dispose", async () => {
    const { repo, base, head } = headRepository();
    const { subject, observed } = service({ reports: [] });
    await subject.run(request(repo, base, head));

    expect(subject.instanceForCapability("cap-unknown", "tool-facade")).toBeUndefined();
    await subject.dispose();
    expect(subject.instanceCount()).toBe(0);
    expect(observed.shutdowns).toBe(1);
  });
});
