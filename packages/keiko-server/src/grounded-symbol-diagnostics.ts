import { createHash } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { causeChain, errorKindOf, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
} from "@oscharko-dev/keiko-workspace";
import {
  WorkspaceDescriptorReadError,
  type WorkspaceDescriptorReadFailureReason,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { correlationIdOrUnknown } from "./correlation.js";
import type { ServerLogger } from "./observability/index.js";
import { isExpectedWorkspaceRootFailure } from "./workspace-root-denial-log.js";

const SYMBOL_LINE_UNAVAILABLE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "search.symbol-line.unavailable",
  category: "search",
  owner: "keiko-server",
  emitter: "grounded-symbol-diagnostics.recordSymbolLineUnavailable",
  fields: {
    scopePathDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "permission-denied",
        "containment-denied",
        "source-changed",
        "read-limit",
        "filesystem-unavailable",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "failure-cluster",
  failureClasses: ["connected-context-retrieval"],
  proofIds: ["search.symbol-line.unavailable.line"],
  releaseImpact: "patch",
});

type SymbolReadUnavailableReason =
  | "permission-denied"
  | "containment-denied"
  | "source-changed"
  | "read-limit"
  | "filesystem-unavailable";

const DESCRIPTOR_REASONS: Readonly<
  Record<WorkspaceDescriptorReadFailureReason, SymbolReadUnavailableReason>
> = {
  changed: "source-changed",
  "directory-membership-changed": "source-changed",
  "hard-link": "containment-denied",
  "not-regular": "source-changed",
  "outside-root": "containment-denied",
  "symbolic-link": "containment-denied",
  "too-large": "read-limit",
};

function symbolReadUnavailableReason(error: unknown): SymbolReadUnavailableReason | undefined {
  if (error instanceof PathDeniedError || error instanceof PathEscapeError)
    return "containment-denied";
  if (error instanceof WorkspaceDescriptorReadError) return DESCRIPTOR_REASONS[error.reason];
  if (error instanceof FileTooLargeError) return "read-limit";
  const code = errorKindOf(error);
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  return error instanceof WorkspaceReadError || isExpectedWorkspaceRootFailure(error)
    ? "filesystem-unavailable"
    : undefined;
}

function symbolReadErrorKind(reason: SymbolReadUnavailableReason): ActivityLogErrorKind {
  if (reason === "permission-denied" || reason === "containment-denied") return "permission-denied";
  if (reason === "source-changed") return "target-mutated";
  return "unavailable";
}

interface SymbolDiagnosticContext {
  readonly logger: ServerLogger | undefined;
  readonly correlationId: string;
}

function recordSymbolLineUnavailable(
  error: unknown,
  scopePath: string,
  context: SymbolDiagnosticContext,
): void {
  const reason = symbolReadUnavailableReason(error);
  // Unexpected failures belong to the terminal retrieval owner, with the original cause intact.
  if (reason === undefined) throw error;
  const frames = keikoStackFrames(error);
  const causes = causeChain(error);
  context.logger?.warn(() =>
    activityLogEvent(
      SYMBOL_LINE_UNAVAILABLE_OPERATION,
      { correlationId: context.correlationId, errorKind: symbolReadErrorKind(reason) },
      {
        scopePathDigest: createHash("sha256").update(scopePath).digest("hex"),
        reason,
        failureKind: errorKindOf(error),
        ...(frames.length === 0 ? {} : { frames }),
        ...(causes.length === 0 ? {} : { causeChain: causes }),
        completeness: "partial",
        loss: "none",
      },
    ),
  );
}

export type SymbolReadFailureObserver = (error: unknown, scopePath: string) => void;

export function createSymbolReadFailureObserver(
  logger: ServerLogger | undefined,
  correlationId: string | undefined,
): SymbolReadFailureObserver {
  const context: SymbolDiagnosticContext = {
    logger,
    correlationId: correlationIdOrUnknown(correlationId),
  };
  return (error, scopePath): void => {
    recordSymbolLineUnavailable(error, scopePath, context);
  };
}
