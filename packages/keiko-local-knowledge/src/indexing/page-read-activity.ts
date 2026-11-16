// The Activity Log line of a PDF page that could not be read. One broken page never ends the
// document, so nothing above the parser learns of the failure: this line keeps its classified cause
// under the job's correlation, never its message or the page text.

import { createHash } from "node:crypto";

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  emitKnowledgeLogEvent,
  knowledgeLogCorrelationId,
  type KnowledgeLogSink,
} from "../knowledge-log.js";
import { failureErrorKind } from "./orchestrator-activity-log.js";
import type { IndexingLogContext } from "./types.js";

export type PageReadLogContext = IndexingLogContext & { readonly documentIdDigest: string };

export interface PageReadFailure {
  readonly context: PageReadLogContext;
  readonly stage: "window" | "resume";
  readonly pageNumber: number;
  readonly failureKind: string;
}

const DOCUMENT_PAGE_READ_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "indexing.document.page-read-failed",
  category: "indexing",
  owner: "keiko-local-knowledge",
  emitter: "indexing/page-read-activity.emitPageReadFailure",
  fields: {
    capsuleIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    documentIdDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["window", "resume"],
    },
    pageNumber: { type: "integer", dataClass: "count", required: true },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["document-page-read"],
  proofIds: ["indexing.document.page-read-failed.stage"],
  releaseImpact: "patch",
});

/** The digest a document carries on this line, as on every other indexing line of the document. */
export function pageReadDocumentDigest(documentId: string): string {
  return createHash("sha256").update(documentId).digest("hex").slice(0, 16);
}

export function emitPageReadFailure(
  sink: KnowledgeLogSink | undefined,
  failure: PageReadFailure,
): void {
  emitKnowledgeLogEvent(
    sink,
    activityLogEvent(
      DOCUMENT_PAGE_READ_FAILED_OPERATION,
      {
        level: "warn",
        correlationId: knowledgeLogCorrelationId(failure.context.jobId),
        errorKind: failureErrorKind(failure.failureKind),
      },
      {
        capsuleIdDigest: failure.context.capsuleIdDigest,
        documentIdDigest: failure.context.documentIdDigest,
        stage: failure.stage,
        pageNumber: failure.pageNumber,
        failureKind: failure.failureKind,
      },
    ),
  );
}
