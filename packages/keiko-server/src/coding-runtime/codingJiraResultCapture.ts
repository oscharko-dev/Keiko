import {
  JIRA_MUTATION_OPERATIONS,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  ToolResultEnvelope,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  validateToolResultEnvelope,
  type ToolResultValidationBinding,
} from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../atlassian/jiraManagedProvider.js";
import type { JiraOperationBinding } from "../atlassian/jiraOperationRegistry.js";
import { managedCatalogProjection } from "../tool-catalog/managedProviderCatalog.js";
import { journalConflict } from "../store/chatToolMutationState.js";
import type { ChatToolMutationRecord } from "../store/chatToolMutationTypes.js";
import type { CodingNativeToolTranscript } from "../store/codingHistory.js";
import { CODING_JIRA_SERVER_NAME } from "./codingJiraPodBinding.js";

function object(value: unknown): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observedOutcome(
  result: ManagedMcpToolResult,
  dispatched: boolean,
): JiraMutationOutcome {
  if (result.isError !== true) return "succeeded-unconfirmed";
  if (!dispatched) return result.data.outcome === "rejected" ? "rejected" : "not-dispatched";
  return result.data.outcome === "succeeded-unconfirmed" ? "succeeded-unconfirmed" : "unknown";
}

interface CaptureSnapshot {
  readonly capture: CodingNativeToolTranscript["capture"];
  readonly record: ChatToolMutationRecord;
  readonly messageId: string;
  readonly argumentsValue: CatalogJsonObject;
  readonly alias: string;
  readonly startedAt: number;
  readonly binding: ToolResultValidationBinding;
  readonly operationBinding: JiraOperationBinding;
  readonly current: () => ChatToolMutationRecord | undefined;
  readonly releaseReservation: () => void;
}
interface CodingJiraCapture {
  readonly retainProviderResult: (result: ManagedMcpToolResult) => ManagedMcpToolResult;
  readonly retainLocalFailure: (reason: "connector-scope-missing") => void;
  readonly releaseReservation: () => void;
}

function dispatchedFrom(snapshot: CaptureSnapshot): boolean {
  const latest = snapshot.current();
  if (latest === undefined || latest.phase === "settled" ||
      latest.invocationId !== snapshot.record.invocationId) throw journalConflict();
  return latest.phase !== "prepared";
}

function envelopeIdentity(snapshot: CaptureSnapshot, dispatched: boolean, outputBytes: number) {
  return {
    schemaVersion: 1,
    invocationId: snapshot.record.invocationId,
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
  mutationOutcome: JiraMutationOutcome,
): void {
  snapshot.capture({
    kind: "captured",
    call: { id: snapshot.record.invocationId, name: snapshot.alias, arguments: snapshot.argumentsValue },
    operationBinding: snapshot.operationBinding,
    nativeArgumentsDigest: sha256Hex(canonicalise(snapshot.argumentsValue)),
    result,
    binding: snapshot.binding,
    mutationOutcome,
  }, snapshot.record.correlationId);
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
    (!isError && !dispatched)
  ) throw journalConflict();
  return validateToolResultEnvelope({
    ...envelopeIdentity(snapshot, dispatched, Buffer.byteLength(JSON.stringify(candidate.data))),
    status: isError ? "failed" : "completed",
    reason: isError ? "provider-reported-error" : "none",
    page: isError ? null : { truncated: false, reason: "none", cursor: null },
    data: candidate.data,
  }, snapshot.binding);
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
      const dispatched = dispatchedFrom(snapshot);
      const result = providerEnvelope(snapshot, candidate, dispatched);
      if (!object(result.data)) throw journalConflict();
      persistCaptured(snapshot, result, observedOutcome(candidate, dispatched));
      retained = Object.freeze({ data: result.data, ...(candidate.isError === true ? { isError: true } : {}) });
      return retained;
    },
    retainLocalFailure: () => {
      if (retained !== undefined) throw journalConflict();
      if (localFailure) return;
      const dispatched = dispatchedFrom(snapshot);
      const result = validateToolResultEnvelope({
        ...envelopeIdentity(snapshot, dispatched, 0),
        status: "denied", reason: "effect-denied", page: null, data: null,
      }, snapshot.binding);
      persistCaptured(snapshot, result, dispatched ? "unknown" : "not-dispatched");
      localFailure = true;
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
  const alias = contract.declaration.name.replace(/[.-]/gu, "_");
  const startedAt = Date.now();
  const projection = managedCatalogProjection(
    [{ name: contract.declaration.name, alias }],
    [contract.declaration],
    { id: "coding-jira-result", version: 1 },
    startedAt,
  );
  return captureCallbacks({
    capture, record, argumentsValue, current, alias, startedAt,
    releaseReservation: reserve(record.userMessageId, contract.declaration.descriptor, alias),
    messageId: record.userMessageId,
    operationBinding: contract.binding,
    binding: {
      descriptor: contract.declaration.descriptor,
      projectionDigest: projection.projectionDigest,
    },
  });
}
