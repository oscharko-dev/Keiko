// The dedicated Keiko for Quality review runtime instance (ADR-0182 D1, Issue #4135).
//
// One instance is the EXISTING OpenCode coding runtime composition built a second time, server
// owned: the same production resolver (`createProductionCodingRuntimeResolver`), the same backend
// and composition code, the same host and control plane, and therefore its own orchestrator, its
// own one-run slot, its own authority service and its own sidecar sessions. What differs is only
// what the review needs:
//   - the tool profile is `review` (four tools, `*: deny`, the server-defined review agent);
//   - the workspace authority binds the review worktree through the instance's own workspace view
//     (`reviewWorkspace.ts`) and mints the review authority (`runtimePurpose: "review"`);
//   - the run's facade and the tool bridge carry the review purpose, set by this composition's own
//     review profile rather than copied from the minted authority, and the facade carries the
//     run-bound `keiko_review_report` port;
//   - the snapshot and evidence stores are in-memory and private to the instance, and there is no
//     Coding History store, so review runs are never listed by Coding Workbench or Coding History;
//   - the sidecar reaches the server under `/api/review-sidecar/*`, which serves the same gateway
//     and tool-facade handlers with this instance's authenticator, readiness and bridge.
// Every model call therefore still passes the coding sidecar gateway route and the Model Gateway
// with its budgets, spend ledger and readiness. The user's Coding Workbench instance is untouched.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type {
  CodingWorkbenchActionClass,
  CodingWorkbenchMode,
  ModelReasoningEffort,
} from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimePurpose } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

import {
  createOpenCodeGatewayReadinessRegistry,
  type OpenCodeGatewayReadinessRegistry,
} from "../../coding-sidecar-gateway.js";
import {
  createCodingRuntimeControlPlane,
  type CodingRuntimeControlPlane,
} from "../../coding-runtime/codingRuntimeControlPlane.js";
import { createCodingRuntimeEvidenceAggregator } from "../../coding-runtime/codingRuntimeEvidenceAggregator.js";
import { createCodingRuntimeSnapshotStore } from "../../coding-runtime/codingRuntimeSnapshotStore.js";
import { createAuthenticatedSessionStartConfirmationPlane } from "../../coding-runtime/codingRuntimeStartConfirmationPlane.js";
import type { CodingRuntimeStartConfirmationConsumer } from "../../coding-runtime/codingRuntimeStartConfirmation.js";
import { createProductionCodingRuntimeHost } from "../../coding-runtime/productionCodingRuntimeHost.js";
import {
  createProductionCodingRuntimeResolver,
  type ProductionCodingRuntimeResolverInput,
} from "../../coding-runtime/productionCodingRuntimeResolver.js";
import type { ProductionManagedWorktreeToolInput } from "../../coding-runtime/productionManagedWorktreeTools.js";
import { resolveProductionRuntimeContext } from "../../coding-runtime/productionRuntimeWorkspaceAuthority.js";
import type { ServerDiagnosticSink } from "../../diagnostics-log.js";
import type { ServerLogSink } from "../../observability/index.js";
import { runMigrations } from "../../store/schema.js";
import type { WorkspaceRootAccess } from "../../task-workspace/workspace-root-access.js";
import type { UiHandlerDeps } from "../../deps.js";
import {
  createReviewWorkspaceLifecycle,
  type ReviewWorkspaceLifecycle,
} from "./reviewWorkspace.js";

/** The runtime ports one review instance composes from (the activated OpenCode runtime). */
type ReviewRuntimeActivatedPorts = Pick<
  ProductionCodingRuntimeResolverInput,
  "backend" | "editorAgentClient" | "secureWorkspaceTextRead"
>;

interface ReviewRuntimeActivationRequest {
  /** `<stateDir>/review-runtime`: every per-run state directory of the instance lives below it. */
  readonly runtimeStateDir: string;
  readonly gatewayReadiness: OpenCodeGatewayReadinessRegistry;
  /** The review worktree the instance is bound to right now. */
  readonly resolveWorkspaceRoot: () => string | undefined;
  /** The instance's own run evidence; never the Coding Workbench's. */
  readonly runtimeEvidence: ReturnType<typeof createCodingRuntimeEvidenceAggregator>;
}

export interface ReviewRuntimeCompositionInput {
  readonly instanceId?: string | undefined;
  readonly runtimeStateDir: string;
  /** The server-owned root every review worktree lives under (Issue #4133). */
  readonly reviewWorktreeRoot: string;
  /** Activates the OpenCode runtime for this instance; `undefined` when none is available. */
  readonly activate: (
    request: ReviewRuntimeActivationRequest,
  ) => ReviewRuntimeActivatedPorts | undefined;
  readonly verificationRunner: ProductionCodingRuntimeResolverInput["verificationRunner"];
  readonly readWorkspaceHead: (workspaceRoot: string, repositoryRoot: string) => string | undefined;
  readonly resolveManagedModelProfile: (
    modelId: string | undefined,
    reasoningEffort: ModelReasoningEffort | undefined,
  ) => { readonly profileId: string; readonly reasoningEffort?: ModelReasoningEffort };
  readonly promptTokenBudget: number;
  readonly maxDurationMinutes: number;
  readonly evidenceStore: EvidenceStore;
  /** Records each sidecar gateway outcome as run evidence (`codingSidecarGatewayEvidenceRecorder`). */
  readonly gatewayEvidenceRecorder: (
    controlPlane: CodingRuntimeControlPlane,
    evidence: ReturnType<typeof createCodingRuntimeEvidenceAggregator>,
  ) => NonNullable<UiHandlerDeps["codingSidecarGatewayEvidenceAggregator"]>;
  /** The review report port of one minted run (the instance's run-bound intake). */
  readonly reviewReportPort: (runId: string) => ProductionManagedWorktreeToolInput["reviewReport"];
  readonly serverPrincipal: () => string | undefined;
  readonly activityLog: ServerLogSink;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

/** A composed review instance: its own control plane and the facts its self-check reads. */
export interface ReviewRuntimeComposition {
  readonly instanceId: string;
  readonly controlPlane: CodingRuntimeControlPlane;
  readonly readiness: OpenCodeGatewayReadinessRegistry;
  readonly workspace: ReviewWorkspaceLifecycle;
  /** Admits exactly the next start confirmation of the request id the instance registered. */
  readonly expectStart: (requestId: string) => void;
  /**
   * The authority a run started now would be minted with, resolved through the same workspace
   * authority path the resolver uses; `undefined` when none can be resolved (self-check layer 3).
   */
  readonly authorityProbe: (modelId: string) => ReviewRuntimeAuthorityFacts | undefined;
  /**
   * The purpose the composed resolver hands every run's tool facade and catalog bridge (self-check
   * layer 4). The composition sets it from its own review profile, never from a minted context.
   */
  readonly facadePurpose: CodingRuntimePurpose | undefined;
  /** The deps the shared sidecar handlers read, with this instance's runtime capabilities. */
  readonly sidecarDeps: (base: UiHandlerDeps) => UiHandlerDeps;
  readonly close: () => void;
}

interface ReviewRuntimeAuthorityFacts {
  readonly actionClasses: readonly CodingWorkbenchActionClass[];
  readonly effectiveMode: CodingWorkbenchMode;
  readonly runtimePurpose: CodingRuntimePurpose | undefined;
}

function probeAuthority(
  authority: ProductionCodingRuntimeResolverInput["workspaceAuthority"],
  workspace: ReviewWorkspaceLifecycle,
  principal: string | undefined,
  modelId: string,
): ReviewRuntimeAuthorityFacts | undefined {
  const active = workspace.getActive();
  if (active === undefined || principal === undefined) return undefined;
  try {
    const context = resolveProductionRuntimeContext(authority, {
      runId: "review-self-check",
      requestId: "review-self-check",
      taskIntent: "",
      requestedMode: "governed-assist",
      modelId,
      workspaceId: active.instance.workspaceId,
      workspaceRoot: active.binding.activeRoot,
      serverPrincipal: principal,
    });
    return {
      actionClasses: context.actionClasses,
      effectiveMode: resolveEffectiveCodingWorkbenchMode(
        "governed-assist",
        context.deploymentCeiling,
      ),
      runtimePurpose: context.runtimePurpose,
    };
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

/** Admits only the start the instance itself is making, once, through the authenticated plane. */
function reviewStartConfirmations(): {
  readonly consumer: CodingRuntimeStartConfirmationConsumer;
  readonly expect: (requestId: string) => void;
} {
  const plane = createAuthenticatedSessionStartConfirmationPlane();
  let expected: string | undefined;
  return {
    expect: (requestId): void => {
      expected = requestId;
    },
    consumer: {
      consume: (claim): ReturnType<CodingRuntimeStartConfirmationConsumer["consume"]> => {
        if (expected === undefined || claim.requestId !== expected) return undefined;
        expected = undefined;
        return plane.consume(claim);
      },
    },
  };
}

function rootAccess(
  workspace: ReviewWorkspaceLifecycle,
): (requestedRoot: string) => WorkspaceRootAccess | undefined {
  return (requestedRoot) => {
    const bound = workspace.bound();
    return bound?.worktreeRoot === requestedRoot
      ? {
          kind: "managed-task",
          canonicalRoot: requestedRoot,
          fs: nodeWorkspaceFs,
          repositoryRoot: bound.repositoryRoot,
        }
      : undefined;
  };
}

function reviewWorkspaceAuthority(
  input: ReviewRuntimeCompositionInput,
  workspace: ReviewWorkspaceLifecycle,
): ProductionCodingRuntimeResolverInput["workspaceAuthority"] {
  return {
    workspaceLifecycle: workspace,
    managedTaskWorkspaceRoot: input.reviewWorktreeRoot,
    deploymentCeiling: "governed-assist",
    promptTokenBudget: input.promptTokenBudget,
    maxDurationMinutes: input.maxDurationMinutes,
    readWorkspaceHead: input.readWorkspaceHead,
    researchEgressEnabled: false,
    runtimePurpose: "review",
    resolveManagedModelProfile: input.resolveManagedModelProfile,
  };
}

function privateSnapshotStore(): {
  readonly db: DatabaseSync;
  readonly store: ReturnType<typeof createCodingRuntimeSnapshotStore>;
} {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return { db, store: createCodingRuntimeSnapshotStore(db) };
}

/**
 * Composes one review instance, or `undefined` when no OpenCode runtime can be activated for it
 * (the review then settles `skipped/model-unavailable` in Issue #4136; nothing is half-composed).
 */
export function composeReviewRuntime(
  input: ReviewRuntimeCompositionInput,
): ReviewRuntimeComposition | undefined {
  const workspace = createReviewWorkspaceLifecycle();
  const readiness = createOpenCodeGatewayReadinessRegistry("review");
  const evidence = createCodingRuntimeEvidenceAggregator(input.evidenceStore);
  const ports = input.activate({
    runtimeStateDir: input.runtimeStateDir,
    gatewayReadiness: readiness,
    resolveWorkspaceRoot: () => workspace.bound()?.worktreeRoot,
    runtimeEvidence: evidence,
  });
  if (ports === undefined) return undefined;
  const confirmations = reviewStartConfirmations();
  const authority = reviewWorkspaceAuthority(input, workspace);
  const resolver = createProductionCodingRuntimeResolver({
    workspaceAuthority: authority,
    ...ports,
    verificationRunner: input.verificationRunner,
    resolveWorkspaceRootAccess: rootAccess(workspace),
    confirmationConsumer: confirmations.consumer,
    reviewReportPort: input.reviewReportPort,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });
  const host = createProductionCodingRuntimeHost({
    resolve: () => {
      const qualified = resolver.resolve();
      return qualified === undefined
        ? undefined
        : { ...qualified, openCodeGatewayReadinessRegistry: readiness };
    },
  });
  if (host === undefined) return undefined;
  return assembleComposition(input, {
    workspace,
    readiness,
    host,
    confirmations,
    authority,
    evidence,
    facadePurpose: () => resolver.facadePurpose,
  });
}

function assembleComposition(
  input: ReviewRuntimeCompositionInput,
  parts: {
    readonly workspace: ReviewWorkspaceLifecycle;
    readonly readiness: OpenCodeGatewayReadinessRegistry;
    readonly host: NonNullable<ReturnType<typeof createProductionCodingRuntimeHost>>;
    readonly confirmations: ReturnType<typeof reviewStartConfirmations>;
    readonly authority: ProductionCodingRuntimeResolverInput["workspaceAuthority"];
    readonly evidence: ReturnType<typeof createCodingRuntimeEvidenceAggregator>;
    readonly facadePurpose: () => CodingRuntimePurpose | undefined;
  },
): ReviewRuntimeComposition {
  const snapshots = privateSnapshotStore();
  const evidence = parts.evidence;
  const controlPlane = createCodingRuntimeControlPlane({
    snapshots: snapshots.store,
    evidence,
    workspaceLifecycle: parts.workspace,
    serverPrincipal: input.serverPrincipal,
    runtimeHost: parts.host,
    deploymentCeiling: "governed-assist",
    runtimePurpose: "review",
    activityLog: input.activityLog,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  });
  const gatewayEvidence = input.gatewayEvidenceRecorder(controlPlane, evidence);
  return {
    instanceId: input.instanceId ?? randomUUID(),
    controlPlane,
    readiness: parts.readiness,
    workspace: parts.workspace,
    expectStart: parts.confirmations.expect,
    authorityProbe: (modelId): ReviewRuntimeAuthorityFacts | undefined =>
      probeAuthority(parts.authority, parts.workspace, input.serverPrincipal(), modelId),
    get facadePurpose(): CodingRuntimePurpose | undefined {
      return parts.facadePurpose();
    },
    sidecarDeps: (base): UiHandlerDeps => reviewSidecarDeps(base, controlPlane, gatewayEvidence),
    close: (): void => {
      snapshots.db.close();
    },
  };
}

/**
 * The shared sidecar handlers read the coding instance's runtime capabilities from the deps graph.
 * The review routes hand them this view instead: the same handlers and Model Gateway, with the
 * review instance's authenticator, readiness, bridge, orchestrator and event hub.
 */
function reviewSidecarDeps(
  base: UiHandlerDeps,
  controlPlane: CodingRuntimeControlPlane,
  gatewayEvidence: NonNullable<UiHandlerDeps["codingSidecarGatewayEvidenceAggregator"]>,
): UiHandlerDeps {
  return {
    ...base,
    codingRuntimeOrchestrator: controlPlane.orchestrator,
    codingRuntimeEventHub: controlPlane.eventHub,
    codingSidecarGatewayEvidenceAggregator: gatewayEvidence,
    runtimeCapabilityAuthenticator: controlPlane.runtimeCapabilityAuthenticator,
    openCodeGatewayReadinessRegistry: controlPlane.openCodeGatewayReadinessRegistry,
    toolFacadeBridge: controlPlane.toolFacadeBridge,
    codingSidecarGatewayCancellationRegistry: controlPlane.cancellationRegistry,
  };
}
