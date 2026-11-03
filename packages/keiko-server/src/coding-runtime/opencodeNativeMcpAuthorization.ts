import { createHash } from "node:crypto";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  CodingWorkbenchMcpAuthorizationRefusal,
  CodingWorkbenchMcpAuthorizationStart,
  CodingWorkbenchMcpAuthorizationState,
  CodingWorkbenchMcpServer,
  CodingWorkbenchMcpServerStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  MCP_OAUTH_AUTHORIZATION_REFUSALS,
  mcpOAuthAuthorizationRefusal,
  type McpOAuthAuthorizationRefusal,
} from "../mcp/mcpOAuthAuthorizationUrl.js";
import type { AdmittedMcpOAuthServer } from "./opencodeNativeMcp.js";
import type { OpenCodeNativeMcpGrants } from "./opencodeNativePolicy.js";
import type {
  OpenCodeV2HttpClient,
  OpenCodeV2McpServer,
  OpenCodeV2McpStatus,
  OpenCodeV2OAuthAttempt,
} from "./opencodeV2HttpClient.js";

/**
 * A live native run's MCP servers and the human's authorization of one that uses OAuth (#3903 AC3).
 * The runtime runs its own authorization (dynamic registration when no client is named, PKCE S256,
 * the RFC 8707 resource, its own loopback callback), so nothing of the original flow is replaced.
 * Keiko decides what reaches the human: an attempt only for a server the run admitted with a
 * validated issuer, and its URL only when it addresses that issuer's validated authorization
 * endpoint with the request the operator accepted (`mcpOAuthAuthorizationUrl.ts`). Any other URL is
 * withdrawn at once. The runtime's error text and the URL never enter the log.
 */
export interface McpAuthorizationRun {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly mcp?: OpenCodeNativeMcpGrants | undefined;
  readonly mcpOAuth?: ReadonlyMap<string, AdmittedMcpOAuthServer> | undefined;
  readonly client: Pick<
    OpenCodeV2HttpClient,
    "mcpServers" | "connectMcpOAuth" | "mcpOAuthStatus" | "cancelMcpOAuth"
  >;
}

export interface OpenCodeMcpAuthorizationRunPort {
  /** The run's admitted servers with their status; `undefined` when the run offers none. */
  readonly listMcpServers: (
    runId: string,
    correlationId?: string,
  ) => Promise<readonly CodingWorkbenchMcpServer[] | undefined>;
  readonly startMcpAuthorization: (
    runId: string,
    server: string,
    correlationId?: string,
  ) => Promise<CodingWorkbenchMcpAuthorizationStart>;
  readonly mcpAuthorizationStatus: (
    runId: string,
    server: string,
    attemptId: string,
    correlationId?: string,
  ) => Promise<CodingWorkbenchMcpAuthorizationState>;
  readonly cancelMcpAuthorization: (
    runId: string,
    server: string,
    attemptId: string,
    correlationId?: string,
  ) => Promise<CodingWorkbenchMcpAuthorizationState>;
}

export interface OpenCodeMcpAuthorizationRunPortDeps {
  readonly readyRun: (runId: string) => McpAuthorizationRun | undefined;
  readonly activityLog: ServerLogSink | undefined;
  /** Called once an attempt completed, so the credential can be kept for later runs. */
  readonly onAuthorized?: ((run: McpAuthorizationRun, server: string) => void) | undefined;
}

/** At most this many open attempts per run; a further one replaces the oldest. */
const MAX_OPEN_ATTEMPTS = 8;
const MAX_TRACKED_ATTEMPTS = 64;

interface OpenAttempt {
  readonly runId: string;
  readonly server: string;
  readonly integrationId: string;
}

const STATUS_VIEW: Readonly<Record<OpenCodeV2McpStatus, CodingWorkbenchMcpServerStatus>> = {
  connected: "connected",
  "needs-auth": "needs-authorization",
  failed: "failed",
  disabled: "disabled",
  pending: "pending",
};

export function createOpenCodeMcpAuthorizationRunPort(
  deps: OpenCodeMcpAuthorizationRunPortDeps,
): OpenCodeMcpAuthorizationRunPort {
  const attempts = new Map<string, OpenAttempt>();
  const remember = (attemptId: string, attempt: OpenAttempt): void => {
    const open = [...attempts].filter(([, entry]) => entry.runId === attempt.runId);
    if (open.length >= MAX_OPEN_ATTEMPTS && open[0] !== undefined) attempts.delete(open[0][0]);
    attempts.set(attemptId, attempt);
    // Runs end without settling their attempts: the composition's whole table stays bounded too.
    for (const [stale] of attempts) {
      if (attempts.size <= MAX_TRACKED_ATTEMPTS) break;
      attempts.delete(stale);
    }
  };
  const opened = (runId: string, server: string, attemptId: string): OpenAttempt | undefined => {
    const attempt = attempts.get(attemptId);
    return attempt?.runId === runId && attempt.server === server ? attempt : undefined;
  };
  return {
    listMcpServers: (runId, correlationId) => listServers(deps, runId, correlationId),
    startMcpAuthorization: (runId, server, correlationId) =>
      startAuthorization(deps, { runId, server, correlationId }, remember),
    mcpAuthorizationStatus: (runId, server, attemptId, correlationId) =>
      attemptState(deps, { runId, server, correlationId }, attemptId, opened, attempts, "status"),
    cancelMcpAuthorization: (runId, server, attemptId, correlationId) =>
      attemptState(deps, { runId, server, correlationId }, attemptId, opened, attempts, "cancel"),
  };
}

interface AuthorizationRequest {
  readonly runId: string;
  readonly server: string;
  readonly correlationId: string | undefined;
}

function serverView(
  name: string,
  listed: readonly OpenCodeV2McpServer[],
  run: McpAuthorizationRun,
): CodingWorkbenchMcpServer {
  const entry = listed.find((server) => server.name === name);
  return {
    name,
    // The runtime connects a server on the location's first use: one not listed yet is pending.
    status: entry === undefined ? "pending" : STATUS_VIEW[entry.status],
    authorization: run.mcpOAuth?.has(name) === true ? "oauth" : "none",
  };
}

async function listServers(
  deps: OpenCodeMcpAuthorizationRunPortDeps,
  runId: string,
  correlationId: string | undefined,
): Promise<readonly CodingWorkbenchMcpServer[] | undefined> {
  const run = deps.readyRun(runId);
  const admitted = run?.mcp?.servers;
  if (run === undefined || admitted === undefined || admitted.size === 0) return undefined;
  try {
    const listed = await run.client.mcpServers(run.workspaceRoot);
    const servers = [...admitted.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => serverView(name, listed, run));
    recordMcpAuthorization(deps.activityLog, runId, correlationId, {
      action: "listed",
      outcome: "ok",
      serverCount: servers.length,
      needsAuthorizationCount: servers.filter(({ status }) => status === "needs-authorization")
        .length,
    });
    return servers;
  } catch (error) {
    recordMcpAuthorization(deps.activityLog, runId, correlationId, {
      action: "listed",
      outcome: "failed",
      error,
    });
    return undefined;
  }
}

function recordRefusal(
  deps: OpenCodeMcpAuthorizationRunPortDeps,
  request: AuthorizationRequest,
  reason: CodingWorkbenchMcpAuthorizationRefusal,
  details: Pick<AuthorizationLine, "urlRefusal" | "error"> = {},
): CodingWorkbenchMcpAuthorizationStart {
  recordMcpAuthorization(deps.activityLog, request.runId, request.correlationId, {
    action: "started",
    outcome: reason,
    server: request.server,
    ...details,
  });
  return { outcome: "refused", reason };
}

async function startAuthorization(
  deps: OpenCodeMcpAuthorizationRunPortDeps,
  request: AuthorizationRequest,
  remember: (attemptId: string, attempt: OpenAttempt) => void,
): Promise<CodingWorkbenchMcpAuthorizationStart> {
  const run = deps.readyRun(request.runId);
  if (run === undefined) return recordRefusal(deps, request, "unavailable");
  const admitted = run.mcpOAuth?.get(request.server);
  if (admitted === undefined) return recordRefusal(deps, request, "not-oauth");
  try {
    const listed = await run.client.mcpServers(run.workspaceRoot);
    const entry = listed.find((server) => server.name === request.server);
    if (entry?.status === "connected") return recordRefusal(deps, request, "connected");
    if (entry?.integrationId === undefined) return recordRefusal(deps, request, "unavailable");
    const attempt = await run.client.connectMcpOAuth(entry.integrationId, run.workspaceRoot);
    const urlRefusal = attemptRefusal(attempt, admitted);
    if (urlRefusal !== undefined) {
      // The attempt is withdrawn before anything of it reaches the human.
      await run.client.cancelMcpOAuth(entry.integrationId, attempt.attemptId, run.workspaceRoot);
      return recordRefusal(deps, request, "url-refused", { urlRefusal });
    }
    remember(attempt.attemptId, {
      runId: request.runId,
      server: request.server,
      integrationId: entry.integrationId,
    });
    recordMcpAuthorization(deps.activityLog, request.runId, request.correlationId, {
      action: "started",
      outcome: "ok",
      server: request.server,
    });
    return {
      outcome: "started",
      attemptId: attempt.attemptId,
      authorizationUrl: attempt.url,
      expiresAtMs: attempt.expiresAtMs,
    };
  } catch (error) {
    return recordRefusal(deps, request, "failed", { error });
  }
}

// Only the runtime's own loopback completion is admitted; a code pasted elsewhere is not this flow.
function attemptRefusal(
  attempt: OpenCodeV2OAuthAttempt,
  admitted: AdmittedMcpOAuthServer,
): McpOAuthAuthorizationRefusal | "mode-unsupported" | undefined {
  if (attempt.mode !== "auto") return "mode-unsupported";
  return mcpOAuthAuthorizationRefusal(attempt.url, {
    authorizationEndpoint: admitted.authorizationEndpoint,
    serverUrl: admitted.url,
    clientId: admitted.oauth.clientId,
  });
}

async function attemptState(
  deps: OpenCodeMcpAuthorizationRunPortDeps,
  request: AuthorizationRequest,
  attemptId: string,
  opened: (runId: string, server: string, attemptId: string) => OpenAttempt | undefined,
  attempts: Map<string, OpenAttempt>,
  action: "status" | "cancel",
): Promise<CodingWorkbenchMcpAuthorizationState> {
  const attempt = opened(request.runId, request.server, attemptId);
  const run = deps.readyRun(request.runId);
  const line = {
    action: action === "cancel" ? "cancelled" : "status",
    server: request.server,
  } as const;
  if (attempt === undefined || run === undefined) {
    recordMcpAuthorization(deps.activityLog, request.runId, request.correlationId, {
      ...line,
      outcome: "unavailable",
    });
    return "unavailable";
  }
  try {
    const state = await settledState(run, attempt, attemptId, action);
    // The Workbench reads an open attempt every few seconds: only a settled one is a line.
    if (state === "pending") return state;
    attempts.delete(attemptId);
    if (state === "complete") deps.onAuthorized?.(run, request.server);
    recordMcpAuthorization(deps.activityLog, request.runId, request.correlationId, {
      ...line,
      outcome: state,
    });
    return state;
  } catch (error) {
    recordMcpAuthorization(deps.activityLog, request.runId, request.correlationId, {
      ...line,
      outcome: "failed",
      error,
    });
    return "failed";
  }
}

async function settledState(
  run: McpAuthorizationRun,
  attempt: OpenAttempt,
  attemptId: string,
  action: "status" | "cancel",
): Promise<CodingWorkbenchMcpAuthorizationState> {
  if (action === "cancel") {
    await run.client.cancelMcpOAuth(attempt.integrationId, attemptId, run.workspaceRoot);
    return "cancelled";
  }
  return run.client.mcpOAuthStatus(attempt.integrationId, attemptId, run.workspaceRoot);
}

const ACTIONS = ["listed", "started", "status", "cancelled"] as const;
const OUTCOMES = [
  "ok",
  "unavailable",
  "not-oauth",
  "connected",
  "url-refused",
  "failed",
  "pending",
  "complete",
  "expired",
  "cancelled",
] as const;
const URL_REFUSALS = [...MCP_OAUTH_AUTHORIZATION_REFUSALS, "mode-unsupported"] as const;

const COUNT = { type: "integer", dataClass: "count", required: false } as const;

const MCP_AUTHORIZATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.mcp-authorization",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeMcpAuthorization.recordMcpAuthorization",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: { type: "string", dataClass: "closed-enum", required: true, values: [...ACTIONS] },
    outcome: { type: "string", dataClass: "closed-enum", required: true, values: [...OUTCOMES] },
    // SHA-256 of the registry's server name: which server, without its name.
    serverSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    urlRefusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...URL_REFUSALS],
    },
    serverCount: COUNT,
    needsAuthorizationCount: COUNT,
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
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
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["url-refused", "failed"] }],
  failureClasses: ["coding-runtime-mcp-authorization"],
  proofIds: ["coding-runtime.mcp-authorization.emitted-line"],
  releaseImpact: "patch",
});

interface AuthorizationLine {
  readonly action: (typeof ACTIONS)[number];
  readonly outcome: (typeof OUTCOMES)[number];
  readonly server?: string | undefined;
  readonly urlRefusal?: McpOAuthAuthorizationRefusal | "mode-unsupported" | undefined;
  readonly serverCount?: number | undefined;
  readonly needsAuthorizationCount?: number | undefined;
  readonly error?: unknown;
}

/** Closed values, counts and a digest of the server name; never a URL, an issuer or a token. */
export function recordMcpAuthorization(
  activityLog: ServerLogSink | undefined,
  runId: string,
  correlationId: string | undefined,
  line: AuthorizationLine,
): void {
  const warn = line.outcome === "url-refused" || line.outcome === "failed";
  activityLog?.write(
    activityLogEvent(
      MCP_AUTHORIZATION_OPERATION,
      {
        correlationId: correlationId ?? runId,
        ...(warn ? { level: "warn" as const } : {}),
        ...(line.error === undefined ? {} : { errorKind: "internal" as const }),
      },
      { runId, action: line.action, outcome: line.outcome, ...optionalFields(line) },
    ),
  );
}

function optionalFields(line: AuthorizationLine): Readonly<Record<string, unknown>> {
  const { server, urlRefusal, serverCount, needsAuthorizationCount, error } = line;
  return {
    ...(server === undefined
      ? {}
      : { serverSha256: createHash("sha256").update(server, "utf8").digest("hex") }),
    ...(urlRefusal === undefined ? {} : { urlRefusal }),
    ...(serverCount === undefined ? {} : { serverCount }),
    ...(needsAuthorizationCount === undefined ? {} : { needsAuthorizationCount }),
    ...(error === undefined
      ? {}
      : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
  };
}
