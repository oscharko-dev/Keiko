import { randomUUID } from "node:crypto";
import {
  extractCandidatesFromWorkflowOutcome,
  type CaptureContext,
} from "@oscharko-dev/keiko-memory-capture";
import type {
  MemoryId,
  MemoryProposalId,
  MemoryScope,
  MemoryWorkflowContext,
  MemoryWorkflowPort,
  MemoryWorkflowRunId,
} from "@oscharko-dev/keiko-contracts";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { recordMemoryAudit } from "./memory-audit-handler.js";
import { vaultAsQueryPort } from "./memory-conv-handlers.js";
import { LOCAL_CONVERSATION_MEMORY_USER_ID } from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { isPersistableMemoryCandidate } from "./memory-capture-policy.js";

interface WorkflowMemoryPortOptions {
  readonly vault: MemoryVaultStore;
  readonly evidenceStore: EvidenceStore;
  readonly runId: string;
  readonly redactString: (input: string) => string;
  readonly customerIdentifierMatchers?: readonly RegExp[] | undefined;
  readonly now?: (() => number) | undefined;
}

function recordRetrievedAudit(
  options: WorkflowMemoryPortOptions,
  now: () => number,
  scopes: readonly MemoryScope[],
  matchedMemoryIds: readonly MemoryId[],
): void {
  if (matchedMemoryIds.length === 0) {
    return;
  }
  recordMemoryAudit(
    {
      evidenceStore: options.evidenceStore,
      redactString: options.redactString,
      now,
    },
    {
      schemaVersion: "1",
      kind: "memory:retrieved",
      eventId: randomUUID(),
      occurredAt: now(),
      initiatorSurface: "workflow",
      summary:
        matchedMemoryIds.length === 1
          ? "Retrieved 1 memory for workflow context."
          : `Retrieved ${String(matchedMemoryIds.length)} memories for workflow context.`,
      scopes,
      matchedMemoryIds,
    },
  );
}

function recordWorkflowUsedAudit(
  options: WorkflowMemoryPortOptions,
  now: () => number,
  event: Parameters<NonNullable<MemoryWorkflowPort["onMemoryUsed"]>>[0],
): void {
  recordMemoryAudit(
    {
      evidenceStore: options.evidenceStore,
      redactString: options.redactString,
      now,
    },
    {
      schemaVersion: "1",
      kind: "memory:workflow-used",
      eventId: randomUUID(),
      occurredAt: now(),
      initiatorSurface: "workflow",
      summary:
        event.memoryIds.length === 1
          ? `Workflow used 1 memory (${event.reason}).`
          : `Workflow used ${String(event.memoryIds.length)} memories (${event.reason}).`,
      workflowRunId: options.runId,
      usedMemoryIds: event.memoryIds,
    },
  );
}

function persistWorkflowCandidates(
  options: WorkflowMemoryPortOptions,
  event: Parameters<NonNullable<MemoryWorkflowPort["onMemoryWriteCandidate"]>>[0],
  capturedAt: number,
): void {
  const outcomes = extractCandidatesFromWorkflowOutcome(
    {
      runId: options.runId as MemoryWorkflowRunId,
      outcomeKind: event.source === "workflow-correction" ? "corrected" : "success",
      structuredReport: event.proposalSummary,
      capturedAt,
    },
    captureContextFor(event.scope, capturedAt, options.runId),
    {
      scopeKind: event.scope.kind,
      ...(options.customerIdentifierMatchers === undefined
        ? {}
        : { customerIdentifierMatchers: options.customerIdentifierMatchers }),
    },
  );
  for (const outcome of outcomes) {
    if (!isPersistableMemoryCandidate(outcome)) {
      continue;
    }
    const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
    const record = buildMemoryRecordFromProposal(proposalId, outcome);
    if (record !== null) {
      options.vault.insertMemory(record);
    }
  }
}

function captureContextFor(scope: MemoryScope, nowMs: number, runId: string): CaptureContext {
  return {
    userId: LOCAL_CONVERSATION_MEMORY_USER_ID,
    ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
    ...(scope.kind === "workflow"
      ? {
          workflowDefinitionId: scope.workflowDefinitionId,
          sourceWorkflowRunId: runId as MemoryWorkflowRunId,
        }
      : {}),
    nowMs,
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
  };
}

export function createWorkflowMemoryPort(
  options: WorkflowMemoryPortOptions,
): MemoryWorkflowPort {
  const now = options.now ?? Date.now;
  const queryPort = vaultAsQueryPort(options.vault);

  return {
    getContextForWorkflow(
      scopes: readonly MemoryScope[],
      queryText?: string,
      budgetTokens?: number,
    ): Promise<MemoryWorkflowContext> {
      const result = retrieveMemoryContext(
        {
          scopes,
          nowMs: now(),
          ...(queryText === undefined ? {} : { queryText }),
          ...(budgetTokens === undefined ? {} : { budgetTokens }),
        },
        queryPort,
      );
      recordRetrievedAudit(
        options,
        now,
        scopes,
        result.included.map((item) => item.memoryId),
      );
      return Promise.resolve({
        text: result.contextBlock.text,
        includedMemoryIds: result.contextBlock.memories.map((item) => item.memoryId),
      });
    },
    onMemoryUsed(event): void {
      recordWorkflowUsedAudit(options, now, event);
    },
    onMemoryWriteCandidate(event): void {
      persistWorkflowCandidates(options, event, now());
    },
  };
}
