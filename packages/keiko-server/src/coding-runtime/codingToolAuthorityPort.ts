import type { OpenCodeToolProfile } from "./opencodeToolSchemas.js";
import { createHash } from "node:crypto";
import { isDenied } from "@oscharko-dev/keiko-workspace";

import type { CiRepairExecutionBudget } from "./codingRuntimeCiRepairController.js";
import { isDraftToolRequest } from "./codingRuntimeDeliveryIpc.js";
import type {
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeAdapterKind,
  CodingWorkbenchRuntimeAuthorityFacts,
  CodingWorkbenchRuntimeAuthorityEnvelope,
  CodingWorkbenchRuntimeDelegationUsage,
  GitDeliveryApprovalClaim,
} from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchCodeTaskDeliveryEffectFor,
  codingWorkbenchPolicyEffectFor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type {
  CodingToolAuthorityPort,
  CodingToolFacade,
  CodingToolFacadeOptions,
  CodingToolFacadeInput,
  CodingToolNativeTextReadFacet,
  CodingToolNativeTextSnapshotResult,
  CodingToolNativeReadBeginInput,
  CodingToolNativeReadBeginResult,
  CodingToolNativeReadInvocations,
  CodingToolNativeReadIdentity,
  CodingToolNativeReadOwner,
  CodingToolNativeReadFilePacket,
  CodingToolNativeInvocationRefusal,
  CodingToolNativeReadFileIO,
  CodingToolNativeReadFileIOOwner,
  CodingToolNativeReadBytesResult,
  CodingToolNativeReadStatResult,
  CodingToolNativeReadListResult,
  CodingToolMutationGuard,
  CodingToolProducerBinding,
  MaterializedPatchCharge,
} from "./codingToolFacadePorts.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import { changesetPayloadBytes } from "./codingToolReplacementEdits.js";
import {
  createCodingToolGovernedDelegate,
  type CodingToolGovernedPorts,
  type GovernedCodingToolResult,
} from "./codingToolGovernedDelegate.js";
import {
  CODING_TOOL_MAX_BODY_BYTES,
  parseCodingToolRequest,
  codingToolRequiredActionClasses,
  type CodingToolActionRequest,
  type CodingToolResult,
} from "./codingToolIpc.js";
import {
  isApprovableToolRequest,
  commitClaim,
  type CodingToolApprovalProofVerifier,
} from "./codingToolApprovalBridge.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import {
  createCanonicalCatalogFacadeBridge,
  type CanonicalCatalogFacadeBridge,
} from "../tool-catalog/catalogToolFacadeBridge.js";
import {
  wholeFileDigest,
  WORKSPACE_READ_REFUSAL_CODES,
  type CodingToolReadEditPorts,
  type GovernedTextSnapshotResult,
  type GovernedNativeFileIO,
  type GovernedNativeFileRequest,
} from "./codingToolReadEditPorts.js";
import {
  isSecureWorkspaceNativeRelativePath,
  isSecureWorkspaceNativeRange,
} from "./secureWorkspaceTextRead.js";
import type { OpenCodeOptionalToolName } from "./opencodeLaunchProfile.js";
import { CatalogDispatchFault } from "../tool-catalog/catalogToolRuntimeAuthority.js";
import type { CatalogToolBudgetPort } from "../tool-catalog/catalogToolPorts.js";
import { createCodingToolInvocationRegistry } from "./codingToolInvocationRegistry.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { defaultServerDiagnosticSink, type ServerDiagnosticSink } from "../diagnostics-log.js";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { CODING_RUNTIME_TOOL_RESULT_OPERATION } from "./codingRuntimeActivityOperations.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const CODING_RUNTIME_TOOL_AUTHORITY_DENIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.tool-authority.denied",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.codingToolAuthorityPort.logAuthorityDenial",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "read",
        "discover",
        "search",
        "edit",
        "command",
        "verification",
        "git",
        "delivery",
        "connector",
        "egress",
        "skill",
        "skill-discover",
        "child-agent",
      ],
    },
    effectiveMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-tool-authority"],
  proofIds: ["coding-runtime.tool-authority.denied.emitted-line"],
  releaseImpact: "patch",
});

export interface CodingToolAuthorityContext {
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly liveFacts: CodingWorkbenchRuntimeAuthorityFacts;
  readonly workspaceRoot: string;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly nowIso: string;
  readonly runId?: string | undefined;
  readonly envelopeDigest?: string | undefined;
  readonly authorityExpiresAt?: string | undefined;
  // F8 (#3413): threads this run's correlation id into the tool-catalog.* lifecycle log lines the
  // catalog facade bridge emits. productionManagedWorktreeTools.ts's context provider now populates
  // this from `input.authorityRef.runId`, so those lines join the run's own activity log.
  // UNKNOWN_CORRELATION_ID (correlation.ts) remains the sanctioned fallback for any other/future
  // caller that leaves this optional field unset -- never a silently missing id.
  readonly correlationId?: string | undefined;
}

export type CodingToolAuthorityContextProvider = () => CodingToolAuthorityContext;

interface CodingToolAuthorityPortOptions {
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly requireProducerBinding?: boolean | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
}

interface RuntimeCodingToolFacadeOptions extends CodingToolFacadeOptions {
  readonly toolProfile?: OpenCodeToolProfile | undefined;
  readonly nativeTextRead?: CodingToolReadEditPorts["nativeTextRead"] | undefined;
  readonly nativeFileIO?: GovernedNativeFileIO | undefined;
  readonly ciRepairBudget?: CiRepairExecutionBudget;
  readonly approvalProofVerifier?: CodingToolApprovalProofVerifier | undefined;
  readonly reserveEditDelegation?: boolean | undefined;
  // F8 (#3413): production always wires the real catalog facade bridge; these three let a test
  // observe its lifecycle log lines or replace its budget port without touching process-wide
  // state. `disableCatalogBridge` exists only for a test that must isolate an unrelated concern.
  readonly catalogActivityLog?: ServerLogSink | undefined;
  readonly catalogDiagnostics?: ServerDiagnosticSink | undefined;
  readonly catalogBudget?: CatalogToolBudgetPort | undefined;
  readonly unavailableOptionalTools?: (() => ReadonlySet<OpenCodeOptionalToolName>) | undefined;
  readonly disableCatalogBridge?: boolean | undefined;
}

export type CodingToolAuthorityAvailability =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type CodingToolAuthorityPreview = (
  capability: string | undefined,
  request: CodingToolActionRequest,
) => CodingToolAuthorityAvailability;

/** Non-consuming availability only. Actual dispatch must still call the authoritative admission. */
export function createCodingToolAuthorityPreview(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  options: CodingToolAuthorityPortOptions = {},
): CodingToolAuthorityPreview {
  return (capability, request): CodingToolAuthorityAvailability => {
    const result = admissionPreflight(
      authority,
      context,
      capability,
      request,
      options.approvalProofVerifier,
      options.requireProducerBinding === true,
    );
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          reason: result.approvalRequired === true ? "approval-required" : result.reason,
        };
  };
}

type AdmissionPreflight =
  | { readonly ok: false; readonly reason: string; readonly approvalRequired?: boolean }
  | {
      readonly ok: true;
      readonly trusted: CodingToolAuthorityContext;
      readonly binding: CodingToolProducerBinding | undefined;
      readonly approvalMatched: boolean;
    };

function admissionPreflight(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string | undefined,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
  requireProducerBinding: boolean,
  activityLog?: ServerLogSink,
): AdmissionPreflight {
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const trusted = context();
  const binding = producerBinding(trusted);
  if (requireProducerBinding && binding === undefined)
    return { ok: false, reason: "producer-binding-missing" };
  const preflight = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const approvalMatched = approved(preflight.envelope, trusted, request, verifier);
  if (!actionAllowed(preflight.envelope, request, approvalMatched)) {
    logAuthorityDenial(activityLog, trusted, preflight.envelope, request);
    return {
      ok: false,
      reason: "action-not-authorized",
      approvalRequired: !approvalMatched && actionAllowed(preflight.envelope, request, true),
    };
  }
  return { ok: true, trusted, binding, approvalMatched };
}

function logAuthorityDenial(
  activityLog: ServerLogSink | undefined,
  context: CodingToolAuthorityContext,
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_TOOL_AUTHORITY_DENIED_OPERATION,
      {
        level: "warn",
        correlationId: context.correlationId ?? UNKNOWN_CORRELATION_ID,
        errorKind: "authority-denied",
      },
      { action: request.action, effectiveMode: envelope.authority.effectiveMode },
    ),
  );
}

// The authority surface this port reads. `delegationFits` answers a budget question without
// reserving (#3417); an authority that cannot answer it answers no.
type CodingToolAuthorityService = Pick<
  CodingRuntimeAuthorityService,
  "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
> &
  Partial<Pick<CodingRuntimeAuthorityService, "delegationFits">>;

export function createCodingToolAuthorityPort(
  authority: CodingToolAuthorityService,
  context: CodingToolAuthorityContextProvider,
  options: CodingToolAuthorityPortOptions = {},
): CodingToolAuthorityPort {
  return {
    admit: (capability, request): ReturnType<CodingToolAuthorityPort["admit"]> =>
      admit(authority, context, capability, request, options),
  };
}

function admit(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  capability: string | undefined,
  request: CodingToolActionRequest,
  options: CodingToolAuthorityPortOptions,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const { approvalProofVerifier, requireProducerBinding, reserveEditDelegation, activityLog } =
    options;
  if (capability === undefined) return { ok: false, reason: "capability-missing" };
  const preflight = admissionPreflight(
    authority,
    context,
    capability,
    request,
    approvalProofVerifier,
    requireProducerBinding === true,
    activityLog,
  );
  if (!preflight.ok) return { ok: false, reason: preflight.reason };
  const { trusted, binding, approvalMatched } = preflight;
  if (request.action === "edit" && !reserveEditDelegation) {
    return guarded(authority, context, capability, request, binding, false);
  }
  const resolved = resolveDelegation(authority, trusted, capability, request);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (!actionAllowed(resolved.envelope, request, approvalMatched)) {
    logAuthorityDenial(activityLog, trusted, resolved.envelope, request);
    return { ok: false, reason: "action-not-authorized" };
  }
  // A one-shot proof is consumed only after the delegation budget has been reserved. Consuming it
  // during preflight or before the resolved envelope is authorized would make a transient failure
  // permanently deny a valid action.
  return finishAdmission({
    authority,
    context,
    capability,
    request,
    binding,
    trusted,
    approvalMatched,
    approvalProofVerifier,
  });
}

// #3384 F4: the commit-execute branch of `finishAdmission` no longer consumes the one-use commit
// approval at admission — see the comment there. It instead threads the un-consumed claim through
// `mutationGuard.deliveryApproval` wrapped in this shape (never `undefined` itself, so it stays
// distinguishable from "no delivery approval applies to this request"); `claim` itself legitimately
// stays `undefined` for a binding-matched, un-tokened redemption. productionManagedWorktreeTools.ts
// unwraps it and passes `.claim` to `VerifiedCommitService.execute()`, which alone decides — after
// its own preflight — whether the claim is spent.
export interface CommitExecutionApproval {
  readonly claim: GitDeliveryApprovalClaim | undefined;
}

interface FinishAdmissionInput {
  readonly authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >;
  readonly context: CodingToolAuthorityContextProvider;
  readonly capability: string;
  readonly request: CodingToolActionRequest;
  readonly binding: CodingToolProducerBinding | undefined;
  readonly trusted: CodingToolAuthorityContext;
  readonly approvalMatched: boolean;
  readonly approvalProofVerifier: CodingToolApprovalProofVerifier | undefined;
}
function finishAdmission(
  input: FinishAdmissionInput,
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const {
    authority,
    context,
    capability,
    request,
    binding,
    trusted,
    approvalMatched,
    approvalProofVerifier,
  } = input;
  if (request.action === "delivery" && request.phase === "execute") {
    if (trusted.runId === undefined) return { ok: false, reason: "action-not-authorized" };
    // Full access reaches this branch only after both admission passes accepted the exact live
    // delivery envelope without an approval proof. Preserve that policy authorization as an
    // approval-free guard; the delivery service rechecks the live mode and this guard at its
    // effect edge before it can pass `{ required: false }` to the Git kernel.
    if (!approvalMatched) return guarded(authority, context, capability, request, binding, false);
    if (isDraftToolRequest(request)) {
      const lease = approvalProofVerifier?.consumeDelivery?.(trusted.runId, request);
      if (lease === undefined) return { ok: false, reason: "action-not-authorized" };
      return guarded(authority, context, capability, request, binding, true, {
        deliveryApproval: lease,
      });
    }
    // #3384 F4 (executeApproved consumes before preflight): the one-use commit approval must
    // NOT be consumed here. `admissionPreflight`'s `approved()` already confirmed a matching,
    // unconsumed approval exists (non-mutating `matchesCommit` check) moments ago, so consuming
    // it now would burn it on every legitimate pre-commit block (staged-tree drift, unresolved
    // conflict markers) that VerifiedCommitService.execute()'s own preflight runs strictly
    // AFTER admission. Pass the un-consumed claim through the guard instead; execute() alone
    // decides whether to spend it, only once that preflight has cleared (mirrors executeOne's
    // HTTP-route parity comment in verifiedCommitService.ts).
    const approval: CommitExecutionApproval = { claim: commitClaim(request) };
    return guarded(authority, context, capability, request, binding, true, {
      deliveryApproval: approval,
    });
  }
  const stage = finishStageAdmission(input);
  if (stage !== undefined) return stage;
  const approvalVerified = consumeMatchedApproval(
    approvalMatched,
    trusted,
    request,
    approvalProofVerifier,
  );
  // An edit reaches this line only when its admission reserved the run's edit budget
  // (`reserveEditDelegation`), so its guard may top that reservation up once the edit is
  // materialized; a wiring that leaves edits to the editor route never arrives here.
  return guarded(authority, context, capability, request, binding, approvalVerified, {
    chargesMaterializedPatch: request.action === "edit",
  });
}

function finishStageAdmission(
  input: FinishAdmissionInput,
): ReturnType<CodingToolAuthorityPort["admit"]> | undefined {
  const {
    request,
    trusted,
    approvalProofVerifier,
    authority,
    context,
    capability,
    binding,
    approvalMatched,
  } = input;
  if (
    request.action === "git" &&
    request.operation === "stage" &&
    request.phase === "execute" &&
    approvalMatched
  ) {
    const lease =
      trusted.runId === undefined
        ? undefined
        : approvalProofVerifier?.consumeStage?.(trusted.runId, request.proposalId);
    if (lease === undefined) return { ok: false, reason: "action-not-authorized" };
    const admitted = guarded(authority, context, capability, request, binding, true);
    return admitted.ok
      ? { ...admitted, mutationGuard: { ...admitted.mutationGuard, stageApproval: lease } }
      : admitted;
  }
  return undefined;
}

function resolveDelegation(
  authority: Pick<CodingRuntimeAuthorityService, "resolveCapabilityForDelegation">,
  context: CodingToolAuthorityContext,
  capability: string,
  request: CodingToolActionRequest,
): ReturnType<CodingRuntimeAuthorityService["resolveCapabilityForDelegation"]> {
  return authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: context.adapterKind,
    liveFacts: context.liveFacts,
    delegationId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    usage: delegationUsage(request),
    workspaceRoot: context.workspaceRoot,
    deploymentCeiling: context.deploymentCeiling,
    nowIso: context.nowIso,
  });
}

function approved(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  return (
    actionClassesAllowed(envelope, request, true) &&
    verifyApprovalProof(envelope, context, request, verifier)
  );
}

interface GuardExtras {
  readonly deliveryApproval?: object | undefined;
  /** True only for an edit whose admission reserved the run's edit budget (#3873 review). */
  readonly chargesMaterializedPatch?: boolean | undefined;
}

function guarded(
  authority: CodingToolAuthorityService,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  binding: CodingToolProducerBinding | undefined,
  approvalVerified: boolean,
  extras: GuardExtras = {},
): ReturnType<CodingToolAuthorityPort["admit"]> {
  const { deliveryApproval, chargesMaterializedPatch } = extras;
  const mutationGuard = {
    ...(deliveryApproval === undefined ? {} : { deliveryApproval }),
    check: (): boolean => revalidate(authority, context, capability, request, approvalVerified),
    resolveParentAuthority: (): CodingWorkbenchAuthorityEnvelope | undefined =>
      revalidateEnvelope(authority, context, capability, request, approvalVerified)?.authority,
    chargeDelegatedRead: (delegationId: string, idempotencyKey: string): boolean =>
      chargeDelegatedRead(authority, context, capability, delegationId, idempotencyKey),
    canChargeDelegatedRead: (): boolean => canChargeDelegatedRead(authority, context, capability),
    ...(chargesMaterializedPatch === true
      ? {
          chargeMaterializedPatch: (patchBytes: number): MaterializedPatchCharge =>
            chargeMaterializedPatch(authority, context, capability, request, patchBytes),
        }
      : {}),
    ...(binding === undefined ? {} : { binding }),
  };
  return {
    ok: true,
    mutationGuard,
    ...(binding === undefined ? {} : { binding }),
  };
}

// #3873 review: the run's patch budget bounds what is applied, and a replacement changeset is only
// known in that form once it is materialized. Admission reserved the request payload as the floor;
// the materialized diff's excess is charged here as one more delegation on the same authority
// record, identified by the action it belongs to and carrying no tool call of its own. A refused
// charge refuses the edit before any editor action exists, with the authority's closed reason: only
// `authority-budget-exceeded` is an exhausted budget (#3873 review).
function chargeMaterializedPatch(
  authority: Pick<CodingRuntimeAuthorityService, "resolveCapabilityForDelegation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  patchBytes: number,
): MaterializedPatchCharge {
  if (!Number.isSafeInteger(patchBytes) || patchBytes < 0) {
    return { ok: false, reason: "invalid-intent" };
  }
  if (patchBytes === 0) return { ok: true };
  const trusted = context();
  const resolved = authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    delegationId: materializedPatchIdentity(request.actionId),
    idempotencyKey: materializedPatchIdentity(request.idempotencyKey),
    usage: { toolCalls: 0, patchBytes, promptTokens: 0 },
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
}

// Derived, bounded and collision-free: the registry holds a delegation identity to 256 characters
// while an action identity may carry 512 bytes, so the suffix rides a digest, never the raw id.
function materializedPatchIdentity(identity: string): string {
  return `materialized-patch:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function producerBinding(
  context: CodingToolAuthorityContext,
): CodingToolProducerBinding | undefined {
  if (
    context.runId === undefined ||
    context.envelopeDigest === undefined ||
    context.authorityExpiresAt === undefined ||
    !/^[a-f0-9]{64}$/u.test(context.envelopeDigest) ||
    !Number.isFinite(Date.parse(context.authorityExpiresAt))
  ) {
    return undefined;
  }
  return {
    runId: context.runId,
    envelopeDigest: context.envelopeDigest,
    workspaceId: context.liveFacts.binding.workspaceId,
    workspaceRootDigest: context.liveFacts.binding.workspaceRootDigest,
    expiresAt: context.authorityExpiresAt,
  };
}

export function createRuntimeCodingToolFacade(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  context: CodingToolAuthorityContextProvider,
  governedPorts: CodingToolGovernedPorts,
  options: RuntimeCodingToolFacadeOptions = {},
): CodingToolFacade {
  const configuration = { ...options };
  const activityLog = configuration.catalogActivityLog ?? processServerLogSink();
  const nativeOptions = {
    ...configuration,
    invocationContext: context,
    invocationRegistry:
      configuration.invocationRegistry ??
      createCodingToolInvocationRegistry({ now: lazyContextClock(context) }),
  };
  const authorityPort = createCodingToolAuthorityPort(authority, context, {
    approvalProofVerifier: configuration.approvalProofVerifier,
    activityLog,
    requireProducerBinding: true,
    reserveEditDelegation: configuration.reserveEditDelegation === true,
  });
  const catalogBridge =
    configuration.disableCatalogBridge === true
      ? undefined
      : catalogFacadeBridgeFor(authority, authorityPort, context, nativeOptions, activityLog);
  const facade = createCodingToolFacade(
    {
      authority: authorityPort,
      delegate: createCodingToolGovernedDelegate(governedPorts, configuration.ciRepairBudget),
    },
    {
      ...configuration,
      requireInvocationRegistryForEdits: true,
      catalogBridge,
    },
  );
  const nativeTextRead = nativeTextReadFacet(
    catalogBridge,
    governedPorts,
    nativeOptions,
    activityLog,
  );
  return nativeTextRead === undefined ? facade : { ...facade, nativeTextRead };
}

/** F8 (#3413): the production CatalogToolBinder-backed bridge for the facade's covered actions
 * (see catalogToolFacadeBridge.ts). Built from the same real catalog used to advertise tools to
 * the model (createOpenCodeGatewayToolCatalogAdvertisement). The fixed private text snapshot
 * contract is compiled by the same catalog owner, without entering that advertisement. */
function catalogFacadeBridgeFor(
  authority: Pick<
    CodingRuntimeAuthorityService,
    "resolveCapabilityForDelegation" | "revalidateCapabilityForMutation"
  >,
  authorityPort: CodingToolAuthorityPort,
  context: CodingToolAuthorityContextProvider,
  options: RuntimeCodingToolFacadeOptions,
  activityLog: ServerLogSink,
): CanonicalCatalogFacadeBridge | undefined {
  const invocationRegistry =
    options.invocationRegistry ??
    createCodingToolInvocationRegistry({ now: lazyContextClock(context) });
  return createCanonicalCatalogFacadeBridge({
    captureNativeReadAction: nativeReadInvocationRequest,
    toolProfile: options.toolProfile,
    nativeTextSnapshotAvailable: options.nativeTextRead !== undefined,
    authority: authorityPort,
    previewAuthority: createCodingToolAuthorityPreview(authority, context, {
      approvalProofVerifier: options.approvalProofVerifier,
      activityLog,
      requireProducerBinding: true,
    }),
    invocationRegistry,
    approvalAvailable: options.approvalProofVerifier !== undefined,
    ...(options.catalogBudget === undefined ? {} : { budgetPort: options.catalogBudget }),
    logPort: {
      primary: activityLog,
      diagnostics: options.catalogDiagnostics ?? defaultServerDiagnosticSink,
    },
    context: () => {
      const current = context();
      return current.runId === undefined || current.authorityExpiresAt === undefined
        ? undefined
        : {
            runId: current.runId,
            correlationId: current.correlationId ?? UNKNOWN_CORRELATION_ID,
            workspaceRoot: current.workspaceRoot,
            workspaceIdentity: current.liveFacts.binding.workspaceId,
            workspaceRevision: current.liveFacts.binding.branchHeadDigest,
            authorityExpiresAt: current.authorityExpiresAt,
            now: Date.parse(current.nowIso),
          };
    },
    ...(options.unavailableOptionalTools === undefined
      ? {}
      : { unavailableOptionalTools: options.unavailableOptionalTools }),
  });
}

function lazyContextClock(context: CodingToolAuthorityContextProvider): () => number {
  let anchor: { readonly epoch: number; readonly elapsed: number } | undefined;
  return (): number => {
    const current =
      anchor ??
      ({
        epoch: Date.parse(context().nowIso),
        elapsed: performance.now(),
      } as const);
    anchor = current;
    return current.epoch + Math.max(0, Math.floor(performance.now() - current.elapsed));
  };
}

function revalidate(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  return (
    revalidateEnvelope(authority, context, capability, request, approvalVerified) !== undefined
  );
}

function revalidateEnvelope(
  authority: Pick<CodingRuntimeAuthorityService, "revalidateCapabilityForMutation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): CodingWorkbenchRuntimeAuthorityEnvelope | undefined {
  const trusted = context();
  const resolved = authority.revalidateCapabilityForMutation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  });
  return resolved.ok && actionAllowed(resolved.envelope, request, approvalVerified)
    ? resolved.envelope
    : undefined;
}

function chargeDelegatedRead(
  authority: Pick<CodingRuntimeAuthorityService, "resolveCapabilityForDelegation">,
  context: CodingToolAuthorityContextProvider,
  capability: string,
  delegationId: string,
  idempotencyKey: string,
): boolean {
  const trusted = context();
  return authority.resolveCapabilityForDelegation({
    capability,
    adapterKind: trusted.adapterKind,
    liveFacts: trusted.liveFacts,
    delegationId,
    idempotencyKey,
    usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
    workspaceRoot: trusted.workspaceRoot,
    deploymentCeiling: trusted.deploymentCeiling,
    nowIso: trusted.nowIso,
  }).ok;
}

// The question `chargeDelegatedRead` answers by charging, for one read, answered without the
// charge (#3417).
function canChargeDelegatedRead(
  authority: Partial<Pick<CodingRuntimeAuthorityService, "delegationFits">>,
  context: CodingToolAuthorityContextProvider,
  capability: string,
): boolean {
  const trusted = context();
  return (
    authority.delegationFits?.({
      capability,
      adapterKind: trusted.adapterKind,
      liveFacts: trusted.liveFacts,
      usage: { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
      workspaceRoot: trusted.workspaceRoot,
      deploymentCeiling: trusted.deploymentCeiling,
      nowIso: trusted.nowIso,
    }) === true
  );
}

function actionAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  return (
    actionClassesAllowed(envelope, request, approvalVerified) &&
    additionalPolicyAllowed(envelope, request, approvalVerified)
  );
}

function actionClassesAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approved: boolean,
): boolean {
  if (request.action === "git" && request.operation === "stage" && approved)
    return hasClasses(envelope.authority.actionClasses, ["workspace-read"]);
  // Propose/reconcile plan a delivery without performing one yet, so they need only
  // workspace-read -- but a matched per-action approval on the EXECUTE phase is not a substitute
  // for the envelope actually carrying delivery authority (KfQ-confirmed: this used to also
  // relax execute to workspace-read whenever approved outside autonomous-delivery, silently
  // skipping the delivery-substrate/connector-access requirement below for every other mode).
  if (
    request.action === "delivery" &&
    deliveryHasScopedApproval(request) &&
    (request.phase === "propose" || request.phase === "reconcile")
  ) {
    return hasClasses(envelope.authority.actionClasses, ["workspace-read"]);
  }
  return hasClasses(envelope.authority.actionClasses, codingToolRequiredActionClasses(request));
}

// The extra policy beyond the required action class, one exhaustive case per governed action.
// Keeping every action's disposition in a single compiler-checked switch is what makes this
// authority decision auditable in one read; splitting it would hide half of the allow/deny surface
// in a second function.
// eslint-disable-next-line complexity -- exhaustive authority switch, see above
function additionalPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: CodingToolActionRequest,
  approvalVerified: boolean,
): boolean {
  switch (request.action) {
    case "read":
    case "discover":
    case "search":
    case "edit":
      return true;
    case "verification":
      return workspaceMediumRiskAllowed(envelope, approvalVerified);
    case "command":
      return (
        workspaceMediumRiskAllowed(envelope, approvalVerified) &&
        commandAllowed(envelope, request.commandId, approvalVerified)
      );
    case "git":
      return runtimeGitPolicyAllowed(envelope, request, approvalVerified);
    case "delivery":
      return request.intent === "commit" || isDraftToolRequest(request)
        ? commitPolicyAllowed(envelope, request, approvalVerified)
        : deliveryAllowed(envelope, request.intent);
    case "connector":
      return (
        internetPolicyAllowed(envelope, approvalVerified) &&
        connectorAllowed(envelope, request.scope)
      );
    case "egress":
      return internetPolicyAllowed(envelope, approvalVerified) && networkAllowed(envelope);
    case "skill":
    case "skill-discover":
    case "child-agent":
      return true;
  }
}

function internetPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  approvalVerified: boolean,
): boolean {
  return (
    approvalVerified ||
    codingWorkbenchPolicyEffectFor(envelope.authority.effectiveMode, "internet", "medium") ===
      "allowed"
  );
}

function commitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
  approved: boolean,
): boolean {
  if (request.phase === "propose" || request.phase === "reconcile") return true;
  if (request.phase !== "execute") return false;
  const mode = envelope.authority.effectiveMode;
  const effect = codingWorkbenchCodeTaskDeliveryEffectFor(mode, request.intent);
  if (effect === "denied" || (!approved && effect !== "allowed")) return false;
  // Only autonomous-delivery can reach here without a per-action approval (every other mode's
  // delivery effect is always "approval-required", never "allowed", so `approved` is guaranteed
  // true above) -- that unsupervised, structural-authority-only path must keep the fuller
  // deliveryAllowed check, network egress for a draft-tool (push/PR) intent included.
  //
  // KfQ-confirmed HIGH: for every OTHER mode, this used to skip straight to `true` once a
  // per-action approval was matched, dropping the `source-control.write` connector-scope check
  // entirely. An approval proof authorizes the ACTION, never a substitute for the envelope's own
  // delivery/git-write scope -- mirrors gitPolicyAllowed's documented, unconditional approach
  // (this file, below): approved && effect-allowed && a real connector scope, every mode.
  if (mode === "autonomous-delivery") return deliveryAllowed(envelope, request.intent);
  return hasScope(envelope.authority.connectorScopes, "source-control.write");
}

/**
 * True only when the current server-resolved envelope authorizes this exact Code-task delivery
 * execute without a per-action approval. Proposal handlers use this to decide whether they can
 * expose a model-only ready disposition without opening an operator approval request.
 */
export function codingToolFullAccessDeliveryAllowed(
  authority: CodingWorkbenchAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): boolean {
  const executeRequest = { ...request, phase: "execute" } as const;
  return (
    codingWorkbenchCodeTaskDeliveryEffectFor(authority.effectiveMode, request.intent) ===
      "allowed" &&
    hasClasses(authority.actionClasses, codingToolRequiredActionClasses(executeRequest)) &&
    hasScope(authority.connectorScopes, "source-control.write") &&
    (request.intent === "commit" ||
      (authority.networkPolicy.mode !== "deny-all" &&
        hasClasses(authority.actionClasses, ["network-egress"]) &&
        hasScope(authority.networkPolicy.connectorScopes, "source-control.write")))
  );
}

function workspaceMediumRiskAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  approvalVerified: boolean,
): boolean {
  return (
    approvalVerified ||
    codingWorkbenchPolicyEffectFor(
      envelope.authority.effectiveMode,
      "workspace-contained",
      "medium",
    ) === "allowed"
  );
}

function runtimeGitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  request: Extract<CodingToolActionRequest, { readonly action: "git" }>,
  approved: boolean,
): boolean {
  if (request.operation === "ci")
    return (
      internetPolicyAllowed(envelope, approved) && connectorAllowed(envelope, "source-control.read")
    );
  if (request.operation === "read" || request.operation === "write")
    return gitPolicyAllowed(envelope, request.operation, approved);
  if (request.operation === "stage" && request.phase === "execute")
    return workspaceMediumRiskAllowed(envelope, approved);
  return true;
}

function gitPolicyAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  operation: "read" | "write",
  approved: boolean,
): boolean {
  // A raw git "write" bypasses the propose/stage review path entirely, so it carries the same
  // risk class as a delivery commit and is gated the same way commitPolicyAllowed gates
  // commit-execute: an approval proof is required unconditionally, in every mode, never merely a
  // connector scope that (per deliveryScopeGranted) is present at every mode by design.
  if (operation === "read") return true;
  const effect = codingWorkbenchPolicyEffectFor(
    envelope.authority.effectiveMode,
    "delivery",
    "high",
  );
  return (
    approved &&
    effect !== "denied" &&
    hasScope(envelope.authority.connectorScopes, "source-control.write")
  );
}

function connectorAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  scope: string,
): boolean {
  return (
    networkAllowed(envelope) &&
    hasScope(envelope.authority.connectorScopes, scope) &&
    hasScope(envelope.authority.networkPolicy.connectorScopes, scope)
  );
}

function commandAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  commandId: string,
  approvalVerified: boolean,
): boolean {
  const policy = envelope.authority.commandPolicy;
  if (
    policy.mode === "deny" ||
    (policy.requirePerCommandApproval && !approvalVerified) ||
    policy.deny.includes(commandId)
  )
    return false;
  return policy.mode !== "allowlisted" || policy.allow.includes(commandId);
}

function verifyApprovalProof(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (request.action === "delivery") return matchedCommitApproval(context, request, verifier);
  const stage = matchedStageApproval(context, request, verifier);
  if (stage !== undefined) return stage;
  // A proof is required only when the ordinary policy denies this action without one. Keeping this
  // guard inverted prevents an unrelated proof from becoming authority for an already-allowed act.
  if (additionalPolicyAllowed(envelope, request, false)) return false;
  // 3941816393 / authority-matrix-2: "git ci" and "connector" carry the same bounded-action risk
  // as command/verification and are redeemable through the exact same per-run pendingPermission
  // approval (see isApprovableToolRequest); a request whose action cannot carry a proof at all, or
  // that omits one, is rejected the same way verifier.matches already rejects a missing proof.
  if (verifier === undefined || context.runId === undefined || !isApprovableToolRequest(request)) {
    return false;
  }
  const nowMs = Date.parse(context.nowIso);
  return Number.isFinite(nowMs) && verifier.matches({ runId: context.runId, request, nowMs });
}

function matchedStageApproval(
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean | undefined {
  if (request.action === "git" && request.operation === "stage" && request.phase === "execute")
    return (
      context.runId !== undefined &&
      verifier?.matchesStage?.(context.runId, request.proposalId) === true
    );
  return undefined;
}

function matchedCommitApproval(
  context: CodingToolAuthorityContext,
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (context.runId === undefined) return false;
  return isDraftToolRequest(request)
    ? verifier?.matchesDelivery?.(context.runId, request) === true
    : verifier?.matchesCommit?.(context.runId, request) === true;
}

function consumeApprovalProof(
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  if (verifier === undefined || context.runId === undefined || !isApprovableToolRequest(request)) {
    return false;
  }
  const nowMs = Date.parse(context.nowIso);
  return Number.isFinite(nowMs) && verifier.consume({ runId: context.runId, request, nowMs });
}

function consumeMatchedApproval(
  matched: boolean,
  context: CodingToolAuthorityContext,
  request: CodingToolActionRequest,
  verifier: CodingToolApprovalProofVerifier | undefined,
): boolean {
  return matched && consumeApprovalProof(context, request, verifier);
}

function deliveryAllowed(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
  intent: Extract<CodingToolActionRequest, { readonly action: "delivery" }>["intent"],
): boolean {
  const authority = envelope.authority;
  if (!hasScope(authority.connectorScopes, "source-control.write")) return false;
  return intent === "commit"
    ? true
    : networkAllowed(envelope) &&
        hasClasses(authority.actionClasses, ["network-egress"]) &&
        hasScope(authority.networkPolicy.connectorScopes, "source-control.write");
}

function networkAllowed(envelope: CodingWorkbenchRuntimeAuthorityEnvelope): boolean {
  return envelope.authority.networkPolicy.mode !== "deny-all";
}

function hasClasses(
  actual: CodingWorkbenchRuntimeAuthorityEnvelope["authority"]["actionClasses"],
  required: readonly (typeof actual)[number][],
): boolean {
  return required.every((actionClass) => actual.includes(actionClass));
}

function hasScope(actual: readonly string[], required: string): boolean {
  return actual.includes(required);
}

// The patch bytes reserved at admission are the request's own payload: the exact bytes of a unified
// diff, or the replacement text and paths of the replacement form. For the replacement form that is
// the floor and the request-size pre-check; the materialized diff's excess is charged through the
// guard's `chargeMaterializedPatch` once it exists (#3873 review: the budget bounds what is applied).
function delegationUsage(request: CodingToolActionRequest): CodingWorkbenchRuntimeDelegationUsage {
  return {
    toolCalls: 1,
    patchBytes: request.action === "edit" ? changesetPayloadBytes(request.changeset) : 0,
    promptTokens: 0,
  };
}

function deliveryHasScopedApproval(
  request: Extract<CodingToolActionRequest, { readonly action: "delivery" }>,
): boolean {
  return request.intent === "commit" || isDraftToolRequest(request);
}

function nativeTextReadFacet(
  bridge: CanonicalCatalogFacadeBridge | undefined,
  ports: CodingToolGovernedPorts,
  options: NativeReadFacadeOptions,
  activityLog: ServerLogSink,
): CodingToolNativeTextReadFacet | undefined {
  const producer = captureNativeTextProducer(options.nativeTextRead);
  const execute = bridge?.executeTextSnapshot;
  const budget = options.ciRepairBudget;
  const maxBodyBytes = Math.min(
    options.maxBodyBytes ?? CODING_TOOL_MAX_BODY_BYTES,
    CODING_TOOL_MAX_BODY_BYTES,
  );
  if (bridge === undefined || execute === undefined || producer === undefined) return undefined;
  const invocations = nativeReadInvocations(bridge, ports, options, producer, activityLog);
  return Object.freeze({
    ...(invocations === undefined ? {} : { invocations }),
    readTextSnapshot: (input: CodingToolFacadeInput): Promise<CodingToolNativeTextSnapshotResult> =>
      readNativeTextSnapshot(
        { bridge, ports, options, activityLog, producer, budget, maxBodyBytes, execute },
        input,
      ),
  });
}

interface NativeTextSnapshotDeps {
  readonly bridge: CanonicalCatalogFacadeBridge;
  readonly ports: CodingToolGovernedPorts;
  readonly options: NativeReadFacadeOptions;
  readonly activityLog: ServerLogSink;
  readonly producer: NonNullable<CodingToolReadEditPorts["nativeTextRead"]>;
  readonly budget: CiRepairExecutionBudget | undefined;
  readonly maxBodyBytes: number;
  readonly execute: NonNullable<CanonicalCatalogFacadeBridge["executeTextSnapshot"]>;
}

async function readNativeTextSnapshot(
  deps: NativeTextSnapshotDeps,
  input: CodingToolFacadeInput,
): Promise<CodingToolNativeTextSnapshotResult> {
  let correlationId = UNKNOWN_CORRELATION_ID;
  let producerFailure: { readonly error: unknown } | undefined;
  try {
    const request = nativeSnapshotRequest(input, deps.maxBodyBytes);
    if (request === undefined) {
      deps.bridge.recordUnbound({ action: "read" }, input);
      return { ok: false, reason: "invalid-request" };
    }
    const context = deps.options.invocationContext();
    correlationId = context.correlationId ?? context.runId ?? UNKNOWN_CORRELATION_ID;
    return await dispatchNativeTextSnapshot(deps, request, input, (error): void => {
      producerFailure = { error };
      reportNativeSnapshotFailure(deps.activityLog, deps.options.catalogDiagnostics, error, {
        correlationId,
        reason: "native-producer-failed",
      });
    });
  } catch (error) {
    if (producerFailure === undefined || producerFailure.error !== error)
      reportNativeSnapshotFailure(deps.activityLog, deps.options.catalogDiagnostics, error, {
        correlationId,
        reason: "authority-resolution-failed",
      });
    return { ok: false, reason: "dispatch-refused" };
  }
}

function nativeSnapshotRequest(
  input: CodingToolFacadeInput,
  maxBodyBytes: number,
): Extract<CodingToolActionRequest, { readonly action: "read" }> | undefined {
  const request = parseCodingToolRequest(input.body, maxBodyBytes);
  return input.headers !== undefined ||
    request?.action !== "read" ||
    request.startLine !== undefined ||
    request.maxLines !== undefined
    ? undefined
    : request;
}

function captureNativeTextProducer(
  selected: CodingToolReadEditPorts["nativeTextRead"] | undefined,
): CodingToolReadEditPorts["nativeTextRead"] | undefined {
  return selected === undefined
    ? undefined
    : Object.freeze({
        readTextSnapshot: selected.readTextSnapshot.bind(selected),
      });
}

async function dispatchNativeTextSnapshot(
  deps: Pick<NativeTextSnapshotDeps, "execute" | "ports" | "producer" | "budget" | "activityLog">,
  request: Extract<CodingToolActionRequest, { readonly action: "read" }>,
  input: CodingToolFacadeInput,
  reportFailure: (error: unknown) => void,
): Promise<CodingToolNativeTextSnapshotResult> {
  const { execute, ports, producer, budget, activityLog } = deps;
  let snapshot: GovernedTextSnapshotResult | undefined;
  const delegate = createCodingToolGovernedDelegate(
    {
      ...ports,
      repositoryRead: {
        execute: async (read, signal, guard) => {
          snapshot = await readNativeSnapshotProducer(
            producer,
            read.relativePath,
            signal,
            guard,
            reportFailure,
          );
          return snapshot.ok ? { status: "completed" } : snapshotFailure(snapshot.reason);
        },
      },
    },
    budget,
    activityLog,
  );
  let delegateWork: Promise<unknown> | undefined;
  const result = await execute(request, input, (signal, guard): Promise<CodingToolResult> => {
    delegateWork = delegate.execute(request, signal, guard);
    return delegateWork.then((outcome): CodingToolResult =>
      completedSnapshotOutcome(outcome) && snapshot?.ok === true
        ? nativeSnapshotReceipt(snapshot)
        : nativeSnapshotFailureOutcome(outcome),
    );
  });
  // The catalog can cancel its response before the admitted read settles. This private facet's
  // promise owns that real work so the composition's existing drain never releases it early.
  if (delegateWork !== undefined) await delegateWork;
  if (result.status === "completed" && snapshot?.ok === true) return snapshot;
  if (snapshot?.ok === false) return snapshot;
  return { ok: false, reason: "dispatch-refused" };
}

async function readNativeSnapshotProducer(
  producer: NonNullable<CodingToolReadEditPorts["nativeTextRead"]>,
  relativePath: string,
  signal: AbortSignal | undefined,
  guard: CodingToolMutationGuard,
  reportFailure: (error: unknown) => void,
): Promise<GovernedTextSnapshotResult> {
  try {
    return await producer.readTextSnapshot(
      { relativePath, purpose: "native-tool-io" },
      signal,
      guard,
    );
  } catch (error) {
    reportFailure(error);
    throw error;
  }
}

function snapshotFailure(
  reason: Extract<GovernedTextSnapshotResult, { readonly ok: false }>["reason"],
): {
  readonly status: "failed";
  readonly reasonCode?: string;
} {
  const code = Object.entries(WORKSPACE_READ_REFUSAL_CODES).find(([key]) => key === reason)?.[1];
  let reasonCode: string | undefined = code;
  if (reason === "snapshot-unavailable") reasonCode = "native-snapshot-unavailable";
  else if (reason === "preflight-refused" || reason === "postflight-refused")
    reasonCode = "native-snapshot-refused";
  return { status: "failed", ...(reasonCode === undefined ? {} : { reasonCode }) };
}

function completedSnapshotOutcome(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    value.outcome === "completed"
  );
}

function nativeSnapshotFailureOutcome(value: unknown): CodingToolResult {
  const code =
    typeof value === "object" &&
    value !== null &&
    "reasonCode" in value &&
    typeof value.reasonCode === "string"
      ? value.reasonCode
      : "failed";
  if (code === "native-snapshot-unavailable")
    throw new CatalogDispatchFault("invalid", "unsupported-capability");
  if (code === "native-snapshot-refused") throw new CatalogDispatchFault("denied", "hard-denial");
  if (code === "ci-repair-budget-blocked")
    throw new CatalogDispatchFault("denied", "budget-exhausted");
  if (code === "ci-observation-required") throw new CatalogDispatchFault("denied", "hard-denial");
  return { status: "failed", evidence: [{ kind: "native-text-snapshot", code }] };
}

function nativeSnapshotReceipt(
  snapshot: Extract<GovernedTextSnapshotResult, { readonly ok: true }>,
): CodingToolResult {
  const result = {
    status: "completed" as const,
    evidence: [{ kind: "native-text-snapshot", code: "completed" }],
    snapshot: {
      digest: wholeFileDigest(snapshot.text),
      byteCount: snapshot.info.size,
      info: snapshot.info,
    },
  };
  return result;
}

interface NativeReadFailureContext {
  readonly correlationId: string;
  readonly reason: "authority-resolution-failed" | "native-producer-failed";
}

const DEFAULT_NATIVE_READ_FAILURE_CONTEXT: NativeReadFailureContext = Object.freeze({
  correlationId: UNKNOWN_CORRELATION_ID,
  reason: "authority-resolution-failed",
});

type NativeReadFailureReporter = (error: unknown, producerFailure?: boolean) => void;

function reportNativeSnapshotFailure(
  activityLog: ServerLogSink,
  diagnostics: ServerDiagnosticSink | undefined,
  error: unknown,
  context: NativeReadFailureContext = DEFAULT_NATIVE_READ_FAILURE_CONTEXT,
): void {
  activityLog.write(
    activityLogEvent(
      CODING_RUNTIME_TOOL_RESULT_OPERATION,
      {
        correlationId: context.correlationId,
        level: "warn",
        errorKind: "unavailable",
      },
      {
        actionKind: "read",
        state: "discarded",
        reason: context.reason,
        frames: keikoStackFrames(error),
        causeChain: causeChain(error),
      },
    ),
  );
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: context.correlationId,
      operation: "coding-runtime.tool-result",
      source: "coding-runtime.native-text-snapshot",
      error,
      redact: () =>
        context.reason === "native-producer-failed"
          ? "native-snapshot-producer-unavailable"
          : "native-snapshot-authority-unavailable",
    }),
  );
}

interface NativeReadFacadeOptions extends RuntimeCodingToolFacadeOptions {
  readonly invocationContext: CodingToolAuthorityContextProvider;
}

interface NativeReadLifetime {
  readonly work: Promise<GovernedCodingToolResult>;
  readonly owner: CodingToolNativeReadOwner;
}

interface NativeReadBeginDeps {
  readonly bridge: CanonicalCatalogFacadeBridge;
  readonly execute: NonNullable<CanonicalCatalogFacadeBridge["executeNativeReadInvocation"]>;
  readonly registry: ReturnType<typeof createCodingToolInvocationRegistry>;
  readonly ports: CodingToolGovernedPorts;
  readonly options: NativeReadFacadeOptions;
  readonly producer: NonNullable<CodingToolReadEditPorts["nativeTextRead"]>;
  readonly fileIO: GovernedNativeFileIO | undefined;
  readonly log: ServerLogSink;
  readonly reportFailure: (error: unknown, context?: NativeReadFailureContext) => void;
}

function nativeReadInvocations(
  bridge: CanonicalCatalogFacadeBridge,
  ports: CodingToolGovernedPorts,
  options: NativeReadFacadeOptions,
  producer: CodingToolReadEditPorts["nativeTextRead"],
  log: ServerLogSink,
): CodingToolNativeReadInvocations | undefined {
  const execute = bridge.executeNativeReadInvocation;
  const registry = options.invocationRegistry;
  if (execute === undefined || registry === undefined) return undefined;
  const reportFailure = (error: unknown, context?: NativeReadFailureContext): void => {
    reportNativeSnapshotFailure(log, options.catalogDiagnostics, error, context);
  };
  const fileIO = captureNativeFileProducer(options.nativeFileIO);
  const deps = { bridge, execute, registry, ports, options, producer, fileIO, log, reportFailure };
  return Object.freeze({
    ...(fileIO === undefined ? {} : { fileIO: nativeInvocationFileIO(deps) }),
    signalFor: (identity: CodingToolNativeReadIdentity): AbortSignal | undefined =>
      nativeReadOwnerFor(deps, identity)?.signal,
    begin: (input: CodingToolNativeReadBeginInput): Promise<CodingToolNativeReadBeginResult> =>
      beginNativeReadInvocation(deps, input),
    readTextSnapshot: (identity, input): Promise<CodingToolNativeTextSnapshotResult> =>
      readNativeInvocationSnapshot(deps, identity, input),
    close: (identity, outcome): Promise<boolean> => {
      if (!nativeReadOutcome(outcome)) return Promise.resolve(false);
      return nativeReadOwnerFor(deps, identity)?.close(outcome) ?? Promise.resolve(false);
    },
  } satisfies CodingToolNativeReadInvocations);
}

function captureNativeFileProducer(
  selected: GovernedNativeFileIO | undefined,
): GovernedNativeFileIO | undefined {
  return selected === undefined
    ? undefined
    : Object.freeze({
        readBytes: selected.readBytes.bind(selected),
        stat: selected.stat.bind(selected),
        list: selected.list.bind(selected),
      });
}

function nativeInvocationFileIO(deps: NativeReadBeginDeps): CodingToolNativeReadFileIO {
  return Object.freeze({
    readBytes: (identity, input) =>
      executeNativeInvocationFile(deps, identity, input, "readBytes", (owner, request) =>
        owner.fileIO?.readBytes(request),
      ),
    stat: (identity, input) =>
      executeNativeInvocationFile(deps, identity, input, "stat", (owner, request) =>
        owner.fileIO?.stat(request),
      ),
    list: (identity, input) =>
      executeNativeInvocationFile(deps, identity, input, "list", (owner, request) =>
        owner.fileIO?.list(request),
      ),
  } satisfies CodingToolNativeReadFileIO);
}

async function executeNativeInvocationFile<Result>(
  deps: NativeReadBeginDeps,
  identity: CodingToolNativeReadIdentity,
  input: CodingToolNativeReadFilePacket,
  operation: keyof GovernedNativeFileIO,
  invoke: (
    owner: CodingToolNativeReadOwner,
    request: GovernedNativeFileRequest,
  ) => Promise<Result> | undefined,
): Promise<Result | CodingToolNativeInvocationRefusal> {
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    const packet = captureNativeFilePacket(input, operation);
    const bound = nativeReadRegistryIdentity(deps.options, identity);
    if (packet === undefined || bound === undefined)
      return { ok: false, reason: "invalid-request" };
    correlationId = bound.correlationId;
    const digest = createHash("sha256")
      .update(
        JSON.stringify([operation, packet.relativePath, packet.purpose, packet.range ?? null]),
      )
      .digest("hex");
    const claim = deps.registry.claimNativeReadOperation(
      bound,
      bound.invocationId,
      packet.ordinal,
      digest,
    );
    if (claim !== "ready") return refuseNativeReadPacket(deps, bound.runId, claim);
    const owner = deps.registry.nativeReadOwner(bound, bound.invocationId);
    return (
      (owner === undefined ? undefined : await invoke(owner, packet)) ?? {
        ok: false,
        reason: "dispatch-refused",
      }
    );
  } catch (error) {
    reportNativeSnapshotFailure(deps.log, deps.options.catalogDiagnostics, error, {
      correlationId,
      reason: "authority-resolution-failed",
    });
    return { ok: false, reason: "dispatch-refused" };
  }
}

function captureNativeFilePacket(
  input: CodingToolNativeReadFilePacket,
  operation: keyof GovernedNativeFileIO,
): CodingToolNativeReadFilePacket | undefined {
  const record = nativeDataRecord(input, ["ordinal", "relativePath", "purpose", "range"]);
  if (!nativeFilePacketHead(record)) return undefined;
  const range = captureNativeRange(record.range);
  if (range === false || (operation !== "readBytes" && range !== undefined)) return undefined;
  return Object.freeze({
    ordinal: record.ordinal,
    relativePath: record.relativePath,
    purpose: record.purpose,
    ...(range === undefined ? {} : { range }),
  });
}

function nativeFilePacketHead(
  record: Readonly<Record<string, unknown>> | undefined,
): record is Readonly<{
  ordinal: number;
  relativePath: string;
  purpose: "native-tool-io" | "native-instructions";
  range?: unknown;
}> {
  if (record === undefined || typeof record.ordinal !== "number") return false;
  if (typeof record.relativePath !== "string") return false;
  return (
    isSecureWorkspaceNativeRelativePath(record.relativePath) &&
    !isDenied(record.relativePath) &&
    (record.purpose === "native-tool-io" || record.purpose === "native-instructions")
  );
}

function captureNativeRange(input: unknown): GovernedNativeFileRequest["range"] | false {
  if (input === undefined) return undefined;
  const record = nativeDataRecord(input, ["offset", "length"]);
  if (typeof record?.offset !== "number" || typeof record.length !== "number") return false;
  const range = Object.freeze({ offset: record.offset, length: record.length });
  return isSecureWorkspaceNativeRange(range) ? range : false;
}

function nativeReadOwnerFor(
  deps: NativeReadBeginDeps,
  identity: CodingToolNativeReadIdentity,
): CodingToolNativeReadOwner | undefined {
  try {
    const bound = nativeReadRegistryIdentity(deps.options, identity);
    return bound === undefined
      ? undefined
      : deps.registry.nativeReadOwner(bound, bound.invocationId);
  } catch (error) {
    reportNativeSnapshotFailure(deps.log, deps.options.catalogDiagnostics, error);
    return undefined;
  }
}

function nativeReadRegistryIdentity(
  options: NativeReadFacadeOptions,
  identity: CodingToolNativeReadIdentity,
):
  | {
      readonly runId: string;
      readonly correlationId: string;
      readonly actionId: string;
      readonly idempotencyKey: string;
      readonly invocationId: string;
    }
  | undefined {
  const captured = nativeStringRecord(identity, ["actionId", "idempotencyKey", "invocationId"]);
  if (captured === undefined) return undefined;
  // The run binding comes from the same actual authority context that produced this facade.
  const context = options.invocationContext();
  const runId = context.runId;
  return runId === undefined
    ? undefined
    : { runId, correlationId: context.correlationId ?? runId, ...captured };
}

async function readNativeInvocationSnapshot(
  deps: NativeReadBeginDeps,
  identity: CodingToolNativeReadIdentity,
  input: { readonly ordinal: number; readonly relativePath: string },
): Promise<CodingToolNativeTextSnapshotResult> {
  let correlationId = UNKNOWN_CORRELATION_ID;
  try {
    const packet = nativeDataRecord(input, ["ordinal", "relativePath"]);
    const bound = nativeReadRegistryIdentity(deps.options, identity);
    if (packet === undefined || bound === undefined || typeof packet.relativePath !== "string")
      return { ok: false, reason: "invalid-request" };
    if (typeof packet.ordinal !== "number" || !nativeReadPacketPath(packet.relativePath))
      return { ok: false, reason: "invalid-request" };
    correlationId = bound.correlationId;
    const digest = createHash("sha256")
      .update(JSON.stringify(["read-text-snapshot", packet.relativePath]))
      .digest("hex");
    const claim = deps.registry.claimNativeReadOperation(
      bound,
      bound.invocationId,
      packet.ordinal,
      digest,
    );
    if (claim !== "ready") return refuseNativeReadPacket(deps, bound.runId, claim);
    return (
      (await deps.registry
        .nativeReadOwner(bound, bound.invocationId)
        ?.readTextSnapshot(packet.relativePath)) ?? { ok: false, reason: "dispatch-refused" }
    );
  } catch (error) {
    reportNativeSnapshotFailure(deps.log, deps.options.catalogDiagnostics, error, {
      correlationId,
      reason: "authority-resolution-failed",
    });
    return { ok: false, reason: "dispatch-refused" };
  }
}

function refuseNativeReadPacket(
  deps: NativeReadBeginDeps,
  runId: string,
  claim: "duplicate" | "conflict" | "refused" | "busy",
): CodingToolNativeInvocationRefusal {
  deps.log.write(
    activityLogEvent(
      CODING_RUNTIME_TOOL_RESULT_OPERATION,
      {
        correlationId: runId,
        level: "warn",
        errorKind: claim === "busy" ? "unavailable" : "authority-denied",
      },
      {
        actionKind: "read",
        state: "discarded",
        reason: claim === "busy" ? "unavailable" : "denied",
      },
    ),
  );
  return { ok: false, reason: claim === "busy" ? "busy" : "dispatch-refused" };
}

function nativeReadPacketPath(relativePath: string): boolean {
  if (relativePath.length > 512) return false;
  return (
    parseCodingToolRequest(
      JSON.stringify({
        action: "read",
        actionId: "native-read-packet",
        idempotencyKey: "native-read-packet",
        relativePath,
      }),
      CODING_TOOL_MAX_BODY_BYTES,
    )?.action === "read"
  );
}

async function beginNativeReadInvocation(
  deps: NativeReadBeginDeps,
  input: CodingToolNativeReadBeginInput,
): Promise<CodingToolNativeReadBeginResult> {
  try {
    return await admitNativeReadInvocation(deps, input);
  } catch (error) {
    reportNativeSnapshotFailure(deps.log, deps.options.catalogDiagnostics, error);
    return { ok: false, reason: "dispatch-refused" };
  }
}

function admitNativeReadInvocation(
  deps: NativeReadBeginDeps,
  input: CodingToolNativeReadBeginInput,
): Promise<CodingToolNativeReadBeginResult> {
  const owned = captureNativeReadBegin(input);
  const maxBytes = Math.min(
    deps.options.maxBodyBytes ?? CODING_TOOL_MAX_BODY_BYTES,
    CODING_TOOL_MAX_BODY_BYTES,
  );
  const request =
    owned === undefined || Buffer.byteLength(owned.body) > maxBytes
      ? undefined
      : nativeReadInvocationRequest(owned.body);
  if (owned === undefined || request === undefined) {
    deps.bridge.recordUnbound({ action: "read" }, input);
    return Promise.resolve({ ok: false, reason: "invalid-request" });
  }
  let ready!: (result: CodingToolNativeReadBeginResult) => void;
  const started = new Promise<CodingToolNativeReadBeginResult>((resolve) => {
    ready = resolve;
  });
  let complete!: (passed: boolean) => void;
  const terminal = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  const dispatch = deps.execute(
    request,
    owned,
    (signal, guard, invocationId): Promise<CodingToolResult> =>
      dispatchNativeReadInvocation(deps, request, signal, guard, invocationId, ready, terminal),
  );
  void dispatch.then(
    (result): void => {
      complete(result.status === "completed");
      ready({ ok: false, reason: "dispatch-refused" });
    },
    (error: unknown): void => {
      deps.reportFailure(error);
      complete(false);
      ready({ ok: false, reason: "dispatch-refused" });
    },
  );
  return started;
}

function parseNativeReadJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function nativeReadInvocationRequest(
  body: string,
): Extract<CodingToolActionRequest, { readonly action: "read" }> | undefined {
  const record = nativeDataRecord(parseNativeReadJson(body), [
    "action",
    "actionId",
    "idempotencyKey",
    "relativePath",
  ]);
  if (
    record === undefined ||
    Object.keys(record).length !== 4 ||
    record.action !== "read" ||
    !nativeReadIdentityString(record.actionId) ||
    !nativeReadIdentityString(record.idempotencyKey) ||
    typeof record.relativePath !== "string" ||
    !isSecureWorkspaceNativeRelativePath(record.relativePath) ||
    isDenied(record.relativePath)
  )
    return undefined;
  return {
    action: "read",
    actionId: record.actionId,
    idempotencyKey: record.idempotencyKey,
    relativePath: record.relativePath,
  };
}

function nativeReadIdentityString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}

function dispatchNativeReadInvocation(
  deps: NativeReadBeginDeps,
  request: Extract<CodingToolActionRequest, { readonly action: "read" }>,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  invocationId: string,
  ready: (result: CodingToolNativeReadBeginResult) => void,
  terminal: Promise<boolean>,
): Promise<CodingToolResult> {
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delegate = createCodingToolGovernedDelegate(
    {
      ...deps.ports,
      repositoryRead: {
        execute: (_read, childSignal, childGuard): Promise<GovernedCodingToolResult> => {
          return attachNativeReadLifetime(
            deps,
            request,
            childSignal ?? signal,
            childGuard,
            invocationId,
            { ready, settled, terminal },
          );
        },
      },
    },
    deps.options.ciRepairBudget,
    deps.log,
  );
  const work = delegate.execute(request, signal, guard);
  void work.then(release, release);
  return work.then((value): CodingToolResult =>
    completedSnapshotOutcome(value)
      ? { status: "completed", evidence: [{ kind: "native-read-invocation", code: "completed" }] }
      : nativeSnapshotFailureOutcome(value),
  );
}

interface NativeReadAttachmentCompletion {
  readonly ready: (result: CodingToolNativeReadBeginResult) => void;
  readonly settled: Promise<void>;
  readonly terminal: Promise<boolean>;
}

function attachNativeReadLifetime(
  deps: NativeReadBeginDeps,
  request: Extract<CodingToolActionRequest, { readonly action: "read" }>,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  invocationId: string,
  completion: NativeReadAttachmentCompletion,
): Promise<GovernedCodingToolResult> {
  const { ready, settled, terminal } = completion;
  const identity = Object.freeze({
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    invocationId,
  });
  const bound = nativeReadRegistryIdentity(deps.options, identity);
  const reportFailure: NativeReadFailureReporter = (error, producerFailure): void => {
    deps.reportFailure(error, {
      correlationId: bound?.correlationId ?? UNKNOWN_CORRELATION_ID,
      reason: producerFailure === true ? "native-producer-failed" : "authority-resolution-failed",
    });
  };
  const lifetime = nativeReadLifetime(invocationId, signal, guard, deps, reportFailure, terminal);
  if (bound === undefined || !deps.registry.attachNativeRead(bound, lifetime.owner)) {
    lifetime.owner.revoke();
    ready({ ok: false, reason: "dispatch-refused" });
  } else ready({ ok: true, identity, settled });
  return lifetime.work;
}

function nativeDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const allowed = new Set(keys);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function nativeStringRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], string>> | undefined {
  const record = nativeDataRecord(value, keys);
  if (record === undefined || Object.keys(record).length !== keys.length) return undefined;
  if (!keys.every((key) => nativeReadIdentityString(record[key]))) return undefined;
  return record as Readonly<Record<Keys[number], string>>;
}

function captureNativeReadBegin(
  input: CodingToolNativeReadBeginInput,
): (CodingToolNativeReadBeginInput & { readonly body: string }) | undefined {
  const record = nativeDataRecord(input, [
    "body",
    "capability",
    "headers",
    "signal",
    "context",
    "offset",
    "limit",
  ]);
  if (record === undefined || record.headers !== undefined) return undefined;
  const { body, capability, signal, offset, limit } = record;
  const context = nativeStringRecord(record.context, ["sessionID", "messageID", "id", "agent"]);
  if (context === undefined || !nativeReadBeginValues(body, capability, signal, offset, limit))
    return undefined;
  return {
    body: typeof body === "string" ? body : (body as Buffer).toString("utf8"),
    capability: capability as string | undefined,
    signal: signal as AbortSignal | undefined,
    context,
    ...(offset === undefined ? {} : { offset: offset as number }),
    ...(limit === undefined ? {} : { limit: limit as number }),
  };
}

function nativeReadBeginValues(
  body: unknown,
  capability: unknown,
  signal: unknown,
  offset: unknown,
  limit: unknown,
): boolean {
  return (
    (typeof body === "string" || Buffer.isBuffer(body)) &&
    Buffer.byteLength(body) <= CODING_TOOL_MAX_BODY_BYTES &&
    (capability === undefined || typeof capability === "string") &&
    (signal === undefined || signal instanceof AbortSignal) &&
    optionalNativeInteger(offset, 0) &&
    validNativeReadLimit(limit)
  );
}

function validNativeReadLimit(value: unknown): boolean {
  return optionalNativeInteger(value, 0) && (value === undefined || Number(value) <= 2_000);
}

function optionalNativeInteger(value: unknown, minimum: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum)
  );
}

function nativeReadOutcome(value: unknown): value is "completed" | "failed" | "cancelled" {
  return value === "completed" || value === "failed" || value === "cancelled";
}

interface NativeReadLifetimeState {
  closed: boolean;
  pending: number;
  outcome: "completed" | "failed" | "cancelled";
}

function nativeReadLifetime(
  invocationId: string,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  producers: Pick<NativeReadBeginDeps, "producer" | "fileIO">,
  failure: NativeReadFailureReporter,
  terminal: Promise<boolean>,
): NativeReadLifetime {
  const state: NativeReadLifetimeState = { closed: false, pending: 0, outcome: "cancelled" };
  const { work, resolve } = nativeReadCompletion();
  const finish = (): void => {
    if (!state.closed || state.pending !== 0) return;
    signal.removeEventListener("abort", abort);
    let passed = false;
    try {
      passed = state.outcome === "completed" && nativeReadLive(signal, guard, failure);
    } finally {
      resolve({ status: passed ? "completed" : "failed" });
    }
  };
  const close = (outcome: NativeReadLifetimeState["outcome"]): Promise<boolean> => {
    if (!state.closed) {
      state.closed = true;
      state.outcome = outcome;
    }
    finish();
    return terminal;
  };
  const abort = (): void => {
    void close("cancelled");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    work,
    owner: nativeReadLifetimeOwner(invocationId, signal, guard, producers, failure, {
      state,
      close,
      abort,
      finish,
    }),
  };
}

function nativeReadCompletion(): {
  readonly work: Promise<GovernedCodingToolResult>;
  readonly resolve: (result: GovernedCodingToolResult) => void;
} {
  let resolve!: (result: GovernedCodingToolResult) => void;
  const work = new Promise<GovernedCodingToolResult>((done) => {
    resolve = done;
  });
  return { work, resolve };
}

interface NativeReadLifetimeControl {
  readonly state: NativeReadLifetimeState;
  readonly close: CodingToolNativeReadOwner["close"];
  readonly abort: () => void;
  readonly finish: () => void;
}

function nativeReadLifetimeOwner(
  invocationId: string,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  producers: Pick<NativeReadBeginDeps, "producer" | "fileIO">,
  failure: NativeReadFailureReporter,
  control: NativeReadLifetimeControl,
): CodingToolNativeReadOwner {
  const { state, close, abort, finish } = control;
  return Object.freeze({
    invocationId,
    signal,
    revoke: abort,
    close,
    ...(producers.fileIO === undefined
      ? {}
      : {
          fileIO: nativeLifetimeFileIO(state, signal, guard, producers.fileIO, finish, failure),
        }),
    readTextSnapshot: (relativePath: string): Promise<CodingToolNativeTextSnapshotResult> =>
      nativeLifetimeSnapshot(
        state,
        signal,
        guard,
        producers.producer,
        relativePath,
        finish,
        failure,
      ),
  });
}

function nativeReadLive(
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  reportFailure: NativeReadFailureReporter,
): boolean {
  try {
    return !signal.aborted && guard.check();
  } catch (error) {
    reportFailure(error);
    return false;
  }
}

function nativeReadOpen(
  state: NativeReadLifetimeState,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  failure: NativeReadFailureReporter,
): boolean {
  return !state.closed && nativeReadLive(signal, guard, failure);
}

function nativeLifetimeFileIO(
  state: NativeReadLifetimeState,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  producer: GovernedNativeFileIO,
  finish: () => void,
  failure: NativeReadFailureReporter,
): CodingToolNativeReadFileIOOwner {
  return Object.freeze({
    readBytes: (request) =>
      nativeLifetimeFile(
        state,
        signal,
        guard,
        () => producer.readBytes(request, signal, guard),
        finish,
        failure,
      ),
    stat: (request) =>
      nativeLifetimeFile(
        state,
        signal,
        guard,
        () => producer.stat(request, signal, guard),
        finish,
        failure,
      ),
    list: (request) =>
      nativeLifetimeFile(
        state,
        signal,
        guard,
        () => producer.list(request, signal, guard),
        finish,
        failure,
      ),
  } satisfies CodingToolNativeReadFileIOOwner);
}

async function nativeLifetimeFile<
  Result extends
    | CodingToolNativeReadBytesResult
    | CodingToolNativeReadStatResult
    | CodingToolNativeReadListResult,
>(
  state: NativeReadLifetimeState,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  invoke: () => Promise<Result>,
  finish: () => void,
  reportFailure: NativeReadFailureReporter,
): Promise<Result | CodingToolNativeInvocationRefusal> {
  if (!nativeReadOpen(state, signal, guard, reportFailure))
    return { ok: false, reason: "dispatch-refused" };
  state.pending++;
  try {
    const result = await invoke();
    if (nativeReadOpen(state, signal, guard, reportFailure)) return result;
    if (result.ok && "bytes" in result) result.bytes.fill(0);
    return { ok: false, reason: "dispatch-refused" };
  } catch (error) {
    reportFailure(error, true);
    return { ok: false, reason: "dispatch-refused" };
  } finally {
    state.pending--;
    finish();
  }
}

async function nativeLifetimeSnapshot(
  state: NativeReadLifetimeState,
  signal: AbortSignal,
  guard: CodingToolMutationGuard,
  producer: NonNullable<CodingToolReadEditPorts["nativeTextRead"]>,
  relativePath: string,
  finish: () => void,
  reportFailure: NativeReadFailureReporter,
): Promise<CodingToolNativeTextSnapshotResult> {
  if (!nativeReadOpen(state, signal, guard, reportFailure))
    return { ok: false, reason: "dispatch-refused" };
  state.pending++;
  try {
    const result = await producer.readTextSnapshot(
      { relativePath, purpose: "native-tool-io" },
      signal,
      guard,
    );
    return !nativeReadOpen(state, signal, guard, reportFailure)
      ? { ok: false, reason: "dispatch-refused" }
      : result;
  } catch (error) {
    reportFailure(error, true);
    return { ok: false, reason: "dispatch-refused" };
  } finally {
    state.pending--;
    finish();
  }
}
