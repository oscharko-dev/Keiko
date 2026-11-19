import { randomUUID } from "node:crypto";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryScope,
  MemoryStatus,
  MemoryWorkflowContext,
  MemoryWorkflowPort,
} from "@oscharko-dev/keiko-contracts";
import { MEMORY_STATUSES, isMemoryStatusRecallable } from "@oscharko-dev/keiko-contracts/memory";
import {
  DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
  retrieveMemoryContext,
} from "@oscharko-dev/keiko-memory-retrieval";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { recordMemoryAudit, recordMemoryAudits } from "./memory-audit-handler.js";
import { vaultAsQueryPort } from "./memory-conv-handlers.js";

interface WorkflowMemoryPortOptions {
  readonly vault: MemoryVaultStore;
  readonly evidenceStore: EvidenceStore;
  readonly runId: string;
  readonly redactString: (input: string) => string;
  readonly now?: (() => number) | undefined;
}

function buildRetrievedAudit(
  occurredAt: number,
  scopes: readonly MemoryScope[],
  matchedMemoryIds: readonly MemoryId[],
): MemoryAuditEvent | undefined {
  if (matchedMemoryIds.length === 0) {
    return undefined;
  }
  return {
    schemaVersion: "1",
    kind: "memory:retrieved",
    eventId: randomUUID(),
    occurredAt,
    initiatorSurface: "workflow",
    summary:
      matchedMemoryIds.length === 1
        ? "Retrieved 1 memory for workflow context."
        : `Retrieved ${String(matchedMemoryIds.length)} memories for workflow context.`,
    scopes,
    matchedMemoryIds,
  };
}

function buildWorkflowOmittedAudit(
  options: WorkflowMemoryPortOptions,
  occurredAt: number,
  event: {
    readonly memoryId: MemoryId;
    readonly reason: string;
    readonly scopes: readonly MemoryScope[];
  },
): MemoryAuditEvent {
  return {
    schemaVersion: "1",
    kind: "memory:workflow-omitted",
    eventId: randomUUID(),
    occurredAt,
    initiatorSurface: "workflow",
    summary: `Workflow omitted memory (${event.reason}).`,
    workflowRunId: options.runId,
    scopes: event.scopes,
    omittedMemoryId: event.memoryId,
    reason: event.reason,
  };
}

function recordWorkflowOmittedAudit(
  options: WorkflowMemoryPortOptions,
  now: () => number,
  event: {
    readonly memoryId: MemoryId;
    readonly reason: string;
    readonly scopes: readonly MemoryScope[];
  },
): void {
  recordMemoryAudit(
    {
      evidenceStore: options.evidenceStore,
      redactString: options.redactString,
      now,
    },
    buildWorkflowOmittedAudit(options, now(), event),
  );
}

function recordWorkflowRetrievalAudits(
  options: WorkflowMemoryPortOptions,
  now: () => number,
  scopes: readonly MemoryScope[],
  matchedMemoryIds: readonly MemoryId[],
  omittedMemories: readonly { readonly memoryId: MemoryId; readonly reason: string }[],
): void {
  const occurredAt = now();
  const events: MemoryAuditEvent[] = [];
  const retrievedEvent = buildRetrievedAudit(occurredAt, scopes, matchedMemoryIds);
  if (retrievedEvent !== undefined) {
    events.push(retrievedEvent);
  }
  for (const omitted of omittedMemories) {
    events.push(
      buildWorkflowOmittedAudit(options, occurredAt, {
        memoryId: omitted.memoryId,
        reason: omitted.reason,
        scopes,
      }),
    );
  }
  recordMemoryAudits(
    {
      evidenceStore: options.evidenceStore,
      redactString: options.redactString,
      now,
    },
    events,
  );
}

// Recall never reads rows whose status keeps them out (#4223), so they cannot crowd a live record
// out of its bounded window. The workflow-omitted audit still names each of them, from its own read
// bounded like the recall window.
const RETIRED_STATUSES: readonly MemoryStatus[] = MEMORY_STATUSES.filter(
  (status) => !isMemoryStatusRecallable(status),
);

function listRetiredOmissions(
  vault: MemoryVaultStore,
  scopes: readonly MemoryScope[],
): readonly { readonly memoryId: MemoryId; readonly reason: string }[] {
  return scopes.flatMap((scope) =>
    vault
      .listMemoriesByScope(scope, {
        includeExpired: true,
        status: RETIRED_STATUSES,
        limit: DEFAULT_LIST_BY_SCOPE_MAX_RESULTS,
      })
      .map((record) => ({ memoryId: record.id, reason: "suppressed-by-status" })),
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

function createWorkflowContextGetter(
  options: WorkflowMemoryPortOptions,
  now: () => number,
  queryPort: ReturnType<typeof vaultAsQueryPort>,
): MemoryWorkflowPort["getContextForWorkflow"] {
  return (
    scopes: readonly MemoryScope[],
    queryText?: string,
    budgetTokens?: number,
  ): Promise<MemoryWorkflowContext> => {
    const result = retrieveMemoryContext(
      {
        scopes,
        nowMs: now(),
        ...(queryText === undefined ? {} : { queryText }),
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
      },
      queryPort,
    );
    recordWorkflowRetrievalAudits(
      options,
      now,
      scopes,
      result.included.map((item) => item.memoryId),
      [...result.omitted, ...listRetiredOmissions(options.vault, scopes)],
    );
    return Promise.resolve({
      text: result.contextBlock.text,
      includedMemoryIds: result.contextBlock.memories.map((item) => item.memoryId),
    });
  };
}

export function createWorkflowMemoryPort(options: WorkflowMemoryPortOptions): MemoryWorkflowPort {
  const now = options.now ?? Date.now;
  const queryPort = vaultAsQueryPort(options.vault);

  return {
    getContextForWorkflow: createWorkflowContextGetter(options, now, queryPort),
    onMemoryUsed(event): void {
      recordWorkflowUsedAudit(options, now, event);
    },
    onMemoryOmitted(event): void {
      recordWorkflowOmittedAudit(options, now, {
        memoryId: event.memoryId,
        reason: event.reason,
        scopes: [],
      });
    },
  };
}
