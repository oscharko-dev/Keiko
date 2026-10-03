// The existing health diagnostics expose bounded storage usage without turning candidates into bugs.
import {
  MAX_SUPPORT_INCIDENTS,
  listSupportIncidents,
  resolveActivityLogStateDir,
} from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";
import type { ActivityLogReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";
import type { RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const CAPACITY = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "support.diagnostics.capacity",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "support-diagnostic-capacity.recordCapacity",
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["support-incident"],
  releaseImpact: "patch",
  fields: {
    retainedCandidateCount: { type: "integer", dataClass: "count", required: true },
    candidateCapacity: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  proofIds: ["support.diagnostics.capacity.line"],
});
const observedCounts = new WeakMap<UiHandlerDeps, number>();
function recordCapacity(ctx: RouteContext, deps: UiHandlerDeps, count: number): void {
  if (observedCounts.get(deps) === count) return;
  observedCounts.set(deps, count);
  getServerLogger().info(
    activityLogEvent(
      CAPACITY,
      { correlationId: correlationIdOrUnknown(ctx.correlationId) },
      {
        retainedCandidateCount: count,
        candidateCapacity: MAX_SUPPORT_INCIDENTS,
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}

type Capacity = Pick<
  ActivityLogReadinessSnapshot,
  "retainedDiagnosticCount" | "diagnosticCapacity"
>;
export function supportDiagnosticCapacity(ctx: RouteContext, deps: UiHandlerDeps): Capacity {
  const stateDir = resolveActivityLogStateDir(deps.env);
  if (stateDir === undefined) return {};
  try {
    const count = listSupportIncidents(stateDir, { readOnly: true }).length;
    recordCapacity(ctx, deps, count);
    return {
      retainedDiagnosticCount: count,
      diagnosticCapacity: MAX_SUPPORT_INCIDENTS,
    };
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: correlationIdOrUnknown(ctx.correlationId),
        operation: "GET /api/health",
        source: "support.diagnostic-capacity",
        error,
        redact: (message): string => message,
      }),
    );
    return {};
  }
}
