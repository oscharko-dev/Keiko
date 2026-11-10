import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import {
  executeAtlassianWriteRequest,
  type AtlassianWriteHttpDeps,
  type AtlassianWriteHttpOutcome,
  type AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";

type LocalRefusal = "effect-denied" | "cancelled" | "timeout";
type JiraAdmissionContext = Pick<ManagedMcpInvocationContext, "signal" | "beforeEffect">;
class JiraRequestRefusal extends Error {
  constructor(readonly reason: LocalRefusal) {
    super("The bound Jira request was not admitted.");
  }
}
function requireActive(context: JiraAdmissionContext, signal: AbortSignal): void {
  if (context.signal.aborted) throw new JiraRequestRefusal("cancelled");
  if (signal.aborted) throw new JiraRequestRefusal("timeout");
}
function requireAdmission(context: JiraAdmissionContext, signal: AbortSignal): void {
  requireActive(context, signal);
  const admitted: unknown = context.beforeEffect();
  // A synchronous guard may itself revoke the invocation. Never mistake a Promise for consent.
  requireActive(context, signal);
  if (admitted !== true) throw new JiraRequestRefusal("effect-denied");
}
function admittedHttp(
  connection: Pick<JiraManagedConnection, "http">,
  context: JiraAdmissionContext,
  signal: AbortSignal,
): AtlassianHttpBodyPort {
  let observed: Extract<AtlassianHttpBodyResult, { readonly kind: "response" }> | undefined;
  return async (request) => {
    try {
      requireAdmission(context, signal);
    } catch (error) {
      // Cancellation between the retry owner's check and this callback must not erase the
      // preceding real HTTP failure. Returning it makes the existing aborted retry loop settle.
      if (
        error instanceof JiraRequestRefusal &&
        error.reason !== "effect-denied" &&
        observed !== undefined
      )
        return observed;
      throw error;
    }
    const result = await connection.http(request);
    if (result.kind === "response") {
      observed = result;
      return result;
    }
    // A native response, including an ACK or HTTP failure, wins over late cancellation. Only
    // an actual transport outcome without a response can acquire this local abort cause.
    requireActive(context, signal);
    return result;
  };
}
/** Admission only: existing HTTP execution still owns URLs, bytes, retry and timeout bounds. */
export async function executeAdmittedJiraRequest(
  connection: Pick<JiraManagedConnection, "http">,
  context: JiraAdmissionContext,
  signal: AbortSignal,
  request: AtlassianWriteHttpRequest,
  timing: Pick<AtlassianWriteHttpDeps, "sleep"> = {},
): Promise<AtlassianWriteHttpOutcome> {
  try {
    requireActive(context, signal);
    return await executeAtlassianWriteRequest(
      {
        ...(timing.sleep === undefined ? {} : { sleep: timing.sleep }),
        signal,
        http: admittedHttp(connection, context, signal),
      },
      request,
    );
  } catch (error) {
    if (error instanceof JiraRequestRefusal) return { ok: false, reason: error.reason };
    throw error;
  }
}
