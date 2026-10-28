// #3903 AC3: the relay a native coding run reaches a credentialed remote MCP server through, on the
// SAME attested loopback port as the model gateway and the tool facade. The request carries the
// X-Keiko-CSRF header and the run's relay capability that its binding configures, so no CSRF
// exemption is needed; the relay authenticates the capability itself (`mcpCredentialRelay.ts`).
import { correlationIdOrUnknown } from "./correlation.js";
import { serveMcpRelayRequest, type McpRelayMethod } from "./mcp/mcpCredentialRelay.js";
import type { UiHandlerDeps } from "./deps.js";
import { processServerLogSink } from "./process-log-sink.js";
import type { HandlerOutcome, RouteContext } from "./routes.js";
import { STREAMING } from "./route-outcome.js";

const UNAVAILABLE_UPSTREAM = (): Promise<Response> =>
  Promise.reject(new TypeError("mcp-relay-unavailable"));

/** GET, POST and DELETE /api/coding-sidecar/mcp/:relayId -- the MCP Streamable HTTP transport. */
export async function handleCodingSidecarMcpRelay(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  await serveMcpRelayRequest(
    ctx.req,
    ctx.res,
    { relayId: ctx.params.relayId ?? "", method: ctx.req.method as McpRelayMethod },
    {
      relay: deps.mcpRelay?.relay,
      upstream: deps.mcpRelay?.upstream ?? UNAVAILABLE_UPSTREAM,
      activityLog: processServerLogSink(),
      correlationId: correlationIdOrUnknown(ctx.correlationId),
    },
  );
  return STREAMING;
}
