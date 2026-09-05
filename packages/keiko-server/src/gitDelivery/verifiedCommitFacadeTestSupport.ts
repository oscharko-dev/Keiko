import type { DraftDeliveryService } from "./draftDeliveryTypes.js";
import { requestDraftDeliveryApproval } from "../coding-runtime/productionDraftDeliveryRuntime.js";
import type { RuntimeGitService } from "./runtimeGitService.js";
import {
  requestRuntimeStageApproval,
  requestVerifiedCommitApproval,
} from "../coding-runtime/productionVerifiedCommitRuntime.js";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeEvent,
  VerificationReport,
} from "@oscharko-dev/keiko-contracts";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createProductionManagedWorktreeToolFacade } from "../coding-runtime/productionManagedWorktreeTools.js";
import {
  createCodingToolApprovalBridge,
  codingToolApprovalBindingDigest,
} from "../coding-runtime/codingToolApprovalBridge.js";
import { createCodingToolInvocationRegistry } from "../coding-runtime/codingToolInvocationRegistry.js";
import type { VerifiedCommitService } from "./verifiedCommitTypes.js";

interface CommitFacadeFixtureInput {
  readonly service: VerifiedCommitService;
  readonly gitService?: RuntimeGitService;
  readonly draftDeliveryService?: DraftDeliveryService;
  readonly root: string;
  readonly mode: CodingWorkbenchMode;
  readonly live: () => boolean;
  readonly report: () => VerificationReport;
}
interface CommitFacadeFixtureResult {
  readonly facade: import("../coding-runtime/codingToolFacadePorts.js").CodingToolFacade;
  readonly bridge: ReturnType<typeof createCodingToolApprovalBridge>;
  readonly events: CodingWorkbenchRuntimeEvent[];
  readonly verification: Extract<
    import("../coding-runtime/codingToolIpc.js").CodingToolActionRequest,
    { readonly action: "verification" }
  >;
}

function fixtureEnvelope(input: CommitFacadeFixtureInput): CodingWorkbenchRuntimeAuthorityEnvelope {
  return {
    authority: {
      effectiveMode: input.mode,
      actionClasses: [
        "workspace-read",
        "workspace-write",
        "verification",
        ...(input.mode === "autonomous-delivery" ? ["delivery-substrate"] : []),
        ...(input.draftDeliveryService !== undefined && input.mode === "autonomous-delivery"
          ? ["network-egress"]
          : []),
      ],
      connectorScopes: input.mode === "autonomous-delivery" ? ["source-control.write"] : [],
      commandPolicy: { mode: "deny", allow: [], deny: [], requirePerCommandApproval: true },
      networkPolicy:
        input.draftDeliveryService !== undefined && input.mode === "autonomous-delivery"
          ? { mode: "connector-bound", connectorScopes: ["source-control.write"] }
          : { mode: "deny-all", connectorScopes: [] },
    },
  } as unknown as CodingWorkbenchRuntimeAuthorityEnvelope;
}
function fixtureFacts(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
): CodingWorkbenchRuntimeAuthorityFacts {
  const digest = "a".repeat(64);
  return {
    binding: {
      taskId: "task-1",
      projectId: "repo-1",
      projectDigest: digest,
      workspaceId: "workspace-1",
      workspaceRootDigest: digest,
      branchRef: "codex/task",
      branchHeadDigest: digest,
    },
    actionClasses: envelope.authority.actionClasses,
    connectorScopes: envelope.authority.connectorScopes,
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    budgetDigest: digest,
    commandPolicyDigest: digest,
    networkPolicyDigest: digest,
    gatesDigest: digest,
    branchConstraintsDigest: digest,
    modelProfileDigest: digest,
  };
}
function fixtureFacade(
  input: CommitFacadeFixtureInput,
  bridge: ReturnType<typeof createCodingToolApprovalBridge>,
  events: CodingWorkbenchRuntimeEvent[],
): CommitFacadeFixtureResult["facade"] {
  const envelope = fixtureEnvelope(input);
  const facts = fixtureFacts(envelope);
  const onEvent = (event: CodingWorkbenchRuntimeEvent): void => {
    events.push(event);
  };
  return createProductionManagedWorktreeToolFacade({
    authority: {
      revalidateCapabilityForMutation: () =>
        input.live() ? { ok: true, envelope } : { ok: false, reason: "revoked" },
      resolveCapabilityForDelegation: () =>
        input.live() ? { ok: true, envelope } : { ok: false, reason: "revoked" },
    },
    authorityRef: { runId: "run-1", envelopeDigest: "b".repeat(64) },
    workspaceRoot: input.root,
    resolveWorkspaceRootAccess: () => ({
      kind: "managed-task",
      canonicalRoot: input.root,
      repositoryRoot: input.root,
      fs: nodeWorkspaceFs,
    }),
    authorityExpiresAt: "2099-01-01T00:00:00.000Z",
    effectiveMode: input.mode,
    deploymentCeiling: input.mode,
    liveFacts: () => facts,
    secureWorkspaceTextRead: {
      readText: () => Promise.resolve({ ok: false, reason: "not-found" }),
    },
    editorAgentClient: {
      action: () =>
        Promise.resolve({ ok: false, error: { kind: "route", code: "denied", message: "denied" } }),
    },
    invocationRegistry: createCodingToolInvocationRegistry(),
    approvalProofVerifier: bridge,
    verifiedCommitService: input.service,
    ...fixtureGitOptions(input, onEvent),
    verificationRunner: { runToReport: () => Promise.resolve(input.report()) },
    onRuntimeEvent: onEvent,
    requestCommitApproval: (id) => {
      requestVerifiedCommitApproval(input.service, id, onEvent);
    },
  });
}
function fixtureVerification(
  bridge: ReturnType<typeof createCodingToolApprovalBridge>,
): CommitFacadeFixtureResult["verification"] {
  const digest = "a".repeat(64);
  const verification = {
    action: "verification" as const,
    actionId: "verify-1",
    idempotencyKey: "verify-1",
    verifierId: "typecheck",
  };
  const proof = {
    approvalId: verification.actionId,
    approvalDigest: codingToolApprovalBindingDigest("run-1", verification),
  };
  bridge.observePermission({
    runId: "run-1",
    requestId: "verification-review",
    ...verification,
    targetId: verification.verifierId,
    proof,
    nowMs: Date.now(),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  bridge.activatePermission({
    runId: "run-1",
    requestId: "verification-review",
    approvalAuthorityDigest: digest,
    nowMs: Date.now(),
    expiresAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  return { ...verification, approvalProof: proof };
}
export function commitFacadeFixture(input: CommitFacadeFixtureInput): CommitFacadeFixtureResult {
  const bridge = createCodingToolApprovalBridge(
    input.service,
    input.gitService,
    input.draftDeliveryService,
  );
  const events: CodingWorkbenchRuntimeEvent[] = [];
  return {
    facade: fixtureFacade(input, bridge, events),
    bridge,
    events,
    verification: fixtureVerification(bridge),
  };
}

function fixtureGitOptions(
  input: CommitFacadeFixtureInput,
  onEvent: (event: CodingWorkbenchRuntimeEvent) => void,
): Pick<
  Parameters<typeof createProductionManagedWorktreeToolFacade>[0],
  | "draftDeliveryService"
  | "requestDraftDeliveryApproval"
  | "runtimeGitService"
  | "requestStageApproval"
> {
  return {
    ...(input.draftDeliveryService === undefined
      ? {}
      : { draftDeliveryService: input.draftDeliveryService }),
    requestDraftDeliveryApproval: (id): void => {
      requestDraftDeliveryApproval(input.draftDeliveryService, id, onEvent);
    },
    ...(input.gitService === undefined ? {} : { runtimeGitService: input.gitService }),
    requestStageApproval: (id): void => {
      requestRuntimeStageApproval(input.gitService, id, onEvent);
    },
  };
}
