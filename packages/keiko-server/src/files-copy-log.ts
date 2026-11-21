import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { FilesEntryKind } from "@oscharko-dev/keiko-contracts/bff-wire";
import { correlationIdOrUnknown } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

// #4429: a Files copy refuses a link inside the copied tree (a symbolic link or, on Windows, a
// directory junction) and a copied entry that escapes the root or lands on a denied path. The HTTP
// line alone records only a 400/403 on the copy route, so it could not say which guard refused, at
// which stage, nor whether the partial copy was removed again. Closed values only: never a path.
export type FilesCopyRefusalStage = "copy-filter" | "post-copy-audit";
export type FilesCopyRefusalCode =
  "UNSUPPORTED" | "PATH_ESCAPE" | "DENIED" | "STALE_PATH" | "OTHER";
export type FilesCopyCleanup = "removed" | "remove-failed";

const FILES_COPY_REFUSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "files.copy.refused",
  category: "security",
  owner: "keiko-server",
  emitter: "files-copy-log.recordFilesCopyRefusal",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["refused"],
    },
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["copy-filter", "post-copy-audit"],
    },
    code: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["UNSUPPORTED", "PATH_ESCAPE", "DENIED", "STALE_PATH", "OTHER"],
    },
    entryKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["file", "directory", "symlink"],
    },
    cleanup: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["removed", "remove-failed"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  failureClasses: ["files-copy-containment-refusal"],
  proofIds: ["files.copy.refused.link"],
  releaseImpact: "patch",
});

export interface FilesCopyRefusal {
  readonly stage: FilesCopyRefusalStage;
  readonly code: string;
  readonly entryKind: FilesEntryKind;
  readonly cleanup: FilesCopyCleanup;
}

const CLOSED_CODES: ReadonlySet<string> = new Set<FilesCopyRefusalCode>([
  "UNSUPPORTED",
  "PATH_ESCAPE",
  "DENIED",
  "STALE_PATH",
]);

function isClosedCode(code: string): code is FilesCopyRefusalCode {
  return CLOSED_CODES.has(code);
}

function closedCode(code: string): FilesCopyRefusalCode {
  return isClosedCode(code) ? code : "OTHER";
}

export function recordFilesCopyRefusal(
  refusal: FilesCopyRefusal,
  correlationId: string | undefined,
): void {
  processServerLogSink().write(
    activityLogEvent(
      FILES_COPY_REFUSED,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: "warn",
        errorKind: "unsafe-target",
      },
      {
        outcome: "refused",
        stage: refusal.stage,
        code: closedCode(refusal.code),
        entryKind: refusal.entryKind,
        cleanup: refusal.cleanup,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
