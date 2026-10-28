// The raw diff view of the local user's own repository (#4113, #4114).
//
// A diff cut at its byte cap is reconciled into a complete patch before redaction, and a file whose
// hunks do not parse on their own keeps them readable under the credential floor, as standalone
// OpenCode shows them: keys, tokens, passwords and configured secrets stay masked. Every other
// redaction caller keeps whole-file masking. The line records only counts and the closed truncation
// state, never the diff, a path or a secret.

import { Buffer } from "node:buffer";
import type { GitRepositoryDiffResponse } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-security";

import { correlationIdOrUnknown } from "./correlation.js";
import { currentRedactionSecrets, type UiHandlerDeps } from "./deps.js";
import { completeTruncatedDiffPrefix } from "./gitDiffTruncation.js";
import type { ServerLogSink } from "./observability/index.js";

const GIT_DIFF_VIEW_BOUNDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.diff.view-bounded",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDiffView.redactedDiffViewBody",
  fields: {
    truncated: { type: "boolean", dataClass: "closed-enum", required: true },
    shownBytes: { type: "integer", dataClass: "count", required: true },
    maxBytes: { type: "integer", dataClass: "count", required: true },
    credentialFloorFileCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-diff-view-bounded"],
  proofIds: ["git.diff.view-bounded.emitted-line"],
  releaseImpact: "patch",
});

export interface DiffViewLog {
  readonly sink: ServerLogSink;
  readonly correlationId: string | undefined;
}

export function redactedDiffViewBody(
  deps: UiHandlerDeps,
  body: GitRepositoryDiffResponse,
  log: DiffViewLog,
): GitRepositoryDiffResponse {
  const diff = body.truncated ? completeTruncatedDiffPrefix(body.diff) : body.diff;
  let credentialFloorFileCount = 0;
  const redactString = createAuditRedactor(
    { additionalSecrets: currentRedactionSecrets(deps) },
    deps.env,
    {
      onUnparsedDiffHunkFloor: () => {
        credentialFloorFileCount += 1;
      },
    },
  );
  const redacted = deepRedactStrings({ ...body, diff }, redactString) as GitRepositoryDiffResponse;
  if (body.truncated || credentialFloorFileCount > 0) {
    log.sink.write(
      activityLogEvent(
        GIT_DIFF_VIEW_BOUNDED_OPERATION,
        { correlationId: correlationIdOrUnknown(log.correlationId) },
        {
          truncated: body.truncated,
          shownBytes: Buffer.byteLength(diff, "utf8"),
          maxBytes: body.maxBytes,
          credentialFloorFileCount,
        },
      ),
    );
  }
  return redacted;
}
