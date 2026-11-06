import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "./deps.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { contentRedact } from "./requirement-inventory.js";
import {
  knowledgeDocumentSnapshot,
  type KnowledgeDocumentSnapshot,
} from "./knowledge-document-source.js";
import {
  logKnowledgeDocumentOperation,
  type KnowledgeDocumentActivity,
  type KnowledgeReviewObservation,
} from "./knowledge-document-activity.js";
import type { RequirementsToolContext } from "./requirementsTool.js";

export const KNOWLEDGE_TOOL_RESULT_BYTES_MAX = 32_000;
export interface KnowledgeToolEnvironment {
  readonly deps: UiHandlerDeps;
  readonly store: KnowledgeStore;
  readonly snapshot: KnowledgeDocumentSnapshot;
  readonly context: RequirementsToolContext;
  readonly redact: (value: string) => string;
}
export interface KnowledgeToolRead {
  readonly data: CatalogJsonObject;
  readonly sourceChars?: number;
  readonly cached?: boolean;
  readonly reviewObservation?: KnowledgeReviewObservation;
  /** Kept inside the owner until its existing redacted diagnostic boundary; never tool data. */
  readonly diagnosticError?: unknown;
  /** A parsed model result becomes orchestration only after the final source/result guards. */
  readonly confirmModelOperation?: () => void;
}

export function knowledgeToolFailure(reason: string): KnowledgeToolRead {
  return { data: { outcome: "failed", reason } };
}

function readDisposition(read: KnowledgeToolRead): KnowledgeDocumentActivity["disposition"] {
  if (read.data.reason === "unavailable") return "unavailable";
  return read.data.outcome === "failed" ? "refused" : "served";
}

function logRead(
  context: RequirementsToolContext,
  operation: KnowledgeDocumentActivity["operation"],
  read: KnowledgeToolRead,
  documentCount: number,
): void {
  logKnowledgeDocumentOperation(context.correlationId, {
    operation,
    disposition: readDisposition(read),
    documentCount,
    returnedCount: Array.isArray(read.data.items) ? read.data.items.length : 0,
    sourceChars: read.sourceChars ?? 0,
    cached: read.cached ?? false,
    hasNextPage: typeof read.data.nextCursor === "string",
    ...read.reviewObservation,
  });
}

async function admittedRead(
  environment: KnowledgeToolEnvironment,
  read: (environment: KnowledgeToolEnvironment) => KnowledgeToolRead | Promise<KnowledgeToolRead>,
): Promise<KnowledgeToolRead> {
  const { context, snapshot, deps, store } = environment;
  if (snapshot.scopes.length === 0)
    return knowledgeToolFailure(snapshot.refusals[0] ?? "no-knowledge-pod");
  const result = await read(environment);
  if (context.signal.aborted || !context.beforeEffect()) return knowledgeToolFailure("denied");
  if (knowledgeDocumentSnapshot(deps, store, context.chatId).fingerprint !== snapshot.fingerprint)
    return knowledgeToolFailure("source-changed");
  if (Buffer.byteLength(JSON.stringify(result.data)) > KNOWLEDGE_TOOL_RESULT_BYTES_MAX - 2048)
    return knowledgeToolFailure("result-bound");
  result.confirmModelOperation?.();
  return result;
}

function knowledgeToolDiagnostic(
  context: RequirementsToolContext,
  error: unknown,
): ReturnType<typeof serverDiagnosticFromError> {
  return serverDiagnosticFromError({
    correlationId: correlationIdOrUnknown(context.correlationId),
    operation: "knowledge.documents",
    source: "knowledge-tool-execution",
    error,
    redact: () => "server-operation-failed",
  });
}

/** One authenticated managed call, one scope snapshot, one body-free terminal observation. */
export async function executeKnowledgeTool(
  deps: UiHandlerDeps,
  context: RequirementsToolContext,
  operation: KnowledgeDocumentActivity["operation"],
  read: (environment: KnowledgeToolEnvironment) => KnowledgeToolRead | Promise<KnowledgeToolRead>,
): Promise<ManagedMcpToolResult> {
  let session: ReturnType<typeof openKnowledgeStoreForDeps> | undefined;
  let result: KnowledgeToolRead = knowledgeToolFailure("denied");
  let documentCount = 0;
  try {
    if (!context.signal.aborted && context.beforeEffect()) {
      session = openKnowledgeStoreForDeps(deps, { recover: false });
      const snapshot = knowledgeDocumentSnapshot(deps, session.store, context.chatId);
      documentCount = snapshot.totalCount;
      result = await admittedRead(
        {
          deps,
          store: session.store,
          snapshot,
          context,
          redact: contentRedact(deps),
        },
        read,
      );
    }
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, knowledgeToolDiagnostic(context, error));
    result = knowledgeToolFailure("unavailable");
  } finally {
    session?.close();
  }
  if (result.diagnosticError !== undefined)
    emitServerDiagnostic(
      deps.diagnostics,
      knowledgeToolDiagnostic(context, result.diagnosticError),
    );
  logRead(context, operation, result, documentCount);
  return {
    data: result.data,
    ...(result.data.outcome === "failed" ? { isError: true } : {}),
  };
}
