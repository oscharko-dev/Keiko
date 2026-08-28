import { createHash } from "node:crypto";
import type {
  CodingWorkbenchApprovalRisk,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchMode,
  CodingWorkbenchPolicyEffect,
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  codingWorkbenchPolicyEffectFor,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { estimateTokensForSegments } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { validateCodingWorkbenchAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { GatewayRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import type { AppSession } from "./coding-app-session/sessionRegistry.js";
import {
  editorAgentAuthorityRegistry,
  editorAgentWorkspaceRootDigest,
  type EditorAgentAuthorityFailureReason,
} from "./editor/agentAuthorityRegistry.js";
import type { RunKind } from "./run-request.js";

const AGENT_RUN_AUTHORITY_LIFETIME_MS = 30 * 60 * 1_000;
const AGENT_RUN_BUDGET_CAPABILITY_POLICY_VERSION = "1";
const AGENT_RUN_AUTHORITY_CAPABILITIES = {
  runtimeSource: "keiko-sidecar",
  actionClasses: ["workspace-read", "workspace-write", "verification"],
  connectorScopes: [],
  modelProfile: {
    profileId: "local-model",
    source: "keiko-model-gateway",
    supportsStreaming: true,
    supportsToolCalling: true,
  },
  commandPolicy: {
    mode: "deny",
    allow: [],
    deny: [],
    maxCommandTimeoutMs: 1,
    requirePerCommandApproval: true,
  },
  networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
  gates: ["human-approval", "artifact-review"],
  budget: {
    maxRuntimeMs: AGENT_RUN_AUTHORITY_LIFETIME_MS,
    maxToolCalls: 4,
    maxPromptTokens: 128_000,
    maxPatchBytes: 65_536,
  },
} as const;

type GovernedAgentRunKind = Extract<RunKind, "unit-tests" | "bug-investigation">;

export interface AgentRunGovernanceBinding {
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly sessionId: string;
  readonly sessionRotationCount: number;
  readonly mutationRisk: CodingWorkbenchApprovalRisk;
  readonly connectorExecution: "unavailable";
  readonly deliveryExecution: "unavailable";
}

export interface AgentRunGovernanceFingerprintProjection {
  readonly budgetCapabilityPolicyVersion: string;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly effectiveMode: CodingWorkbenchMode;
  readonly connectorExecution: "unavailable";
  readonly deliveryExecution: "unavailable";
}

export interface CreateAgentRunGovernanceInput {
  readonly runId: string;
  readonly workflow: GovernedAgentRunKind;
  readonly workspaceRoot: string;
  readonly modelId: string;
  readonly requestedMode: CodingWorkbenchMode;
  readonly deploymentCeiling: CodingWorkbenchMode;
  readonly session: AppSession;
  readonly nowIso: string;
}

export type CreateAgentRunGovernanceResult =
  | { readonly ok: true; readonly binding: AgentRunGovernanceBinding }
  | {
      readonly ok: false;
      readonly reason: "authority-invalid" | "authority-expired" | "authority-revoked";
    };

export type AgentRunMutationAuthorization =
  | { readonly ok: true; readonly effect: CodingWorkbenchPolicyEffect }
  | {
      readonly ok: false;
      readonly reason:
        "session-invalid" | "authority-invalid" | "authority-expired" | "authority-revoked";
    };

export type AgentRunBudgetReservation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        "authority-invalid" | "authority-expired" | "authority-revoked" | "budget-exceeded";
    };

interface AgentRunBudgetedPortInput {
  readonly binding: AgentRunGovernanceBinding;
  readonly workspaceRoot: string;
  readonly nowIso: () => string;
}

interface AgentRunBudgetedModelPortInput extends AgentRunBudgetedPortInput {
  readonly model: ModelPort;
}

interface AgentRunBudgetedSpawnInput extends AgentRunBudgetedPortInput {
  readonly spawn: SpawnFn;
}

export class AgentRunBudgetExhaustedError extends Error {
  constructor() {
    super("Agent run budget exhausted.");
    this.name = "AgentRunBudgetExhaustedError";
  }
}

export function agentRunSessionMatches(
  binding: AgentRunGovernanceBinding,
  session: AppSession,
): boolean {
  return (
    binding.sessionId === session.sessionId &&
    binding.sessionRotationCount === session.rotationCount
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceSafeRunId(runId: string): string {
  const hexadecimalDigest = `0x${digest(runId)}`;
  return `run-${BigInt(hexadecimalDigest).toString(10)}`;
}

function envelopeFor(input: CreateAgentRunGovernanceInput): CodingWorkbenchAuthorityEnvelope {
  const effectiveMode = resolveEffectiveCodingWorkbenchMode(
    input.requestedMode,
    input.deploymentCeiling,
  );
  const expiresAt = new Date(
    Date.parse(input.nowIso) + AGENT_RUN_AUTHORITY_LIFETIME_MS,
  ).toISOString();
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    // The UI run id is a raw UUID and therefore intentionally fails the evidence-safe Authority
    // contract. Bind the private record to a decimal SHA-256 projection instead; numeric segments
    // are content-free contract vocabulary and the raw id never enters the envelope or evidence.
    runId: evidenceSafeRunId(input.runId),
    localUser: "local-operator",
    taskRefs: ["workflow-run"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest: editorAgentWorkspaceRootDigest(input.workspaceRoot),
    },
    branch: {
      baseRef: "local-workspace",
      headRef: "local-workspace",
      allowDetachedHead: false,
      allowedPrefixes: ["local-"],
    },
    requestedMode: input.requestedMode,
    deploymentCeiling: input.deploymentCeiling,
    effectiveMode,
    ...AGENT_RUN_AUTHORITY_CAPABILITIES,
    expiresAt,
    approvalProofDigest: digest(
      [
        input.runId,
        input.session.sessionId,
        String(input.session.rotationCount),
        input.requestedMode,
        effectiveMode,
        input.workflow,
        input.modelId,
      ].join("\u0000"),
    ),
  };
}

function mutationRisk(workflow: GovernedAgentRunKind): CodingWorkbenchApprovalRisk {
  return workflow === "unit-tests" ? "medium" : "high";
}

// Shared base mapping for every agent-run governance producer that surfaces a registry failure
// reason (#2906 round-3 review, KEIKO-0532 sibling finding): a revoked authority previously
// collapsed into the same generic "authority-invalid" bucket as a genuinely malformed envelope in
// createAgentRunGovernance, authorizeAgentRunMutation, and agentRunBudgetFailureReason alike. One
// shared mapping keeps all three producers in sync instead of three independently hand-maintained
// copies of the same expired/revoked/invalid triage.
function authorityFailureReason(
  reason: EditorAgentAuthorityFailureReason,
): "authority-invalid" | "authority-expired" | "authority-revoked" {
  if (reason === "expired") return "authority-expired";
  if (reason === "revoked") return "authority-revoked";
  return "authority-invalid";
}

export function createAgentRunGovernance(
  input: CreateAgentRunGovernanceInput,
): CreateAgentRunGovernanceResult {
  if (Number.isNaN(Date.parse(input.nowIso))) return { ok: false, reason: "authority-invalid" };
  const envelope = envelopeFor(input);
  const validated = validateCodingWorkbenchAuthorityEnvelope(envelope);
  if (!validated.ok) return { ok: false, reason: "authority-invalid" };
  const registration = editorAgentAuthorityRegistry.register(
    envelope,
    input.deploymentCeiling,
    input.nowIso,
  );
  if (!registration.ok) {
    return { ok: false, reason: authorityFailureReason(registration.reason) };
  }
  return {
    ok: true,
    binding: {
      authorityRef: registration.authorityRef,
      requestedMode: input.requestedMode,
      deploymentCeiling: input.deploymentCeiling,
      effectiveMode: envelope.effectiveMode,
      sessionId: input.session.sessionId,
      sessionRotationCount: input.session.rotationCount,
      mutationRisk: mutationRisk(input.workflow),
      connectorExecution: "unavailable",
      deliveryExecution: "unavailable",
    },
  };
}

export function revokeAgentRunGovernance(binding: AgentRunGovernanceBinding): void {
  editorAgentAuthorityRegistry.revoke(binding.authorityRef);
}

export function agentRunGovernanceFingerprintProjection(
  binding: AgentRunGovernanceBinding,
): AgentRunGovernanceFingerprintProjection {
  return {
    budgetCapabilityPolicyVersion: AGENT_RUN_BUDGET_CAPABILITY_POLICY_VERSION,
    requestedMode: binding.requestedMode,
    deploymentCeiling: binding.deploymentCeiling,
    effectiveMode: binding.effectiveMode,
    connectorExecution: binding.connectorExecution,
    deliveryExecution: binding.deliveryExecution,
  };
}

function agentRunBudgetFailureReason(
  reason: EditorAgentAuthorityFailureReason,
): Exclude<AgentRunBudgetReservation, { readonly ok: true }>["reason"] {
  return reason === "budget-exceeded" ? "budget-exceeded" : authorityFailureReason(reason);
}

export function reserveAgentRunBudget(input: {
  readonly binding: AgentRunGovernanceBinding;
  readonly workspaceRoot: string;
  readonly usage: CodingWorkbenchRuntimeDelegationUsage;
  readonly nowIso: string;
}): AgentRunBudgetReservation {
  const resolved = editorAgentAuthorityRegistry.resolve(
    input.binding.authorityRef,
    input.workspaceRoot,
    input.binding.deploymentCeiling,
    input.nowIso,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      reason: agentRunBudgetFailureReason(resolved.reason),
    };
  }
  if (
    resolved.envelope.requestedMode !== input.binding.requestedMode ||
    resolved.envelope.effectiveMode !== input.binding.effectiveMode
  ) {
    return { ok: false, reason: "authority-invalid" };
  }
  const reserved = editorAgentAuthorityRegistry.reserveForAgentRun(
    input.binding.authorityRef,
    input.workspaceRoot,
    input.binding.deploymentCeiling,
    input.usage,
    input.nowIso,
  );
  return reserved.ok
    ? { ok: true }
    : { ok: false, reason: agentRunBudgetFailureReason(reserved.reason) };
}

function promptTokenEstimate(request: GatewayRequest): number {
  const messages = request.messages.map((message) =>
    JSON.stringify({
      role: message.role,
      content: message.content,
      contentParts: message.contentParts,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
    }),
  );
  const tools = request.tools === undefined ? [] : [JSON.stringify(request.tools)];
  const responseFormat =
    request.responseFormat === undefined ? [] : [JSON.stringify(request.responseFormat)];
  return Math.max(1, estimateTokensForSegments([...messages, ...tools, ...responseFormat]));
}

function reserveOrThrow(
  input: AgentRunBudgetedPortInput,
  usage: CodingWorkbenchRuntimeDelegationUsage,
): void {
  const reserved = reserveAgentRunBudget({
    binding: input.binding,
    workspaceRoot: input.workspaceRoot,
    usage,
    nowIso: input.nowIso(),
  });
  if (!reserved.ok) throw new AgentRunBudgetExhaustedError();
}

async function* budgetedAgentRunStream(
  stream: NonNullable<ModelPort["callStream"]>,
  request: GatewayRequest,
  signal: AbortSignal,
  input: AgentRunBudgetedPortInput,
): AsyncIterable<GatewayStreamChunk> {
  reserveOrThrow(input, {
    toolCalls: 0,
    patchBytes: 0,
    promptTokens: promptTokenEstimate(request),
  });
  yield* stream(request, signal);
}

export function createAgentRunBudgetedModelPort(input: AgentRunBudgetedModelPortInput): ModelPort {
  const stream = input.model.callStream;
  return {
    call: (request, signal): ReturnType<ModelPort["call"]> => {
      reserveOrThrow(input, {
        toolCalls: 0,
        patchBytes: 0,
        promptTokens: promptTokenEstimate(request),
      });
      return input.model.call(request, signal);
    },
    ...(stream === undefined
      ? {}
      : {
          callStream: (request: GatewayRequest, signal: AbortSignal) =>
            budgetedAgentRunStream(stream, request, signal, input),
        }),
  };
}

export function createAgentRunBudgetedSpawn(input: AgentRunBudgetedSpawnInput): SpawnFn {
  return (command, args, options) => {
    reserveOrThrow(input, { toolCalls: 1, patchBytes: 0, promptTokens: 0 });
    return input.spawn(command, args, options);
  };
}

export function authorizeAgentRunMutation(input: {
  readonly binding: AgentRunGovernanceBinding;
  readonly workspaceRoot: string;
  readonly session: AppSession;
  readonly nowIso: string;
}): AgentRunMutationAuthorization {
  if (!agentRunSessionMatches(input.binding, input.session)) {
    return { ok: false, reason: "session-invalid" };
  }
  const resolved = editorAgentAuthorityRegistry.resolve(
    input.binding.authorityRef,
    input.workspaceRoot,
    input.binding.deploymentCeiling,
    input.nowIso,
  );
  if (!resolved.ok) {
    return { ok: false, reason: authorityFailureReason(resolved.reason) };
  }
  if (
    resolved.envelope.requestedMode !== input.binding.requestedMode ||
    resolved.envelope.effectiveMode !== input.binding.effectiveMode
  ) {
    return { ok: false, reason: "authority-invalid" };
  }
  return {
    ok: true,
    effect: codingWorkbenchPolicyEffectFor(
      resolved.envelope.effectiveMode,
      "workspace-contained",
      input.binding.mutationRisk,
    ),
  };
}
