// A hermetic stand-in for one composed review runtime instance (ADR-0182 D1, Issues #4135/#4136).
// It drives the same ports the production composition exposes: the run-bound report port, the
// orchestrator's start, snapshot and settlement facts, and the event hub. The production
// composition itself is proven in composition.test.ts.

import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";

import { reviewRuntimeAuthorityGrants } from "../../coding-runtime/runtimeAuthorityService.js";
import type { GovernedCodingToolPort } from "../../coding-runtime/codingToolGovernedDelegate.js";
import { createGeneratedOpenCodeV2Plugins } from "../../coding-runtime/opencodeRuntimeAdapter.js";
import { createFixedOpenCodeV2Config } from "../../coding-runtime/opencodeLaunchProfile.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import { createReviewWorkspaceLifecycle } from "./reviewWorkspace.js";
import type { ReviewRuntimeLayers } from "./selfCheck.js";

const GEOMETRY = { contextWindowTokens: 32_768, maxInputTokens: 28_672, maxOutputTokens: 4_096 };

/** What the scripted Reviewer run does on the fake instance. */
export interface ScriptedReviewRun {
  /** What the scripted model reports during the run (each through the run's report port). */
  readonly reports: readonly unknown[];
  /** The state the run settles in; `succeeded` by default. */
  readonly terminal?: "succeeded" | "failed" | "recovery-required" | undefined;
  /**
   * For `recovery-required`: the orchestrator's fact that the turn settled `succeeded` and only the
   * settlement stop's process-tree reap was unproven (a macOS gateway-profile run, #4136).
   */
  readonly reapUnproven?: boolean | undefined;
}

export interface ReviewRuntimeObservations {
  starts: unknown[];
  shutdowns: number;
  closes: number;
  boundRoots: string[];
}

export function newReviewRuntimeObservations(): ReviewRuntimeObservations {
  return { starts: [], shutdowns: 0, closes: 0, boundRoots: [] };
}

/** The four read-only layers of a correctly composed review instance. */
export function reviewLayers(): ReviewRuntimeLayers {
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

async function fileReports(
  port: GovernedCodingToolPort<"review-report"> | undefined,
  reports: readonly unknown[],
): Promise<void> {
  for (const report of reports) {
    await port?.execute(
      { action: "review-report", actionId: "a", idempotencyKey: "k", report: report as never },
      undefined,
      { check: () => true },
    );
  }
}

/** The settled snapshot the orchestrator serves, as the coding runtime shapes it. */
function settledSnapshot(state: string): { readonly state: string; readonly failureCode?: string } {
  return state === "recovery-required" ? { state, failureCode: "recovery-required" } : { state };
}

function scriptedOrchestrator(
  reportPort: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
  script: ScriptedReviewRun,
  observed: ReviewRuntimeObservations,
  boundRoot: () => string,
): unknown {
  let state = "running";
  let runs = 0;
  return {
    start: async (body: unknown): Promise<unknown> => {
      observed.starts.push(body);
      observed.boundRoots.push(boundRoot());
      runs += 1;
      const runId = `runtime-run-${String(runs)}`;
      await fileReports(reportPort(runId), script.reports);
      state = script.terminal ?? "succeeded";
      return { ok: true, snapshot: { runId, state: "running" } };
    },
    getSnapshot: () => settledSnapshot(state),
    succeededTurnReapUnproven: (): boolean =>
      state === "recovery-required" && script.reapUnproven === true,
    // A recovery-required run never reaches a terminal state: the orchestrator keeps it live.
    hasLiveRun: (): boolean => state === "recovery-required",
    stop: (): Promise<unknown> => Promise.resolve({ ok: true }),
    shutdown: (): Promise<unknown> => {
      observed.shutdowns += 1;
      return Promise.resolve({ ok: true });
    },
  };
}

/** An event hub whose stream closes at once: the run has settled when the driver subscribes. */
const SETTLED_EVENT_HUB = {
  subscribe: (
    _runId: string,
    _last: string | undefined,
    subscriber: { write: (event: CodingWorkbenchRuntimeSseEvent) => unknown; close: () => void },
  ): unknown => {
    subscriber.close();
    return { ok: true, detach: () => undefined };
  },
};

export function fakeReviewComposition(
  instanceId: string,
  reportPort: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
  script: ScriptedReviewRun,
  observed: ReviewRuntimeObservations,
): ReviewRuntimeComposition {
  const workspace = createReviewWorkspaceLifecycle();
  const boundRoot = (): string => workspace.getActive()?.binding.activeRoot ?? "unbound";
  return {
    instanceId,
    controlPlane: {
      orchestrator: scriptedOrchestrator(reportPort, script, observed, boundRoot),
      eventHub: SETTLED_EVENT_HUB,
      runtimeCapabilityAuthenticator: {
        authenticate: (capability: string): unknown => ({ ok: capability === `cap-${instanceId}` }),
      },
    } as never,
    readiness: { toolProfile: "review" } as never,
    workspace,
    expectStart: () => undefined,
    authorityProbe: () => undefined,
    facadePurpose: "review",
    sidecarDeps: (base) => base,
    close: (): void => {
      observed.closes += 1;
    },
  };
}
