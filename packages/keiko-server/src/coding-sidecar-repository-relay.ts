// #4522: the relay a native coding run reads a credentialed Maven or npm repository through, on the
// SAME attested loopback port as the model gateway, the tool facade and the MCP relay. Only GET and
// HEAD are routed (a repository is read, never written), so the request needs no CSRF header; the
// relay authenticates the run's capability itself (`repository-relay/repositoryCredentialRelay.ts`).
import { correlationIdOrUnknown } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import { processServerLogSink } from "./process-log-sink.js";
import { serveRepositoryRelayRequest } from "./repository-relay/repositoryCredentialRelay.js";
import type { HandlerOutcome, RouteContext } from "./routes.js";
import { STREAMING } from "./route-outcome.js";

const UNAVAILABLE_UPSTREAM = (): Promise<Response> =>
  Promise.reject(new TypeError("repository-relay-unavailable"));

/** GET and HEAD /api/coding-sidecar/repository/:relayId/*path -- one repository file. */
export async function handleCodingSidecarRepositoryRelay(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  await serveRepositoryRelayRequest(
    ctx.req,
    ctx.res,
    { relayId: ctx.params.relayId ?? "" },
    {
      relay: deps.repositoryRelay?.relay,
      upstream: deps.repositoryRelay?.upstream ?? UNAVAILABLE_UPSTREAM,
      activityLog: processServerLogSink(),
      correlationId: correlationIdOrUnknown(ctx.correlationId),
    },
  );
  return STREAMING;
}
