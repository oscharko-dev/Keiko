import {
  JIRA_MUTATION_OPERATIONS,
  JIRA_MANAGED_READ_TOOLS,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  ToolResultEnvelope,
  ToolDescriptor,
  ToolResultStatus,
  ToolResultReason,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpToolResult,
  ManagedMcpFailure,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  validateToolResultEnvelope,
  type ToolResultValidationBinding,
} from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../atlassian/jiraManagedProvider.js";
import type {
  JiraOperationBinding,
  JiraOperationContract,
} from "../atlassian/jiraOperationRegistry.js";
import {
  isManagedMcpFailure,
  managedCatalogProjection,
} from "../tool-catalog/managedProviderCatalog.js";
import { journalConflict } from "../store/chatToolMutationState.js";
import type { ChatToolMutationRecord } from "../store/chatToolMutationTypes.js";
import type { CodingNativeToolTranscript } from "../store/codingHistory.js";
import { CODING_JIRA_SERVER_NAME } from "./codingJiraPodBinding.js";
import { jiraCatalogResult } from "../atlassian/jiraCatalogResult.js";

function object(value: unknown): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observedOutcome(result: ManagedMcpToolResult, dispatched: boolean): JiraMutationOutcome {
  // Captured before the native producer completes. History projects the authoritative journal
  // outcome over this provisional value after acknowledgement and confirmed producer completion.
  if (result.isError !== true) return "succeeded-unconfirmed";
  if (!dispatched) return result.data.outcome === "rejected" ? "rejected" : "not-dispatched";
  return result.data.outcome === "succeeded-unconfirmed" ? "succeeded-unconfirmed" : "unknown";
}

interface CaptureSnapshot {
  readonly capture: CodingNativeToolTranscript["capture"];
  readonly invocationId: string;
  readonly correlationId: string;
  readonly mutation: boolean;
  readonly argumentsValue: CatalogJsonObject;
  readonly alias: string;
  readonly startedAt: number;
  readonly binding: ToolResultValidationBinding;
  readonly operationBinding: JiraOperationBinding;
  readonly effectStarted: () => boolean;
  readonly releaseReservation: () => void;
}
interface CodingJiraCapture {
  readonly retainProviderResult: (result: ManagedMcpToolResult) => ManagedMcpToolResult;
  readonly retainLocalFailure: (reason: "connector-scope-missing") => void;
  readonly retainRelayFailure: (reason: ManagedMcpFailure) => void;
  readonly releaseReservation: () => void;
}
function requireScopeFailure(value: unknown): void {
  if (value !== "connector-scope-missing") throw journalConflict();
}

function relayFailureResult(
  reason: ManagedMcpFailure,
): readonly [ToolResultStatus, ToolResultReason] {
  if (!isManagedMcpFailure(reason)) throw journalConflict();
  if (reason === "connector-scope-missing") return ["denied", "effect-denied"];
  if (reason === "deadline-exceeded") return ["timeout", "deadline-exceeded"];
  if (reason === "aborted") return ["cancelled", "parent-cancelled"];
  return ["failed", "handler-failed"];
}

function persistLocalFailure(
  snapshot: CaptureSnapshot,
  status: ToolResultStatus,
  reason: ToolResultReason,
): void {
  const dispatched = snapshot.effectStarted();
  const result = validateToolResultEnvelope(
    {
      ...envelopeIdentity(snapshot, dispatched, 0),
      status,
      reason,
      page: null,
      data: null,
    },
    snapshot.binding,
  );
  persistCaptured(
    snapshot,
    result,
    snapshot.mutation ? (dispatched ? "unknown" : "not-dispatched") : undefined,
  );
}

function dispatchedFrom(
  record: ChatToolMutationRecord,
  current: () => ChatToolMutationRecord | undefined,
): boolean {
  const latest = current();
  if (
    latest === undefined ||
    latest.phase === "settled" ||
    latest.invocationId !== record.invocationId
  )
    throw journalConflict();
  return latest.phase !== "prepared";
}

function envelopeIdentity(snapshot: CaptureSnapshot, dispatched: boolean, outputBytes: number) {
  return {
    schemaVersion: 1,
    invocationId: snapshot.invocationId,
    toolRef: snapshot.binding.descriptor.toolRef,
    projectionDigest: snapshot.binding.projectionDigest,
    effectStarted: dispatched,
    metrics: {
      inputBytes: Buffer.byteLength(JSON.stringify(snapshot.argumentsValue)),
      outputBytes,
      resultCount: 0,
      durationMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
  };
}

function persistCaptured(
  snapshot: CaptureSnapshot,
  result: ToolResultEnvelope,
  mutationOutcome?: JiraMutationOutcome,
): void {
  snapshot.capture(
    {
      kind: "captured",
      call: { id: snapshot.invocationId, name: snapshot.alias, arguments: snapshot.argumentsValue },
      ...(snapshot.mutation
        ? {
            operationBinding: snapshot.operationBinding,
            nativeArgumentsDigest: sha256Hex(canonicalise(snapshot.argumentsValue)),
          }
        : {}),
      result,
      binding: snapshot.binding,
      ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
    },
    snapshot.correlationId,
  );
  snapshot.releaseReservation();
}

function providerEnvelope(
  snapshot: CaptureSnapshot,
  candidate: ManagedMcpToolResult,
  dispatched: boolean,
): ToolResultEnvelope {
  const isError = candidate.isError === true;
  if (
    canonicalise(candidate.data.operationBinding) !== canonicalise(snapshot.operationBinding) ||
    (candidate.data.outcome === "succeeded") === isError ||
    (!isError && snapshot.mutation && !dispatched)
  )
    throw journalConflict();
  const identity = envelopeIdentity(
    snapshot,
    dispatched,
    Buffer.byteLength(JSON.stringify(candidate.data)),
  );
  const projection = snapshot.mutation
    ? { page: { truncated: false, reason: "none", cursor: null }, resultCount: 0 }
    : jiraCatalogResult(candidate.data);
  return validateToolResultEnvelope(
    {
      ...identity,
      metrics: { ...identity.metrics, resultCount: isError ? 0 : projection.resultCount },
      status: isError ? "failed" : "completed",
      reason: isError ? "provider-reported-error" : "none",
      page: isError ? null : projection.page,
      data: candidate.data,
    },
    snapshot.binding,
  );
}

function captureCallbacks(snapshot: CaptureSnapshot): CodingJiraCapture {
  let retained: ManagedMcpToolResult | undefined;
  let localFailure = false;
  return {
    releaseReservation: snapshot.releaseReservation,
    retainProviderResult: (candidate) => {
      if (localFailure) throw journalConflict();
      if (retained !== undefined) {
        if (canonicalise(candidate) !== canonicalise(retained)) throw journalConflict();
        return retained;
      }
      const dispatched = snapshot.effectStarted();
      const result = providerEnvelope(snapshot, candidate, dispatched);
      if (!object(result.data)) throw journalConflict();
      persistCaptured(
        snapshot,
        result,
        snapshot.mutation ? observedOutcome(candidate, dispatched) : undefined,
      );
      retained = Object.freeze({
        data: result.data,
        ...(candidate.isError === true ? { isError: true } : {}),
      });
      return retained;
    },
    retainLocalFailure: (reason) => {
      requireScopeFailure(reason);
      if (retained !== undefined) throw journalConflict();
      if (localFailure) return;
      persistLocalFailure(snapshot, "denied", "effect-denied");
      localFailure = true;
    },
    retainRelayFailure: (failure) => {
      if (snapshot.mutation) throw journalConflict();
      const [status, reason] = relayFailureResult(failure);
      // Provider evidence and the earlier explicit scope refusal are already durable. A later
      // delivery/transport failure must not replace either with an empty technical result.
      if (retained !== undefined || localFailure) return;
      persistLocalFailure(snapshot, status, reason);
      localFailure = true;
    },
  };
}

function resultSnapshot(contract: JiraOperationContract) {
  const alias = contract.declaration.name.replace(/[.-]/gu, "_");
  const startedAt = Date.now();
  const projection = managedCatalogProjection(
    [{ name: contract.declaration.name, alias }],
    [contract.declaration],
    { id: "coding-jira-result", version: 1 },
    startedAt,
  );
  return {
    alias,
    startedAt,
    operationBinding: contract.binding,
    binding: {
      descriptor: contract.declaration.descriptor,
      projectionDigest: projection.projectionDigest,
    },
  };
}

/**
 * One native permit owns this immutable result contract. The current registry is consulted only
 * here, before dispatch; historical results retain the descriptor and binding they were read with.
 * The ordinary transcript store owns redaction, bytes, persistence and historical validation.
 */
export function codingJiraResultCapture(
  capture: CodingNativeToolTranscript["capture"],
  record: ChatToolMutationRecord,
  argumentsValue: CatalogJsonObject,
  current: () => ChatToolMutationRecord | undefined,
  reserve: (messageId: string, descriptor: ToolDescriptor, alias: string) => () => void,
): CodingJiraCapture | undefined {
  if (record.sourceKind !== "configured-mcp" || record.serverName !== CODING_JIRA_SERVER_NAME)
    return undefined;
  const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === record.toolName);
  const contract = operation === undefined ? undefined : jiraOperationForTool(operation);
  if (contract === undefined || record.userMessageId === null) throw journalConflict();
  const snapshot = resultSnapshot(contract);
  return captureCallbacks({
    ...snapshot,
    capture,
    argumentsValue,
    invocationId: record.invocationId,
    correlationId: record.correlationId,
    mutation: true,
    effectStarted: () => dispatchedFrom(record, current),
    releaseReservation: reserve(
      record.userMessageId,
      contract.declaration.descriptor,
      snapshot.alias,
    ),
  });
}

/** Reads use the same immutable envelope and store, without creating a mutation journal row. */
export function codingJiraReadResultCapture(input: {
  readonly capture: CodingNativeToolTranscript["capture"];
  readonly toolName: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly argumentsValue: CatalogJsonObject;
  readonly signal: AbortSignal;
  readonly reserve: (descriptor: ToolDescriptor, alias: string) => () => void;
}): CodingJiraCapture {
  const tool = JIRA_MANAGED_READ_TOOLS.find((name) => name === input.toolName);
  const contract = tool === undefined ? undefined : jiraOperationForTool(tool);
  if (contract === undefined || input.signal.aborted) throw journalConflict();
  const snapshot = resultSnapshot(contract);
  const release = input.reserve(contract.declaration.descriptor, snapshot.alias);
  let released = false;
  return captureCallbacks({
    ...snapshot,
    capture: input.capture,
    argumentsValue: input.argumentsValue,
    invocationId: input.invocationId,
    correlationId: input.runId,
    mutation: false,
    effectStarted: () => {
      if (released || input.signal.aborted) throw journalConflict();
      return false;
    },
    releaseReservation: () => {
      released = true;
      release();
    },
  });
}
