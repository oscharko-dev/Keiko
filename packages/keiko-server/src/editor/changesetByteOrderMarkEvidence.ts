import type { EditorAgentAction } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { PatchInspectionFile } from "@oscharko-dev/keiko-tools";
import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ChangesetProvenanceStage } from "./changesetLineBreakProvenance.js";

const CHANGESET_BYTE_ORDER_MARK_COUNT_FIELD = {
  type: "integer",
  dataClass: "count",
  required: true,
} as const;

// 2026-11-06: every model edit of a file that starts with a UTF-8 byte order mark was refused
// CONTENT_HASH_MISMATCH, because the patch inspection hashed the raw text while the model's read
// and the server's diff use the decoded text without the mark. The inspection now binds such a file
// to its decoded text and writes the mark back. One line per inspection that met a mark: how many
// changeset files carried one, and whether the diff left it to the write (`signature`) or spelled it
// as its own text (`diff-text`). Counts only: no path, no text.
const CHANGESET_BYTE_ORDER_MARK_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.agent.changeset-byte-order-mark",
  category: "security",
  owner: "keiko-server",
  emitter: "editor.changesetByteOrderMarkEvidence.recordChangesetByteOrderMarks",
  fields: {
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admission", "result"],
    },
    fileCount: CHANGESET_BYTE_ORDER_MARK_COUNT_FIELD,
    signatureFileCount: CHANGESET_BYTE_ORDER_MARK_COUNT_FIELD,
    diffTextFileCount: CHANGESET_BYTE_ORDER_MARK_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["coding-editor-mutation"],
  proofIds: ["editor.agent.changeset-byte-order-mark.emitted-line"],
  releaseImpact: "patch",
});

export interface ChangesetByteOrderMarkInput {
  readonly action: EditorAgentAction;
  readonly files: readonly Pick<PatchInspectionFile, "byteOrderMark">[];
  readonly stage: ChangesetProvenanceStage;
  readonly correlationId: string | undefined;
}

/** Writes the line when at least one inspected changeset file carries a byte order mark. */
export function recordChangesetByteOrderMarks(input: ChangesetByteOrderMarkInput): void {
  if (input.action.type !== "applyChangeset") return;
  const signatureFileCount = countOf(input.files, "signature");
  const diffTextFileCount = countOf(input.files, "diff-text");
  if (signatureFileCount + diffTextFileCount === 0) return;
  processServerLogSink().write(
    activityLogEvent(
      CHANGESET_BYTE_ORDER_MARK_OPERATION,
      { correlationId: correlationIdOrUnknown(input.correlationId), level: "info" },
      {
        stage: input.stage,
        fileCount: input.files.length,
        signatureFileCount,
        diffTextFileCount,
      },
    ),
  );
}

function countOf(
  files: readonly Pick<PatchInspectionFile, "byteOrderMark">[],
  byteOrderMark: PatchInspectionFile["byteOrderMark"],
): number {
  return files.filter((file) => file.byteOrderMark === byteOrderMark).length;
}
