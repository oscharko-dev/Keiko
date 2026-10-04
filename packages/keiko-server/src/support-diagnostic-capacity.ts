// The existing health diagnostics expose bounded storage usage without turning candidates into bugs.
import {
  supportIncidentRetentionPolicy,
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
type CapacityDeps = Pick<UiHandlerDeps, "env" | "diagnostics">;
type CapacityContext = Pick<RouteContext, "correlationId">;
const observedCounts = new WeakMap<CapacityDeps, string>();
function recordCapacity(
  ctx: CapacityContext,
  deps: CapacityDeps,
  count: number,
  capacity: number,
): void {
  const snapshot = `${String(count)}:${String(capacity)}`;
  if (observedCounts.get(deps) === snapshot) return;
  observedCounts.set(deps, snapshot);
  getServerLogger().info(
    activityLogEvent(
      CAPACITY,
      { correlationId: correlationIdOrUnknown(ctx.correlationId) },
      {
        retainedCandidateCount: count,
        candidateCapacity: capacity,
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
export function supportDiagnosticCapacity(ctx: CapacityContext, deps: CapacityDeps): Capacity {
  const stateDir = resolveActivityLogStateDir(deps.env);
  if (stateDir === undefined) return {};
  try {
    const count = listSupportIncidents(stateDir, { readOnly: true }).length;
    const capacity = supportIncidentRetentionPolicy(stateDir, deps.env).capacity;
    recordCapacity(ctx, deps, count, capacity);
    return {
      retainedDiagnosticCount: count,
      diagnosticCapacity: capacity,
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
