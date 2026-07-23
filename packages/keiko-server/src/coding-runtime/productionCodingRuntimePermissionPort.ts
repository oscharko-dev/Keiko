import type {
  CodingRuntimePermissionDecision,
  CodingRuntimePermissionPort,
} from "./codingRuntimePermissionPort.js";
import { isProjectedOpenCodePermissionRequestId } from "./opencodeProtocol.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";

export function createOpenCodeRuntimePermissionPort(
  runPort: Pick<OpenCodeRunPort, "replyPermission">,
): CodingRuntimePermissionPort {
  return {
    // Only child-projected permission ids have a child-side ask to settle; server-originated
    // asks (research approvals, #2387) are already settled by the server's own issuance.
    resolve: (request): Promise<boolean> =>
      isProjectedOpenCodePermissionRequestId(request.requestId)
        ? runPort.replyPermission(
            request.runId,
            request.requestId,
            request.decision === "approved" ? "once" : "reject",
          )
        : Promise.resolve(true),
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
