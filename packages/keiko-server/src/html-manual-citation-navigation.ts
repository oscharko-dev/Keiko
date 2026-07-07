import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { HtmlManualCitationOpenUnavailableReason } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  resolveHtmlManualCitationTarget,
  type HtmlManualCitationTargetFailureReason,
} from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";

export const HTML_MANUAL_CITATION_TARGET_PREFIX = "keiko-html-manual-citation:" as const;

export interface HtmlManualCitationTargetPayload {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly anchorId?: string;
}

export type HtmlManualCitationNavigationResolution =
  | { readonly kind: "not-citation-target" }
  | { readonly kind: "resolved"; readonly target: string }
  | { readonly kind: "failed"; readonly reason: HtmlManualCitationOpenUnavailableReason };

export function buildHtmlManualCitationNavigationTarget(
  payload: HtmlManualCitationTargetPayload,
): string {
  return `${HTML_MANUAL_CITATION_TARGET_PREFIX}${Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  )}`;
}

export function resolveHtmlManualCitationNavigationTarget(
  deps: UiHandlerDeps,
  target: string,
): HtmlManualCitationNavigationResolution {
  const payload = parseHtmlManualCitationNavigationTarget(target);
  if (payload === undefined) {
    return target.startsWith(HTML_MANUAL_CITATION_TARGET_PREFIX)
      ? { kind: "failed", reason: "target-unsupported" }
      : { kind: "not-citation-target" };
  }
  let env: ReturnType<typeof openKnowledgeStoreForDeps> | undefined;
  try {
    env = openKnowledgeStoreForDeps(deps);
    if (!chunkBelongsToDocument(env.store, payload)) {
      return { kind: "failed", reason: "citation-lineage-mismatch" };
    }
    const resolved = resolveHtmlManualCitationTarget(env.store, payload);
    return resolved.ok
      ? { kind: "resolved", target: resolved.target }
      : { kind: "failed", reason: mapTargetFailureReason(resolved.reason) };
  } catch {
    return { kind: "failed", reason: "source-metadata-unavailable" };
  } finally {
    env?.close();
  }
}

interface ChunkLineageRow {
  readonly document_id: string;
}

// Epic #1854 post-merge audit — `chunkId` was accepted and type-checked but never verified to
// actually belong to the resolved `documentId`, giving a false sense of chunk-level scope
// enforcement. Reject a citation handle whose chunk does not resolve under the same capsule,
// source, and document with the existing `citation-lineage-mismatch` reason rather than a new one.
function chunkBelongsToDocument(
  store: ReturnType<typeof openKnowledgeStoreForDeps>["store"],
  payload: HtmlManualCitationTargetPayload,
): boolean {
  const row = store._internal.db
    .prepare(
      [
        "SELECT document_id FROM chunks",
        "WHERE capsule_id = :capsuleId AND source_id = :sourceId AND id = :chunkId",
      ].join(" "),
    )
    .get({
      capsuleId: String(payload.capsuleId),
      sourceId: String(payload.sourceId),
      chunkId: String(payload.chunkId),
    }) as ChunkLineageRow | undefined;
  return row?.document_id === String(payload.documentId);
}

function parseHtmlManualCitationNavigationTarget(
  target: string,
): HtmlManualCitationTargetPayload | undefined {
  if (!target.startsWith(HTML_MANUAL_CITATION_TARGET_PREFIX)) return undefined;
  const encoded = target.slice(HTML_MANUAL_CITATION_TARGET_PREFIX.length);
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isHtmlManualCitationTargetPayload(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isHtmlManualCitationTargetPayload(
  value: unknown,
): value is HtmlManualCitationTargetPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.capsuleId === "string" &&
    typeof record.sourceId === "string" &&
    typeof record.documentId === "string" &&
    typeof record.chunkId === "string" &&
    (record.anchorId === undefined || typeof record.anchorId === "string")
  );
}

function mapTargetFailureReason(
  reason: HtmlManualCitationTargetFailureReason,
): HtmlManualCitationOpenUnavailableReason {
  if (reason === "citation-lineage-mismatch") return "citation-lineage-mismatch";
  if (reason === "target-outside-approved-scope") return "target-outside-approved-scope";
  if (reason === "target-unsupported") return "target-unsupported";
  return "source-metadata-unavailable";
}
