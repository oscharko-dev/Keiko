// A `git status` the runner's byte cap cut is a bounded, truncated read, not a failed one.
//
// A folder that is a Git repository with a large untracked tree (an un-ignored `node_modules` with
// tens of thousands of files) makes `git status --untracked-files=all` print more than the route's
// byte cap. The runner then kills git, so the run closes with `exitCode: null`, a `SIGTERM` signal
// and `truncated: true`. Treating that as a failure left the whole checkout unusable: the Git
// window and the Coding Workbench saw "status unavailable" for a perfectly healthy repository. The
// diff routes were repaired the same way in #4113 (`byteCapCutAsBoundedDiff`); this module owns the
// status half of that class for every status reader (route, summary, sync preview, post-sync read).
//
// Only a run the byte cap itself ended counts (`isCapTerminatedTruncation`): a timeout, an abort, a
// refusal, git error output and an exit status git chose on its own stay failures. Git's own
// `warning:` notices are not error output: a status that carries one is as valid as one that does
// not, cut or whole (`stderrHoldsOnlyGitWarnings`). The cut can
// land anywhere, so the incomplete tail is dropped: the text after the last NUL separator, and a
// rename/copy record whose second (old-path) record was cut off. A dangling old path must never be
// read as a file of its own. The branch header must have survived; without it there is no bounded
// answer and the run stays a failure.
//
// The line records only counts and the closed surface, never a path or a status body.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { GitProcessResult } from "@oscharko-dev/keiko-git";

import { correlationIdOrUnknown } from "./correlation.js";
import { isCapTerminatedTruncation, stderrHoldsOnlyGitWarnings } from "./gitProcessActivity.js";
import type { ServerLogSink } from "./observability/index.js";

export type PorcelainFormat = "v1" | "v2";
export type BoundedStatusSurface =
  "status" | "summary" | "sync-preview" | "sync-post-state" | "history";

export interface BoundedStatusLog {
  readonly sink: ServerLogSink;
  readonly correlationId: string | undefined;
}

export interface BoundedStatusContext {
  readonly format: PorcelainFormat;
  readonly surface: BoundedStatusSurface;
  readonly maxBytes: number;
  readonly log: BoundedStatusLog;
}

const GIT_STATUS_BOUNDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.status.bounded",
  category: "process",
  owner: "keiko-server",
  emitter: "gitStatusBounded.settleCapCutStatus",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["status", "summary", "sync-preview", "sync-post-state", "history"],
    },
    shownRecordCount: { type: "integer", dataClass: "count", required: true },
    partialRecordDropped: { type: "boolean", dataClass: "closed-enum", required: true },
    maxBytes: { type: "integer", dataClass: "count", required: true },
    // History only: records left unread from the first unreadable one on (never a record body).
    unreadableRecordCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-status-bounded"],
  proofIds: ["git.status.bounded.emitted-line"],
  releaseImpact: "patch",
});

function isRenameOrCopy(record: string, format: PorcelainFormat): boolean {
  if (format === "v2") return record.startsWith("2 ");
  if (record.startsWith("## ") || record.length < 3) return false;
  return ["R", "C"].includes(record[0] ?? "") || ["R", "C"].includes(record[1] ?? "");
}

// The v1 header is one record. The v2 header is a block of `# branch.*` records (oid, head and,
// with an upstream, upstream and ahead/behind), so a cut inside the block would read as a branch
// without an upstream. The block is known to be whole only when something of an entry follows it:
// a complete entry record, or the cut fragment of one (an entry never starts with `#`).
function hasWholeBranchHeader(
  pieces: readonly string[],
  tail: string,
  format: PorcelainFormat,
): boolean {
  if (format === "v1") return pieces[0]?.startsWith("## ") ?? false;
  if (!pieces.some((record) => record.startsWith("# branch.head "))) return false;
  const entryFollows = pieces.some((record) => !record.startsWith("# "));
  return entryFollows || (tail.length > 0 && !tail.startsWith("#"));
}

// Keeps whole records only. A rename/copy record owns the record after it; without that second
// record the pair is cut and the record is dropped.
function wholeRecords(records: readonly string[], format: PorcelainFormat): readonly string[] {
  for (let index = 0; index < records.length; index += 1) {
    if (!isRenameOrCopy(records[index] ?? "", format)) continue;
    if (index + 1 >= records.length) return records.slice(0, index);
    index += 1;
  }
  return records;
}

interface BoundedStatusRead {
  readonly result: GitProcessResult;
  readonly bounded: boolean;
  readonly shownRecordCount: number;
  readonly partialRecordDropped: boolean;
}

export function boundCapCutStatus(
  result: GitProcessResult,
  format: PorcelainFormat,
): BoundedStatusRead {
  const unchanged = { result, bounded: false, shownRecordCount: 0, partialRecordDropped: false };
  if (!isCapTerminatedTruncation(result) || result.refusal !== undefined) return unchanged;
  if (!stderrHoldsOnlyGitWarnings(result.stderr)) return unchanged;
  const pieces = result.stdout.split("\0");
  const tail = pieces.pop() ?? "";
  if (!hasWholeBranchHeader(pieces, tail, format)) return unchanged;
  const records = wholeRecords(pieces, format);
  return {
    result: {
      ...result,
      exitCode: 0,
      stdout: records.map((record) => `${record}\0`).join(""),
      truncated: true,
    },
    bounded: true,
    shownRecordCount: records.length,
    partialRecordDropped: tail.length > 0 || records.length < pieces.length,
  };
}

/**
 * Turns a byte-cap-terminated status run into the bounded, successful read the routes report as
 * `truncated: true`, and records it. Any other result is returned untouched.
 */
export function settleCapCutStatus(
  result: GitProcessResult,
  context: BoundedStatusContext,
): GitProcessResult {
  const read = boundCapCutStatus(result, context.format);
  if (!read.bounded) return result;
  context.log.sink.write(
    activityLogEvent(
      GIT_STATUS_BOUNDED_OPERATION,
      { correlationId: correlationIdOrUnknown(context.log.correlationId) },
      {
        surface: context.surface,
        shownRecordCount: read.shownRecordCount,
        partialRecordDropped: read.partialRecordDropped,
        maxBytes: context.maxBytes,
      },
    ),
  );
  return read.result;
}

export interface BoundedHistoryRead {
  readonly shownRecordCount: number;
  readonly partialRecordDropped: boolean;
  readonly unreadableRecordCount: number;
  readonly maxBytes: number;
}

/**
 * Records that a History page ended early: the byte cap cut its last record (dropped, never counted
 * short) or a record could not be read (the page stops there so the continuation stays exact).
 */
export function logBoundedHistory(log: BoundedStatusLog, read: BoundedHistoryRead): void {
  log.sink.write(
    activityLogEvent(
      GIT_STATUS_BOUNDED_OPERATION,
      { correlationId: correlationIdOrUnknown(log.correlationId) },
      { surface: "history", ...read },
    ),
  );
}
