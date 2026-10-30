// The review runtime service's lifecycle (ADR-0182 D1, Issue #4135): on-demand start, one review
// at a time per repository, idle stop, the rules and self-check refusals, and the run-bound intake
// behind `keiko_review_report`. The composition is a hermetic stand-in that drives the same ports
// the production composition exposes; the composition itself is proven in composition.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";

import { createBufferedServerLogSink } from "../../../../../tests/support/buffered-server-log.js";
import type { GovernedCodingToolPort } from "../../coding-runtime/codingToolGovernedDelegate.js";
import { DiffFixtureRepository } from "../diff-package/diffFixtures.test-support.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import { createReviewRuntimeService, type ReviewRuntimeRunRequest } from "./instance.js";
import { createReviewWorkspaceLifecycle } from "./reviewWorkspace.js";
import type { ReviewRuntimeLayers } from "./selfCheck.js";
import { reviewRuntimeAuthorityGrants } from "../../coding-runtime/runtimeAuthorityService.js";
import { createGeneratedOpenCodeV2Plugins } from "../../coding-runtime/opencodeRuntimeAdapter.js";
import { createFixedOpenCodeV2Config } from "../../coding-runtime/opencodeLaunchProfile.js";

const GEOMETRY = { contextWindowTokens: 32_768, maxInputTokens: 28_672, maxOutputTokens: 4_096 };
const RULES_PATH = ".keiko/review-rules.md";
const SOURCE = "export function first(values: number[]): number {\n  return values[0];\n}\n";

const fixtures: DiffFixtureRepository[] = [];
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup();
});

interface Scripted {
  /** What the scripted model reports during the run (each through the run's report port). */
  readonly reports: readonly unknown[];
  readonly terminal?: "succeeded" | "failed" | undefined;
}

function reviewLayers(): ReviewRuntimeLayers {
  return {
    toolProfile: "review",
    configValue: createFixedOpenCodeV2Config(GEOMETRY, undefined, "review"),
    pluginSources: createGeneratedOpenCodeV2Plugins("review"),
    authority: {
      actionClasses: reviewRuntimeAuthorityGrants().actionClasses,
      effectiveMode: "governed-assist",
      runtimePurpose: "review",
    },
    facadePurpose: "review",
  };
}

function fakeComposition(
  instanceId: string,
  reportPort: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
  script: Scripted,
  observed: { starts: unknown[]; shutdowns: number; closes: number; boundRoots: string[] },
): ReviewRuntimeComposition {
  const workspace = createReviewWorkspaceLifecycle();
  let state: "running" | "succeeded" | "failed" = "running";
  let runs = 0;
  const orchestrator = {
    start: async (body: unknown): Promise<unknown> => {
      observed.starts.push(body);
      observed.boundRoots.push(workspace.getActive()?.binding.activeRoot ?? "unbound");
      runs += 1;
      const runId = `runtime-run-${String(runs)}`;
      const port = reportPort(runId);
      for (const report of script.reports) {
        await port?.execute(
          { action: "review-report", actionId: "a", idempotencyKey: "k", report: report as never },
          undefined,
          { check: () => true },
        );
      }
      state = script.terminal ?? "succeeded";
      return { ok: true, snapshot: { runId, state: "running" } };
    },
    getSnapshot: (): { readonly state: string } => ({ state }),
    stop: (): Promise<unknown> => Promise.resolve({ ok: true }),
    shutdown: (): Promise<unknown> => {
      observed.shutdowns += 1;
      return Promise.resolve({ ok: true });
    },
  };
  const eventHub = {
    subscribe: (
      _runId: string,
      _last: string | undefined,
      subscriber: { write: (event: CodingWorkbenchRuntimeSseEvent) => unknown; close: () => void },
    ): unknown => {
      subscriber.close();
      return { ok: true, detach: () => undefined };
    },
  };
  return {
    instanceId,
    controlPlane: {
      orchestrator,
      eventHub,
      runtimeCapabilityAuthenticator: {
        authenticate: (capability: string): unknown => ({ ok: capability === `cap-${instanceId}` }),
      },
    } as never,
    readiness: { toolProfile: "review" } as never,
    workspace,
    expectStart: () => undefined,
    authorityProbe: () => undefined,
    sidecarDeps: (base) => base,
    close: (): void => {
      observed.closes += 1;
    },
  };
}

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
  readonly observed: { starts: unknown[]; shutdowns: number; closes: number; boundRoots: string[] };
  readonly timers: (() => void)[];
  readonly compose: ReturnType<typeof vi.fn>;
}

function service(
  script: Scripted,
  options: { readonly layers?: ReviewRuntimeLayers; readonly compose?: boolean } = {},
): ServiceFixture {
  const log = createBufferedServerLogSink();
  const observed = { starts: [] as unknown[], shutdowns: 0, closes: 0, boundRoots: [] as string[] };
  const timers: (() => void)[] = [];
  const compose = vi.fn(
    (
      instanceId: string,
      port: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
    ): ReviewRuntimeComposition | undefined =>
      options.compose === false ? undefined : fakeComposition(instanceId, port, script, observed),
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
