import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeAuthorityEnvelope,
  type CodingWorkbenchRuntimeAuthorityFacts,
  type CodingWorkbenchRuntimeDelegationUsage,
  type CodingWorkbenchRuntimeFailureCode,
  type EditorAgentAction,
  type EditorAgentGovernedAuthorityReference,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";

export const EDITOR_AGENT_AUTHORITY_MAX_RECORDS = 64;
export const EDITOR_AGENT_LOCAL_AUTHORITY_LIFETIME_MS = 31 * 60 * 1_000;

const LOCAL_BRIDGE_BRANCH = {
  baseRef: "local-workspace",
  headRef: "local-workspace",
  allowDetachedHead: false,
  allowedPrefixes: ["local-"],
} as const;
const LOCAL_BRIDGE_MODEL_PROFILE = {
  profileId: "local-codex",
  source: "keiko-model-gateway",
  supportsStreaming: false,
  supportsToolCalling: true,
} as const;
const LOCAL_BRIDGE_COMMAND_POLICY = {
  mode: "deny",
  allow: [],
  deny: [],
  maxCommandTimeoutMs: 1,
  requirePerCommandApproval: true,
} as const;
const LOCAL_BRIDGE_NETWORK_POLICY = {
  mode: "deny-all",
  allowLoopback: false,
  connectorScopes: [],
} as const;

export type EditorAgentAuthorityFailureReason =
  "invalid" | "expired" | "budget-exceeded" | "revoked";

export type EditorAgentAuthorityRegistration =
  | { readonly ok: true; readonly authorityRef: EditorAgentGovernedAuthorityReference }
  | { readonly ok: false; readonly reason: EditorAgentAuthorityFailureReason };

export type EditorAgentAuthorityResolution =
  | { readonly ok: true; readonly envelope: CodingWorkbenchAuthorityEnvelope }
  | { readonly ok: false; readonly reason: EditorAgentAuthorityFailureReason };

interface AuthorityRecord {
  readonly envelope: CodingWorkbenchAuthorityEnvelope;
  readonly digest: string;
  readonly registeredAtMs: number;
  readonly usage: AuthorityUsage;
  readonly localActionBinding?: LocalActionBinding | undefined;
  readonly runtimeEnvelope?: CodingWorkbenchRuntimeAuthorityEnvelope | undefined;
  readonly runtimeDelegations?: Map<string, RuntimeDelegationReservation> | undefined;
  readonly runtimeIdempotencyKeys?: Set<string> | undefined;
  revoked: boolean;
}

interface AuthorityUsage {
  toolCalls: number;
  patchBytes: number;
  promptTokens: number;
}

interface RuntimeDelegationReservation {
  readonly delegationId: string;
  readonly idempotencyKey: string;
  readonly usage: CodingWorkbenchRuntimeDelegationUsage;
}

type RuntimeRecordResolution =
  | { readonly ok: true; readonly record: AuthorityRecord }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode };

interface LocalActionBinding {
  readonly sessionId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
}

export function editorAgentWorkspaceRootDigest(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot, "utf8").digest("hex");
}

export function editorAgentAuthorityEnvelopeDigest(
  envelope: CodingWorkbenchAuthorityEnvelope,
): string {
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function expired(nowIso: string, expiresAt: string): boolean {
  const now = Date.parse(nowIso);
  const expiry = Date.parse(expiresAt);
  return Number.isNaN(now) || Number.isNaN(expiry) || now >= expiry;
}

function runtimeBudgetExceeded(record: AuthorityRecord, nowIso: string): boolean {
  const nowMs = Date.parse(nowIso);
  return Number.isNaN(nowMs) || nowMs - record.registeredAtMs > record.envelope.budget.maxRuntimeMs;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function recordKey(reference: EditorAgentGovernedAuthorityReference): string {
  return `${reference.runId}\u0000${reference.envelopeDigest}`;
}

export class EditorAgentAuthorityRegistry {
  private readonly records = new Map<string, AuthorityRecord>();

  public register(
    value: unknown,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityRegistration {
    const parsed = validateCodingWorkbenchAuthorityEnvelope(value);
    if (!parsed.ok || parsed.value.deploymentCeiling !== deploymentCeiling) {
      return { ok: false, reason: "invalid" };
    }
    if (expired(nowIso, parsed.value.expiresAt)) return { ok: false, reason: "expired" };
    const digest = editorAgentAuthorityEnvelopeDigest(parsed.value);
    const authorityRef = { runId: parsed.value.runId, envelopeDigest: digest };
    const key = recordKey(authorityRef);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      return existing.revoked ? { ok: false, reason: "revoked" } : { ok: true, authorityRef };
    }
    this.evictInactive(nowIso);
    if (this.records.size >= EDITOR_AGENT_AUTHORITY_MAX_RECORDS) {
      return { ok: false, reason: "invalid" };
    }
    this.records.set(key, {
      envelope: parsed.value,
      digest,
      registeredAtMs: Date.parse(nowIso),
      usage: { toolCalls: 0, patchBytes: 0, promptTokens: 0 },
      revoked: false,
    });
    return { ok: true, authorityRef };
  }

  public registerRuntime(
    envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityRegistration {
    if (!validateCodingWorkbenchRuntimeAuthorityEnvelope(envelope).ok) {
      return { ok: false, reason: "invalid" };
    }
    const registration = this.register(envelope.authority, deploymentCeiling, nowIso);
    if (!registration.ok) return registration;
    const key = recordKey(registration.authorityRef);
    const record = this.records.get(key);
    if (record === undefined) return { ok: false, reason: "invalid" };
    if (record.runtimeEnvelope !== undefined) {
      return canonicalJson(record.runtimeEnvelope) === canonicalJson(envelope)
        ? registration
        : { ok: false, reason: "invalid" };
    }
    this.records.set(key, {
      ...record,
      runtimeEnvelope: envelope,
      runtimeDelegations: new Map(),
      runtimeIdempotencyKeys: new Set(),
    });
    return registration;
  }

  public resolveRuntime(
    reference: EditorAgentGovernedAuthorityReference,
    liveFacts: CodingWorkbenchRuntimeAuthorityFacts,
    delegationId: string,
    idempotencyKey: string,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ):
    | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
    | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode } {
    if (!validateCodingWorkbenchRuntimeAuthorityFacts(liveFacts).ok) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const resolved = this.resolveRuntimeRecord(reference, workspaceRoot, deploymentCeiling, nowIso);
    return resolved.ok
      ? admitRuntimeDelegation(resolved.record, liveFacts, delegationId, idempotencyKey, usage)
      : resolved;
  }

  /** Revalidates live authority without reserving budget or replay identity a second time. */
  public revalidateRuntime(
    reference: EditorAgentGovernedAuthorityReference,
    liveFacts: CodingWorkbenchRuntimeAuthorityFacts,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ):
    | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
    | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode } {
    if (!validateCodingWorkbenchRuntimeAuthorityFacts(liveFacts).ok) {
      return { ok: false, reason: "authority-resolution-failed" };
    }
    const resolved = this.resolveRuntimeRecord(reference, workspaceRoot, deploymentCeiling, nowIso);
    if (!resolved.ok) return resolved;
    const envelope = resolved.record.runtimeEnvelope;
    if (envelope === undefined) return { ok: false, reason: "authority-resolution-failed" };
    const drift = runtimeDrift(runtimeFacts(envelope), liveFacts);
    return drift === undefined ? { ok: true, envelope } : { ok: false, reason: drift };
  }

  private resolveRuntimeRecord(
    reference: EditorAgentGovernedAuthorityReference,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): RuntimeRecordResolution {
    const resolved = this.resolve(reference, workspaceRoot, deploymentCeiling, nowIso);
    if (!resolved.ok)
      return {
        ok: false,
        reason:
          resolved.reason === "expired"
            ? "authority-expired"
            : resolved.reason === "revoked"
              ? "revoked"
              : "authority-resolution-failed",
      };
    const record = this.records.get(recordKey(reference));
    return record?.runtimeEnvelope !== undefined &&
      record.runtimeDelegations !== undefined &&
      record.runtimeIdempotencyKeys !== undefined
      ? { ok: true, record }
      : { ok: false, reason: "authority-resolution-failed" };
  }

  public registerLocalBridge(
    snapshot: EditorAgentSessionSnapshot,
    action: EditorAgentAction,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityRegistration {
    if (action.sessionId !== snapshot.sessionId || Number.isNaN(Date.parse(nowIso))) {
      return { ok: false, reason: "invalid" };
    }
    const registration = this.register(
      localBridgeAuthorityEnvelope(snapshot, deploymentCeiling, nowIso),
      deploymentCeiling,
      nowIso,
    );
    if (registration.ok) {
      const key = recordKey(registration.authorityRef);
      const record = this.records.get(key);
      if (record !== undefined) {
        this.records.set(key, {
          ...record,
          localActionBinding: {
            sessionId: action.sessionId,
            actionId: action.actionId,
            idempotencyKey: action.idempotencyKey,
          },
        });
      }
    }
    return registration;
  }

  public resolve(
    reference: EditorAgentGovernedAuthorityReference,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityResolution {
    const key = recordKey(reference);
    const record = this.records.get(key);
    if (record === undefined) return { ok: false, reason: "invalid" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (expired(nowIso, record.envelope.expiresAt)) {
      this.records.delete(key);
      return { ok: false, reason: "expired" };
    }
    if (runtimeBudgetExceeded(record, nowIso)) {
      return { ok: false, reason: "budget-exceeded" };
    }
    return this.recordMatches(record, reference, workspaceRoot, deploymentCeiling)
      ? { ok: true, envelope: record.envelope }
      : { ok: false, reason: "invalid" };
  }

  public resolveForAction(
    reference: EditorAgentGovernedAuthorityReference,
    action: EditorAgentAction,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityResolution {
    const resolved = this.resolve(reference, workspaceRoot, deploymentCeiling, nowIso);
    if (!resolved.ok) return resolved;
    const binding = this.records.get(recordKey(reference))?.localActionBinding;
    return binding === undefined || localBindingMatches(binding, action)
      ? resolved
      : { ok: false, reason: "invalid" };
  }

  public reserveForAction(
    reference: EditorAgentGovernedAuthorityReference,
    action: EditorAgentAction,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    patchBytes: number,
    nowIso: string,
  ): EditorAgentAuthorityResolution {
    if (!Number.isSafeInteger(patchBytes) || patchBytes < 0) {
      return { ok: false, reason: "invalid" };
    }
    const resolved = this.resolveForAction(
      reference,
      action,
      workspaceRoot,
      deploymentCeiling,
      nowIso,
    );
    if (!resolved.ok) return resolved;
    const record = this.records.get(recordKey(reference));
    if (record === undefined) return { ok: false, reason: "invalid" };
    if (!reserveUsage(record, { toolCalls: 1, patchBytes, promptTokens: 0 })) {
      return { ok: false, reason: "budget-exceeded" };
    }
    return resolved;
  }

  public revoke(reference: EditorAgentGovernedAuthorityReference): void {
    const record = this.records.get(recordKey(reference));
    if (record !== undefined) record.revoked = true;
  }

  public reset(): void {
    this.records.clear();
  }

  private recordMatches(
    record: AuthorityRecord,
    reference: EditorAgentGovernedAuthorityReference,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
  ): boolean {
    const parsed = validateCodingWorkbenchAuthorityEnvelope(record.envelope);
    return (
      parsed.ok &&
      record.envelope.deploymentCeiling === deploymentCeiling &&
      safeEqual(record.envelope.runId, reference.runId) &&
      safeEqual(record.digest, reference.envelopeDigest) &&
      safeEqual(record.digest, editorAgentAuthorityEnvelopeDigest(record.envelope)) &&
      safeEqual(record.envelope.workspace.rootDigest, editorAgentWorkspaceRootDigest(workspaceRoot))
    );
  }

  private evictInactive(nowIso: string): void {
    for (const [key, record] of this.records) {
      if (expired(nowIso, record.envelope.expiresAt)) {
        this.records.delete(key);
      }
    }
  }
}

function nonEmptyIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

function admitRuntimeDelegation(
  record: AuthorityRecord,
  liveFacts: CodingWorkbenchRuntimeAuthorityFacts,
  delegationId: string,
  idempotencyKey: string,
  usage: CodingWorkbenchRuntimeDelegationUsage,
):
  | { readonly ok: true; readonly envelope: CodingWorkbenchRuntimeAuthorityEnvelope }
  | { readonly ok: false; readonly reason: CodingWorkbenchRuntimeFailureCode } {
  if (
    record.runtimeEnvelope === undefined ||
    record.runtimeDelegations === undefined ||
    record.runtimeIdempotencyKeys === undefined
  )
    return { ok: false, reason: "authority-resolution-failed" };
  if (!nonEmptyIdentity(delegationId) || !nonEmptyIdentity(idempotencyKey))
    return { ok: false, reason: "authority-resolution-failed" };
  if (
    record.runtimeDelegations.has(delegationId) ||
    record.runtimeIdempotencyKeys.has(idempotencyKey)
  )
    return { ok: false, reason: "authority-replayed" };
  const drift = runtimeDrift(runtimeFacts(record.runtimeEnvelope), liveFacts);
  if (drift !== undefined) return { ok: false, reason: drift };
  if (!reserveUsage(record, usage)) return { ok: false, reason: "authority-budget-exceeded" };
  record.runtimeDelegations.set(delegationId, {
    delegationId,
    idempotencyKey,
    usage: { ...usage },
  });
  record.runtimeIdempotencyKeys.add(idempotencyKey);
  return { ok: true, envelope: record.runtimeEnvelope };
}

function reserveUsage(
  record: AuthorityRecord,
  usage: CodingWorkbenchRuntimeDelegationUsage,
): boolean {
  if (![usage.toolCalls, usage.patchBytes, usage.promptTokens].every(validUsageCount)) return false;
  const next = {
    toolCalls: record.usage.toolCalls + usage.toolCalls,
    patchBytes: record.usage.patchBytes + usage.patchBytes,
    promptTokens: record.usage.promptTokens + usage.promptTokens,
  };
  if (
    next.toolCalls > record.envelope.budget.maxToolCalls ||
    next.patchBytes > record.envelope.budget.maxPatchBytes ||
    next.promptTokens > record.envelope.budget.maxPromptTokens
  )
    return false;
  Object.assign(record.usage, next);
  return true;
}

function validUsageCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function runtimeFacts(
  envelope: CodingWorkbenchRuntimeAuthorityEnvelope,
): CodingWorkbenchRuntimeAuthorityFacts {
  return {
    binding: envelope.binding,
    actionClasses: envelope.authority.actionClasses,
    connectorScopes: envelope.authority.connectorScopes,
    runtimeSource: envelope.authority.runtimeSource,
    modelSource: envelope.authority.modelProfile.source,
    budgetDigest: createHash("sha256")
      .update(canonicalJson(envelope.authority.budget), "utf8")
      .digest("hex"),
    commandPolicyDigest: digestCanonical(envelope.authority.commandPolicy),
    networkPolicyDigest: digestCanonical(envelope.authority.networkPolicy),
    gatesDigest: digestCanonical(envelope.authority.gates),
    branchConstraintsDigest: digestCanonical(envelope.authority.branch),
    modelProfileDigest: digestCanonical(envelope.authority.modelProfile),
  };
}

function runtimeDrift(
  expected: CodingWorkbenchRuntimeAuthorityFacts,
  actual: CodingWorkbenchRuntimeAuthorityFacts,
): CodingWorkbenchRuntimeFailureCode | undefined {
  const bindingDrift = runtimeBindingDrift(expected, actual);
  if (bindingDrift !== undefined) return bindingDrift;
  if (
    canonicalJson(expected.actionClasses) !== canonicalJson(actual.actionClasses) ||
    canonicalJson(expected.connectorScopes) !== canonicalJson(actual.connectorScopes)
  )
    return "scope-drift";
  if (expected.budgetDigest !== actual.budgetDigest) return "budget-drift";
  if (policyFactsDrifted(expected, actual)) return "scope-drift";
  return expected.runtimeSource !== actual.runtimeSource ||
    expected.modelSource !== actual.modelSource
    ? "source-drift"
    : undefined;
}

function policyFactsDrifted(
  expected: CodingWorkbenchRuntimeAuthorityFacts,
  actual: CodingWorkbenchRuntimeAuthorityFacts,
): boolean {
  return (
    expected.commandPolicyDigest !== actual.commandPolicyDigest ||
    expected.networkPolicyDigest !== actual.networkPolicyDigest ||
    expected.gatesDigest !== actual.gatesDigest ||
    expected.branchConstraintsDigest !== actual.branchConstraintsDigest ||
    expected.modelProfileDigest !== actual.modelProfileDigest
  );
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function runtimeBindingDrift(
  expected: CodingWorkbenchRuntimeAuthorityFacts,
  actual: CodingWorkbenchRuntimeAuthorityFacts,
): CodingWorkbenchRuntimeFailureCode | undefined {
  if (expected.binding.taskId !== actual.binding.taskId) return "task-drift";
  if (
    expected.binding.workspaceId !== actual.binding.workspaceId ||
    expected.binding.workspaceRootDigest !== actual.binding.workspaceRootDigest
  )
    return "workspace-drift";
  if (
    expected.binding.projectId !== actual.binding.projectId ||
    expected.binding.projectDigest !== actual.binding.projectDigest
  )
    return "project-drift";
  return expected.binding.branchRef !== actual.binding.branchRef ||
    expected.binding.branchHeadDigest !== actual.binding.branchHeadDigest
    ? "branch-drift"
    : undefined;
}

function localBridgeAuthorityEnvelope(
  snapshot: EditorAgentSessionSnapshot,
  deploymentCeiling: CodingWorkbenchMode,
  nowIso: string,
): CodingWorkbenchAuthorityEnvelope {
  const rootDigest = editorAgentWorkspaceRootDigest(snapshot.workspaceRoot);
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    runId: "run-local-1",
    localUser: "local-operator",
    taskRefs: ["issue-2121"],
    workspace: {
      workspaceId: "workspace-1",
      rootLabel: "workspace",
      rootDigest,
    },
    branch: LOCAL_BRIDGE_BRANCH,
    requestedMode: "governed-assist",
    deploymentCeiling,
    effectiveMode: resolveEffectiveCodingWorkbenchMode("governed-assist", deploymentCeiling),
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write"],
    connectorScopes: [],
    modelProfile: LOCAL_BRIDGE_MODEL_PROFILE,
    commandPolicy: LOCAL_BRIDGE_COMMAND_POLICY,
    networkPolicy: LOCAL_BRIDGE_NETWORK_POLICY,
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: EDITOR_AGENT_LOCAL_AUTHORITY_LIFETIME_MS,
      maxToolCalls: 1,
      maxPromptTokens: 1,
      maxPatchBytes: 65_536,
    },
    expiresAt: new Date(
      Date.parse(nowIso) + EDITOR_AGENT_LOCAL_AUTHORITY_LIFETIME_MS,
    ).toISOString(),
    approvalProofDigest: randomBytes(32).toString("hex"),
  };
}

function localBindingMatches(binding: LocalActionBinding, action: EditorAgentAction): boolean {
  return (
    safeEqual(binding.sessionId, action.sessionId) &&
    safeEqual(binding.actionId, action.actionId) &&
    safeEqual(binding.idempotencyKey, action.idempotencyKey)
  );
}

export const editorAgentAuthorityRegistry = new EditorAgentAuthorityRegistry();
