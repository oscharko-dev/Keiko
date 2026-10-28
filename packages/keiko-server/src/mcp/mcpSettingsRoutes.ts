import { parseMcpSettingsUpdate } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "../deps.js";
import { errorBody } from "../route-error.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { RouteContext, RouteResult } from "../routes.js";

type SettingsDeps = Pick<UiHandlerDeps, "mcpSettings" | "codingAppSessionChannel">;
const denied = (): RouteResult => ({
  status: 403,
  body: errorBody("FORBIDDEN", "An active app session is required."),
});
const unavailable = (): RouteResult => ({
  status: 503,
  body: errorBody("MCP_SETTINGS_UNAVAILABLE", "MCP settings are unavailable."),
});

export function handleGetMcpSettings(ctx: RouteContext, deps: SettingsDeps): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return denied();
  if (deps.mcpSettings === undefined) return unavailable();
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: deps.mcpSettings.read(ctx.correlationId ?? UNKNOWN_CORRELATION_ID),
  };
}

export async function handlePutMcpSettings(
  ctx: RouteContext,
  deps: SettingsDeps,
): Promise<RouteResult> {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (authority === undefined) return denied();
  const store = deps.mcpSettings;
  if (store === undefined) return unavailable();
  const body = await readJsonRequestBodyOutcome(ctx.req, 1024 * 1024, ctx.correlationId);
  const current = resolveAppSessionReadAuthority(deps, ctx.req);
  if (
    current?.sessionId !== authority.sessionId ||
    current.rotationCount !== authority.rotationCount
  )
    return denied();
  if (body.kind === "rejected") return body.response;
  const update = parseMcpSettingsUpdate(body.value);
  if (update === undefined)
    return { status: 400, body: errorBody("BAD_REQUEST", "MCP settings are invalid.") };
  const result = store.update(update, ctx.correlationId ?? UNKNOWN_CORRELATION_ID);
  if (!result.ok)
    return {
      status: 409,
      body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reload before saving."),
    };
  return { status: 200, headers: { "cache-control": "no-store" }, body: result.snapshot };
}
