import { randomUUID } from "node:crypto";
import type {
  MemoryAuditEvent,
  MemoryId,
  MemoryScope,
  MemoryWorkflowContext,
  MemoryWorkflowPort,
} from "@oscharko-dev/keiko-contracts";
import { retrieveMemoryContext } from "@oscharko-dev/keiko-memory-retrieval";
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
      result.omitted,
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
