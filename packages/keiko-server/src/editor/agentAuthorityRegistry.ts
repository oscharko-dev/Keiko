import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  resolveEffectiveCodingWorkbenchMode,
  validateCodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
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

export type EditorAgentAuthorityFailureReason = "invalid" | "expired" | "budget-exceeded";

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
  sessionId?: string | undefined;
  readonly localActionBinding?: LocalActionBinding | undefined;
}

interface AuthorityUsage {
  toolCalls: number;
  patchBytes: number;
}

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
    if (existing !== undefined) return { ok: true, authorityRef };
    this.evictInactive(nowIso);
    if (this.records.size >= EDITOR_AGENT_AUTHORITY_MAX_RECORDS) {
      return { ok: false, reason: "invalid" };
    }
    this.records.set(key, {
      envelope: parsed.value,
      digest,
      registeredAtMs: Date.parse(nowIso),
      usage: { toolCalls: 0, patchBytes: 0 },
    });
    return { ok: true, authorityRef };
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
    const record = this.records.get(recordKey(reference));
    if (record === undefined) return { ok: false, reason: "invalid" };
    if (
      record.localActionBinding !== undefined &&
      !localBindingMatches(record.localActionBinding, action)
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (record.sessionId === undefined) {
      record.sessionId = action.sessionId;
      return resolved;
    }
    return safeEqual(record.sessionId, action.sessionId)
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
    const nextToolCalls = record.usage.toolCalls + 1;
    const nextPatchBytes = record.usage.patchBytes + patchBytes;
    if (
      nextToolCalls > record.envelope.budget.maxToolCalls ||
      nextPatchBytes > record.envelope.budget.maxPatchBytes
    ) {
      return { ok: false, reason: "budget-exceeded" };
    }
    record.usage.toolCalls = nextToolCalls;
    record.usage.patchBytes = nextPatchBytes;
    return resolved;
  }

  // Issue #2244 (ADR-0128 D4): budget reservation for one governed CONNECTOR action. Charges
  // exactly one toolCall (connector actions carry no patch) against the same envelope budget the
  // editor lane charges, after the same resolve-time revalidation. An envelope bound to a
  // local-bridge action (one-shot editor binding) is refused fail-closed: that authority was
  // minted for exactly one editor action and must not be consumable by a connector call.
  public reserveForConnector(
    reference: EditorAgentGovernedAuthorityReference,
    workspaceRoot: string,
    deploymentCeiling: CodingWorkbenchMode,
    nowIso: string,
  ): EditorAgentAuthorityResolution {
    const resolved = this.resolve(reference, workspaceRoot, deploymentCeiling, nowIso);
    if (!resolved.ok) return resolved;
    const record = this.records.get(recordKey(reference));
    if (record === undefined || record.localActionBinding !== undefined) {
      return { ok: false, reason: "invalid" };
    }
    const nextToolCalls = record.usage.toolCalls + 1;
    if (nextToolCalls > record.envelope.budget.maxToolCalls) {
      return { ok: false, reason: "budget-exceeded" };
    }
    record.usage.toolCalls = nextToolCalls;
    return resolved;
  }

  public revoke(reference: EditorAgentGovernedAuthorityReference): void {
    this.records.delete(recordKey(reference));
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
