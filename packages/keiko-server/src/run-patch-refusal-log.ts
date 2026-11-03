// A refused workflow patch is activity, not silence (#4110). The unit-test and bug-investigation
// workflows report every patch validation on their own event stream; a refusal carries a closed
// rejection code, but the stream is an SSE frame that is gone once nobody is attached. Before this,
// the Activity Log held the run's terminal outcome only, so an operator could not tell a patch the
// size bound refused from one the scope guard refused. This is one line per refused validation, with
// the closed reason and the sizes, joinable under the run's own id. Counts and closed words only:
// never the diff, a path or the model's prose (ADR-0173 D4). The harness needs no line of its own: a
// patch over its bound already ends the run as `harness.run.failed` with the closed code
// `HARNESS_LIMIT_PATCH_SIZE` (sink.ts).

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { correlationIdOrUnknown } from "./correlation.js";
import { processServerLogSink } from "./process-log-sink.js";

/** The refusal reasons a workflow patch validation can report; anything else reads `unspecified`. */
type RunPatchRefusalReason =
  | "size-limit"
  | "line-limit"
  | "file-limit"
  | "binary"
  | "path-unsafe"
  | "path-denied"
  | "malformed"
  | "out-of-scope"
  | "test-only"
  | "empty"
  | "unspecified";

const RUN_PATCH_REFUSAL_REASONS: ReadonlySet<string> = new Set<RunPatchRefusalReason>([
  "size-limit",
  "line-limit",
  "file-limit",
  "binary",
  "path-unsafe",
  "path-denied",
  "malformed",
  "out-of-scope",
  "test-only",
  "empty",
  "unspecified",
]);

const RUN_PATCH_REFUSAL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "runs.patch.refused",
  category: "http",
  owner: "keiko-server",
  emitter: "run-patch-refusal-log.logRunPatchRefusal",
  fields: {
    workflow: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["unit-tests", "bug-investigation"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "size-limit",
        "line-limit",
        "file-limit",
        "binary",
        "path-unsafe",
        "path-denied",
        "malformed",
        "out-of-scope",
        "test-only",
        "empty",
        "unspecified",
      ],
    },
    patchBytes: { type: "integer", dataClass: "count", required: true },
    fileCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["workflow-run-patch-refusal"],
  proofIds: ["runs.patch.refused.line"],
  releaseImpact: "patch",
});

// The two workflow event types that report a patch validation, by the workflow that emits them.
const PATCH_VALIDATION_EVENT_WORKFLOWS: Readonly<
  Record<string, "unit-tests" | "bug-investigation">
> = { "patch:validated": "unit-tests", "bug:patch:validated": "bug-investigation" };

/** What a patch-validation event carries; read defensively, the sink is structurally typed. */
interface PatchValidationRaw {
  readonly ok?: unknown;
  readonly rejectionCode?: unknown;
  readonly patchBytes?: unknown;
  readonly filesChanged?: unknown;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRefusalReason(value: unknown): value is RunPatchRefusalReason {
  return typeof value === "string" && RUN_PATCH_REFUSAL_REASONS.has(value);
}

function refusalReason(value: unknown): RunPatchRefusalReason {
  return isRefusalReason(value) ? value : "unspecified";
}

/**
 * Records one refused patch validation of a workflow run, when `event` is one. Any other event, and
 * an accepted validation, write nothing. Never throws into the SSE fan-out it runs beside: the
 * activity-log sink swallows its own write failures.
 */
export function logRunPatchRefusal(
  event: { readonly type: string; readonly runId: string },
  activityLog: ServerLogSink = processServerLogSink(),
): void {
  const workflow = PATCH_VALIDATION_EVENT_WORKFLOWS[event.type];
  if (workflow === undefined) return;
  const raw = event as unknown as PatchValidationRaw;
  if (raw.ok !== false) return;
  activityLog.write(
    activityLogEvent(
      RUN_PATCH_REFUSAL_OPERATION,
      { correlationId: correlationIdOrUnknown(event.runId) },
      {
        workflow,
        reason: refusalReason(raw.rejectionCode),
        patchBytes: count(raw.patchBytes),
        fileCount: count(raw.filesChanged),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
