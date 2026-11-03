import { isMcpAuthorizationAttemptId } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext, RouteResult } from "../routes.js";
import { errorBody } from "../route-error.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, contentFreeErrorClass } from "../diagnostics-log.js";

type Deps = Pick<UiHandlerDeps, "mcpAuthorization" | "codingAppSessionChannel" | "diagnostics">;
type Action = "start" | "status" | "cancel" | "revoke";
interface Authority {
  readonly owner: NonNullable<Deps["mcpAuthorization"]>;
  readonly session: string;
  readonly current: () => boolean;
}
const denied = (): RouteResult => ({
  status: 403,
  body: errorBody("DENIED", "An active app session is required."),
});
function result(body: unknown): RouteResult {
  return { status: 200, headers: { "cache-control": "no-store" }, body };
}
async function observe(
  ctx: RouteContext,
  authority: Authority,
  cancel: boolean,
): Promise<RouteResult> {
  const input = await readJsonRequestBodyOutcome(ctx.req, 1024, ctx.correlationId);
  if (input.kind === "rejected") return input.response;
  const value = input.value;
  if (Object.keys(value).length !== 1 || !isMcpAuthorizationAttemptId(value.attemptId))
    return { status: 400, body: errorBody("BAD_REQUEST", "Invalid authorization attempt.") };
  if (!authority.current()) return denied();
  const server = ctx.params.serverName ?? "";
  if (cancel) authority.owner.cancel(server, authority.session, value.attemptId);
  return result({ state: authority.owner.status(server, authority.session, value.attemptId) });
}
async function dispatch(
  ctx: RouteContext,
  authority: Authority,
  action: Action,
): Promise<RouteResult> {
  const server = ctx.params.serverName ?? "";
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  if (action === "start") {
    const answer = await authority.owner.start(
      server,
      authority.session,
      authority.current,
      correlationId,
    );
    return authority.current() ? result(answer) : denied();
  }
  if (action === "revoke") {
    authority.owner.revoke(server, correlationId);
    return result({ state: "revoked" });
  }
  return observe(ctx, authority, action === "cancel");
}
async function authorization(ctx: RouteContext, deps: Deps, action: Action): Promise<RouteResult> {
  const session = resolveAppSessionReadAuthority(deps, ctx.req);
  if (session === undefined) return denied();
  const owner = deps.mcpAuthorization;
  if (owner === undefined)
    return {
      status: 503,
      body: errorBody("MCP_SETTINGS_UNAVAILABLE", "MCP authorization is unavailable."),
    };
  const current = (): boolean => {
    const observed = resolveAppSessionReadAuthority(deps, ctx.req);
    return (
      observed?.sessionId === session.sessionId && observed.rotationCount === session.rotationCount
    );
  };
  try {
    return await dispatch(ctx, { owner, current, session: session.sessionId }, action);
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
      timestamp: new Date().toISOString(),
      operation: "mcp.connection",
      source: "mcp.authorization",
      errorClass: contentFreeErrorClass(error),
      message: "runtime-turn-failed",
      code: "stage=mcp-authorization",
    });
    return {
      status: 502,
      body: errorBody("MCP_AUTHORIZATION_FAILED", "MCP authorization failed."),
    };
  }
}
export const handleStartMcpAuthorization = (ctx: RouteContext, deps: Deps): Promise<RouteResult> =>
  authorization(ctx, deps, "start");
export const handleMcpAuthorizationStatus = (ctx: RouteContext, deps: Deps): Promise<RouteResult> =>
  authorization(ctx, deps, "status");
export const handleCancelMcpAuthorization = (ctx: RouteContext, deps: Deps): Promise<RouteResult> =>
  authorization(ctx, deps, "cancel");
export const handleRevokeMcpAuthorization = (ctx: RouteContext, deps: Deps): Promise<RouteResult> =>
  authorization(ctx, deps, "revoke");
