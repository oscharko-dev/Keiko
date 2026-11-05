import { createHash } from "node:crypto";
import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  QualityIntelligenceHandoff,
  resolveEnumerationScope,
  type KnowledgeStore,
} from "@oscharko-dev/keiko-local-knowledge";
import type { UiHandlerDeps } from "./deps.js";
import type { PageCursor } from "./requirement-inventory.js";
import { chatKnowledgeScopes, scopeRefusal, type ScopeRefusal } from "./requirement-inventory.js";

export const KNOWLEDGE_DOCUMENTS_MAX = 10_000;
export type KnowledgeDocument = QualityIntelligenceHandoff.ScopeDocumentInventoryEntry;
export type ReadKnowledgeDocument = QualityIntelligenceHandoff.ScopeDocument;
type Scope = QualityIntelligenceHandoff.ScopeDocumentScope;

export function knowledgeDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** New tools bind full digests and up to 10,000 document-sized search offsets. */
export function decodeKnowledgeCursor(value: string): PageCursor | undefined {
  const match = /^(\d{1,11})\.([0-9a-f]{64})$/u.exec(value);
  const offset = Number(match?.[1]);
  const fingerprint = match?.[2];
  return Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= 40_000_010_000 &&
    fingerprint !== undefined
    ? { offset, fingerprint }
    : undefined;
}

export function knowledgeDocumentScope(document: Pick<KnowledgeDocument, "documentId">): string {
  return knowledgeDigest(`keiko-document|${String(document.documentId)}`).slice(0, 8);
}

export function knowledgeDocumentRevision(document: KnowledgeDocument): string {
  return knowledgeDigest(
    JSON.stringify([document.contentHash, document.mediaType, document.extractionStatus]),
  );
}

/** A fragment must also exist in the complete safe projection: slicing cannot expose a credential
 * whose identifying context lay just outside the requested range. Refused fragments stay missing. */
export function knowledgeSourceWindow(
  source: string,
  start: number,
  end: number,
  redact: (value: string) => string,
  projected?: string,
): string | undefined {
  const whole = projected ?? redact(source);
  if (whole === source) return source.slice(start, end);
  const fragment = redact(source.slice(start, end));
  return whole.includes(fragment) ? fragment : undefined;
}

export interface KnowledgeDocumentSnapshot {
  readonly documents: readonly KnowledgeDocument[];
  readonly scopes: readonly Scope[];
  readonly refusals: readonly ScopeRefusal[];
  readonly omittedCount: number;
  readonly totalCount: number;
  readonly fingerprint: string;
}

/** Deduplicate overlapping Pods and Pod sets while retaining each capsule's own source filter. */
function mergeScope(
  targets: Map<KnowledgeCapsuleId, Set<KnowledgeSourceId> | undefined>,
  scope: Scope,
): void {
  for (const capsule of scope.capsuleIds) {
    if (targets.has(capsule) && targets.get(capsule) === undefined) continue;
    if (scope.sourceFilter === undefined) targets.set(capsule, undefined);
    else targets.set(capsule, new Set([...(targets.get(capsule) ?? []), ...scope.sourceFilter]));
  }
}

function admittedScopes(
  deps: UiHandlerDeps,
  store: KnowledgeStore,
  chatId: string,
): {
  readonly scopes: readonly Scope[];
  readonly refusals: readonly ScopeRefusal[];
} {
  const targets = new Map<KnowledgeCapsuleId, Set<KnowledgeSourceId> | undefined>();
  const refusals: ScopeRefusal[] = [];
  for (const query of chatKnowledgeScopes(deps.store.findChatById(chatId))) {
    const resolved = resolveEnumerationScope(store, {
      ...(query.capsuleId === undefined ? {} : { capsuleId: query.capsuleId }),
      ...(query.capsuleSetId === undefined ? {} : { capsuleSetId: query.capsuleSetId }),
    });
    const refusal = resolved.ok ? scopeRefusal(resolved.scope.capsules ?? []) : "scope-unavailable";
    if (!resolved.ok || refusal !== undefined) {
      refusals.push(refusal ?? "scope-unavailable");
      continue;
    }
    mergeScope(targets, resolved.scope);
  }
  const scopes = [...targets].map(([capsule, filter]): Scope => ({
    capsuleIds: [capsule],
    ...(filter === undefined ? {} : { sourceFilter: [...filter] }),
  }));
  return { scopes, refusals };
}

/** Reads metadata for every admitted format, including files whose extraction failed. */
export function knowledgeDocumentSnapshot(
  deps: UiHandlerDeps,
  store: KnowledgeStore,
  chatId: string,
): KnowledgeDocumentSnapshot {
  const admitted = admittedScopes(deps, store, chatId);
  const documents: KnowledgeDocument[] = [];
  let totalCount = 0;
  for (const scope of admitted.scopes) {
    const read = QualityIntelligenceHandoff.listScopeDocumentInventory(
      store,
      scope,
      KNOWLEDGE_DOCUMENTS_MAX - documents.length,
    );
    documents.push(...read.documents);
    totalCount += read.totalCount;
  }
  const fingerprint = knowledgeDigest(
    JSON.stringify([
      admitted.scopes,
      admitted.refusals,
      totalCount,
      documents.map((document) => [document.documentId, knowledgeDocumentRevision(document)]),
    ]),
  );
  return {
    ...admitted,
    documents,
    totalCount,
    omittedCount: totalCount - documents.length,
    fingerprint,
  };
}

export function findKnowledgeDocument(
  snapshot: KnowledgeDocumentSnapshot,
  documentScope: unknown,
  revisionDigest: unknown,
): KnowledgeDocument | undefined {
  const found = snapshot.documents.filter(
    (document) => knowledgeDocumentScope(document) === documentScope,
  );
  const document = found.length === 1 ? found[0] : undefined;
  return document !== undefined && knowledgeDocumentRevision(document) === revisionDigest
    ? document
    : undefined;
}

/** The selected document is filtered inside the existing admitted reader, before its read bound. */
export function readKnowledgeDocument(
  store: KnowledgeStore,
  snapshot: KnowledgeDocumentSnapshot,
  document: KnowledgeDocument,
): ReadKnowledgeDocument | undefined {
  const scope = snapshot.scopes.find((candidate) =>
    candidate.capsuleIds.includes(document.capsuleId),
  );
  if (scope === undefined || document.extractionStatus !== "extracted") return undefined;
  return QualityIntelligenceHandoff.readScopeDocuments(store, scope, {
    maxDocuments: 1,
    documentIds: [document.documentId],
  }).documents[0];
}
