import type { OpenCodeToolProfile } from "./opencodeToolSchemas.js";
import { createHash } from "node:crypto";

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
  CodingToolProducerBinding,
  MaterializedPatchCharge,
} from "./codingToolFacadePorts.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import { changesetPayloadBytes } from "./codingToolReplacementEdits.js";
import {
  createCodingToolGovernedDelegate,
  type CodingToolGovernedPorts,
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
} from "./codingToolReadEditPorts.js";
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
  const authorityPort = createCodingToolAuthorityPort(authority, context, {
    approvalProofVerifier: configuration.approvalProofVerifier,
    activityLog,
    requireProducerBinding: true,
    reserveEditDelegation: configuration.reserveEditDelegation === true,
  });
  const catalogBridge =
    configuration.disableCatalogBridge === true
      ? undefined
      : catalogFacadeBridgeFor(authority, authorityPort, context, configuration, activityLog);
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
    configuration,
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
  options: RuntimeCodingToolFacadeOptions,
  activityLog: ServerLogSink,
): CodingToolNativeTextReadFacet | undefined {
  const producer = options.nativeTextRead;
  const execute = bridge?.executeTextSnapshot;
  const budget = options.ciRepairBudget;
  const maxBodyBytes = Math.min(
    options.maxBodyBytes ?? CODING_TOOL_MAX_BODY_BYTES,
    CODING_TOOL_MAX_BODY_BYTES,
  );
  if (bridge === undefined || execute === undefined || producer === undefined) return undefined;
  return Object.freeze({
    readTextSnapshot: async (
      input: CodingToolFacadeInput,
    ): Promise<CodingToolNativeTextSnapshotResult> => {
      try {
        const request = parseCodingToolRequest(input.body, maxBodyBytes);
        if (
          input.headers !== undefined ||
          request?.action !== "read" ||
          request.startLine !== undefined ||
          request.maxLines !== undefined
        ) {
          bridge.recordUnbound({ action: "read" }, input);
          return { ok: false, reason: "invalid-request" };
        }
        return await dispatchNativeTextSnapshot(
          request,
          input,
          execute,
          ports,
          producer,
          budget,
          activityLog,
        );
      } catch (error) {
        reportNativeSnapshotFailure(activityLog, options.catalogDiagnostics, error);
        return { ok: false, reason: "dispatch-refused" };
      }
    },
  });
}

async function dispatchNativeTextSnapshot(
  request: Extract<CodingToolActionRequest, { readonly action: "read" }>,
  input: CodingToolFacadeInput,
  execute: NonNullable<CanonicalCatalogFacadeBridge["executeTextSnapshot"]>,
  ports: CodingToolGovernedPorts,
  producer: CodingToolReadEditPorts["nativeTextRead"],
  budget: CiRepairExecutionBudget | undefined,
  activityLog: ServerLogSink,
): Promise<CodingToolNativeTextSnapshotResult> {
  let snapshot: GovernedTextSnapshotResult | undefined;
  const delegate = createCodingToolGovernedDelegate(
    {
      ...ports,
      repositoryRead: {
        execute: async (read, signal, guard) => {
          snapshot = await producer.readTextSnapshot(
            { relativePath: read.relativePath, purpose: "native-tool-io" },
            signal,
            guard,
          );
          return snapshot.ok ? { status: "completed" } : snapshotFailure(snapshot.reason);
        },
      },
    },
    budget,
    activityLog,
  );
  const result = await execute(request, input, async (signal, guard): Promise<CodingToolResult> => {
    const outcome = await delegate.execute(request, signal, guard);
    return completedSnapshotOutcome(outcome) && snapshot?.ok === true
      ? nativeSnapshotReceipt(snapshot)
      : nativeSnapshotFailureOutcome(outcome);
  });
  if (result.status === "completed" && snapshot?.ok === true) return snapshot;
  if (snapshot?.ok === false) return snapshot;
  return { ok: false, reason: "dispatch-refused" };
}

function snapshotFailure(
  reason: Extract<GovernedTextSnapshotResult, { readonly ok: false }>["reason"],
): {
  readonly status: "failed";
  readonly reasonCode?: string;
} {
  const code = Object.entries(WORKSPACE_READ_REFUSAL_CODES).find(([key]) => key === reason)?.[1];
  const reasonCode =
    reason === "snapshot-unavailable"
      ? "native-snapshot-unavailable"
      : reason === "preflight-refused" || reason === "postflight-refused"
        ? "native-snapshot-refused"
        : code;
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

function reportNativeSnapshotFailure(
  activityLog: ServerLogSink,
  diagnostics: ServerDiagnosticSink | undefined,
  error: unknown,
): void {
  activityLog.write(
    activityLogEvent(
      CODING_RUNTIME_TOOL_RESULT_OPERATION,
      {
        correlationId: UNKNOWN_CORRELATION_ID,
        level: "warn",
        errorKind: "unavailable",
      },
      {
        actionKind: "read",
        state: "discarded",
        reason: "authority-resolution-failed",
        frames: keikoStackFrames(error),
        causeChain: causeChain(error),
      },
    ),
  );
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: UNKNOWN_CORRELATION_ID,
      operation: "coding-runtime.tool-result",
      source: "coding-runtime.native-text-snapshot",
      error,
      redact: () => "native-snapshot-authority-unavailable",
    }),
  );
}
