import type {
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type {
  HtmlManualCitationCheckResult,
  HtmlManualCitationOpenUnavailableReason,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  resolveHtmlManualCitationTarget,
  type HtmlManualCitationTargetFailureReason,
} from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { readJsonRequestBodyOutcome } from "./bounded-request-body.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { classifyManualCitationTarget } from "./manual/documentation-target.js";
import { getServerLogger } from "./observability/index.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";

export const HTML_MANUAL_CITATION_TARGET_PREFIX = "keiko-html-manual-citation:" as const;
const MAX_CITATION_TARGET_LENGTH = 4_096;
const MAX_CITATION_BODY_BYTES = 8_000;

const MANUAL_CITATION_CHECK = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "knowledge.citation.manual-check",
  category: "search",
  owner: "keiko-server",
  emitter: "html-manual-citation-navigation.handleCheckHtmlManualCitation",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["verified", "unavailable"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  diagnosticWhen: [{ field: "outcome", values: ["unavailable"] }],
  analyzerProjection: "timeline",
  failureClasses: ["knowledge-citation-manual-check"],
  proofIds: ["knowledge.citation.manual-check.line"],
  releaseImpact: "patch",
});

export interface HtmlManualCitationTargetPayload {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
  readonly chunkId: ChunkId;
  readonly anchorId?: string;
}

type HtmlManualCitationNavigationResolution =
  | { readonly kind: "resolved"; readonly target: string }
  | { readonly kind: "failed"; readonly reason: HtmlManualCitationOpenUnavailableReason };

export function buildHtmlManualCitationNavigationTarget(
  payload: HtmlManualCitationTargetPayload,
): string {
  return `${HTML_MANUAL_CITATION_TARGET_PREFIX}${Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  )}`;
}

function resolveHtmlManualCitationNavigationTarget(
  deps: UiHandlerDeps,
  target: string,
): HtmlManualCitationNavigationResolution {
  const payload = parseHtmlManualCitationNavigationTarget(target);
  if (payload === undefined) {
    return { kind: "failed", reason: "target-unsupported" };
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

export function checkHtmlManualCitation(
  deps: UiHandlerDeps,
  target: string,
): HtmlManualCitationCheckResult {
  const resolution = resolveHtmlManualCitationNavigationTarget(deps, target);
  if (resolution.kind === "failed") return { state: "unavailable", reason: resolution.reason };
  const classification = classifyManualCitationTarget(resolution.target);
  return classification.ok
    ? { state: "verified" }
    : { state: "unavailable", reason: classification.reason };
}

export async function handleCheckHtmlManualCitation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const read = await readJsonRequestBodyOutcome(
    ctx.req,
    MAX_CITATION_BODY_BYTES,
    ctx.correlationId,
  );
  if (read.kind === "rejected") return read.response;
  const target = read.value["target"];
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > MAX_CITATION_TARGET_LENGTH
  ) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "Invalid citation reference.", ctx.correlationId),
    };
  }
  const body = checkHtmlManualCitation(deps, target);
  getServerLogger().info(
    activityLogEvent(
      MANUAL_CITATION_CHECK,
      { correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        outcome: body.state,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
  return { status: 200, body };
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
