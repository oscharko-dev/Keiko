import type {
  CodingRuntimePermissionDecision,
  CodingRuntimePermissionPort,
} from "./codingRuntimePermissionPort.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";

export function createOpenCodeRuntimePermissionPort(
  runPort: Pick<OpenCodeRunPort, "replyPermission">,
): CodingRuntimePermissionPort {
  return {
    resolve: (request): Promise<boolean> =>
      runPort.replyPermission(
        request.runId,
        request.requestId,
        request.decision === "approved" ? "once" : "reject",
      ),
  };
}

interface PermissionRunRecord {
  readonly permissionPort?: CodingRuntimePermissionPort | undefined;
}

export function createProductionRuntimePermissionPort(
  runs: ReadonlyMap<string, PermissionRunRecord>,
): CodingRuntimePermissionPort {
  return {
    resolve: (request) => resolveRuntimePermission(runs, request),
  };
}

async function resolveRuntimePermission(
  runs: ReadonlyMap<string, PermissionRunRecord>,
  request: CodingRuntimePermissionDecision,
): Promise<boolean> {
  const port = runs.get(request.runId)?.permissionPort;
  if (port === undefined) return true;
  try {
    return await port.resolve(request);
  } catch {
    return false;
  }
}
