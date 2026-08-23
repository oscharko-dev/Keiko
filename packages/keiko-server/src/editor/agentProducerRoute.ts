// Issue #2489 (Findings 1/2) -- the Keiko-native producer that gives EditorAgentToolHost its first
// production consumer. A governed model turn (harness createSession, the "editor-agent-turn" task
// plan) is driven with a tool surface scoped to the four retrofit editor-agent tools
// (navigateSymbol, searchWorkspace, queryGit, requestVerification). Every tool call this turn makes
// still dispatches through the SAME EditorAgentHttpClient -> agentRoutes.ts / agentVerificationRoute.ts
// path a human-driven browser-bridge action takes. Before the model turn, this route reuses the M11
// root resolver, trust store, and authority registry to bind the producer itself to one current root;
// every tool call then repeats the normal downstream admission. Reuse Gate: no second tool host, no
// parallel schema, no bespoke HTTP transport.

import { randomUUID } from "node:crypto";
import {
  createSession,
  MemoryEventSink,
  type HarnessEvent,
  type ModelPort,
  type ToolCallCompletedEvent,
  type ToolCallResult,
  type ToolPort,
} from "@oscharko-dev/keiko-harness";
import {
  createFetchEditorAgentHttpTransport,
  EditorAgentHttpClient,
  EditorAgentToolHost,
  type EditorAgentToolOutput,
} from "@oscharko-dev/keiko-tools";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentGovernedAuthorityReference,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { readJsonObject } from "../files.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { editorAgentAuthorityRegistry } from "./agentAuthorityRegistry.js";
import {
  EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE,
  resolveEditorAgentActionRoot,
} from "./agentRootBoundary.js";

// Scope IN (#2489): the first Keiko-native producer is restricted to the four tools whose
// dispatch is server-resolved (navigateSymbol/searchWorkspace/queryGit) or synchronously governed
// (requestVerification). The five review-gated mutation tools (openFile/.../applyChangeset) need a
// live human reviewer attached to the browser bridge and stay out of this slice.
const PRODUCER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "editor_navigate_symbol",
  "editor_search_workspace",
  "editor_git_context",
  "editor_request_verification",
]);

const MAX_PRODUCER_BODY_BYTES = 65_536;
const MAX_GOAL_CHARS = 4_000;

// A content-free (enum/boolean only, never raw content) per-call outcome the producer surfaces
// alongside toolCallCount/toolNames -- without this, a caller (or a reachability test) cannot tell
// "the tool was invoked" apart from "the tool was invoked and immediately conflicted", e.g. a
// missing live bridge connection (NO_ACTIVE_SESSION) still counts as an invoked, completed harness
// tool call. `status` mirrors EditorAgentActionResult.status / EditorAgentVerificationResult.outcome,
// already-exposed enums elsewhere (audit ledger, action responses) -- not new disclosure.
// `failureKind` (Issue #2713) answers the same question on the failing side. Before it, `ok:false`
// was the ONLY discriminator a failed call carried, collapsing a transport abort, a route rejection,
// a malformed response, a cancellation, an invalid-arguments rejection and the producer's own
// out-of-scope refusal into one indistinguishable value -- an agent could not decide whether to
// retry, and a failing CI run named no cause at all. It is a closed union of OUR OWN literals,
// never a value read back out of a response body, so it stays content-free.
interface ProducerToolOutcome {
  readonly toolName: string;
  readonly ok: boolean;
  readonly status?: string;
  readonly failureKind?: string;
}

// Derived from the tool output's own failure union rather than hand-mirrored, so a kind added at the
// owning layer cannot silently start degrading to a cause-free `{ ok: false }` here: `Record` demands
// every member, so the omission is a compile error in this file instead.
type ProducerFailureKind = Extract<EditorAgentToolOutput, { readonly ok: false }>["error"]["kind"];

const PRODUCER_FAILURE_KINDS: Readonly<Record<ProducerFailureKind, true>> = {
  cancelled: true,
  transport: true,
  route: true,
  "malformed-response": true,
  "invalid-arguments": true,
  host: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads whichever status-like enum the tool's own output shape carries: EditorAgentActionResult
// uses `status` (navigateSymbol/searchWorkspace/queryGit); EditorAgentVerificationResult uses
// `outcome` (requestVerification). Both are already-exposed enums (never raw content).
function resultStatusEnum(result: Record<string, unknown>): string | undefined {
  if (typeof result.status === "string") return result.status;
  if (typeof result.outcome === "string") return result.outcome;
  return undefined;
}

// Fail closed: only a known kind is surfaced, so a malformed or unexpected error shape degrades to
// the previous content-free `{ toolName, ok: false }` rather than echoing whatever string it carried.
function producerFailureKind(parsed: unknown): string | undefined {
  const error: unknown = isRecord(parsed) ? parsed.error : undefined;
  const kind: unknown = isRecord(error) ? error.kind : undefined;
  return typeof kind === "string" && Object.hasOwn(PRODUCER_FAILURE_KINDS, kind) ? kind : undefined;
}

function producerFailureOutcome(toolName: string, parsed: unknown): ProducerToolOutcome {
  const failureKind = producerFailureKind(parsed);
  return failureKind === undefined ? { toolName, ok: false } : { toolName, ok: false, failureKind };
}

function producerToolOutcome(toolName: string, rawOutput: string): ProducerToolOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return { toolName, ok: false };
  }
  if (!isRecord(parsed) || parsed.ok !== true) return producerFailureOutcome(toolName, parsed);
  const status = isRecord(parsed.result) ? resultStatusEnum(parsed.result) : undefined;
  return status === undefined ? { toolName, ok: true } : { toolName, ok: true, status };
}

// The fail-closed arms above cannot be reached through the route: every tool output the producer
// ever parses is produced in-process by EditorAgentToolHost, so no real dispatch can hand it an
// unknown kind or a non-record payload. Exposing the pure parser is the only way to prove the guards
// actually degrade instead of echoing (AGENTS.md §10 -- both branches of every guard). Same
// `_...ForTests` seam convention as `_resetEditorAgentAuditForTests` in agentActionAudit.ts.
export const _producerToolOutcomeForTests = producerToolOutcome;

// Fail-closed rejection for a tool call outside PRODUCER_TOOL_NAMES, in the SAME
// EditorAgentToolOutput shape EditorAgentToolHost itself uses for invalid arguments -- a hostile
// or prompt-injected model turn can emit a tool_call for ANY name regardless of what listTools()
// advertised (ADR-0004: model output is untrusted and never executed as an instruction), so the
// tool surface must be enforced at dispatch, not only at advertisement.
function outOfScopeToolResult(request: { toolCallId: string; toolName: string }): ToolCallResult {
  const output = JSON.stringify({
    ok: false,
    error: {
      kind: "invalid-arguments",
      code: "INVALID_ARGUMENTS",
      message: `Tool '${request.toolName}' is outside the producer's governed tool surface.`,
    },
  });
  return { toolCallId: request.toolCallId, output, durationMs: 0 };
}

function scopedProducerToolPort(
  host: EditorAgentToolHost,
  outcomes: ProducerToolOutcome[],
): ToolPort {
  return {
    listTools: () => host.listTools().filter((tool) => PRODUCER_TOOL_NAMES.has(tool.name)),
    execute: async (request): Promise<ToolCallResult> => {
      if (!PRODUCER_TOOL_NAMES.has(request.toolName)) {
        const rejection = outOfScopeToolResult(request);
        outcomes.push(producerToolOutcome(request.toolName, rejection.output));
        return rejection;
      }
      const result = await host.execute(request);
      outcomes.push(producerToolOutcome(request.toolName, result.output));
      return result;
    },
  };
}

interface ParsedProducerTurnRequest {
  readonly sessionId: string;
  readonly modelId: string;
  readonly goal: string;
  readonly authorityRef: { readonly runId: string; readonly envelopeDigest: string };
}

function isAuthorityRefShape(
  value: unknown,
): value is { readonly runId: string; readonly envelopeDigest: string } {
  return isEditorAgentGovernedAuthorityReference(value);
}

function parseProducerTurnRequest(
  body: Record<string, unknown>,
): ParsedProducerTurnRequest | undefined {
  if (body.schemaVersion !== EDITOR_AGENT_SCHEMA_VERSION) return undefined;
  const { sessionId, modelId, goal, authorityRef } = body;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof modelId !== "string" ||
    modelId.length === 0 ||
    typeof goal !== "string" ||
    goal.length === 0 ||
    goal.length > MAX_GOAL_CHARS ||
    !isAuthorityRefShape(authorityRef)
  ) {
    return undefined;
  }
  return { sessionId, modelId, goal, authorityRef };
}

function isRouteResult(value: Record<string, unknown> | RouteResult): value is RouteResult {
  return "status" in value && "body" in value;
}

function isToolCallCompleted(event: HarnessEvent): event is ToolCallCompletedEvent {
  return event.type === "tool:call:completed";
}

interface ProducerTurnResult {
  readonly schemaVersion: typeof EDITOR_AGENT_SCHEMA_VERSION;
  readonly runId: string;
  readonly outcome: string;
  readonly toolCallCount: number;
  readonly toolNames: readonly string[];
  readonly toolOutcomes: readonly ProducerToolOutcome[];
}

// Reads the local (server-bound) port off the live connection so the producer calls itself over a
// real loopback HTTP hop -- the same transport a browser-bridge caller uses -- without any new
// self-origin configuration. EditorAgentHttpClient independently re-validates the origin is
// loopback-only (127.0.0.1/localhost/[::1], http:, no path/credentials).
function selfOrigin(ctx: RouteContext): string | undefined {
  const port = ctx.req.socket.localPort;
  return port === undefined ? undefined : `http://127.0.0.1:${String(port)}`;
}

type BuildToolHostOutcome =
  | { readonly ok: true; readonly host: EditorAgentToolHost }
  | { readonly ok: false; readonly response: RouteResult };

function buildProducerToolHost(
  ctx: RouteContext,
  authorityRef: ParsedProducerTurnRequest["authorityRef"],
  rootBinding: NonNullable<ReturnType<typeof editorAgentRegistry.snapshotFor>>["rootBinding"],
): BuildToolHostOutcome {
  const origin = selfOrigin(ctx);
  if (origin === undefined) {
    return {
      ok: false,
      response: {
        status: 500,
        body: errorBody(
          "SELF_ORIGIN_UNAVAILABLE",
          "The server's own loopback origin could not be resolved.",
        ),
      },
    };
  }
  try {
    return {
      ok: true,
      host: new EditorAgentToolHost({
        client: new EditorAgentHttpClient({
          baseUrl: origin,
          transport: createFetchEditorAgentHttpTransport(),
        }),
        authorityRef,
        rootBinding,
        nextActionId: randomUUID,
      }),
    };
  } catch {
    return {
      ok: false,
      response: {
        status: 400,
        body: errorBody("AUTHORITY_INVALID", "The supplied authority reference is malformed."),
      },
    };
  }
}

async function runProducerTurn(
  request: ParsedProducerTurnRequest,
  workspaceRoot: string,
  model: ModelPort,
  host: EditorAgentToolHost,
): Promise<ProducerTurnResult> {
  const outcomes: ProducerToolOutcome[] = [];
  const session = createSession(
    { taskType: "editor-agent-turn", input: { goal: request.goal, sessionId: request.sessionId } },
    { model: request.modelId, workingDirectory: workspaceRoot },
    { model, tools: scopedProducerToolPort(host, outcomes), sink: new MemoryEventSink() },
  );
  const result = await session.result;
  const toolCompletions = result.events.filter(isToolCallCompleted);
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    runId: session.runId,
    outcome: result.outcome,
    toolCallCount: toolCompletions.length,
    toolNames: [...new Set(toolCompletions.map((event) => event.toolName))],
    toolOutcomes: outcomes,
  };
}

type ProducerAdmission =
  | { readonly ok: true; readonly snapshot: EditorAgentSessionSnapshot }
  | { readonly ok: false; readonly response: RouteResult };

function producerAdmission(
  request: ParsedProducerTurnRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: UiHandlerDeps,
): ProducerAdmission {
  const rooted = resolveEditorAgentActionRoot(snapshot, snapshot.rootBinding, deps.store);
  if (!rooted.ok) {
    return {
      ok: false,
      response: {
        status: 403,
        body: errorBody(
          EDITOR_AGENT_ROOT_BOUNDARY_ERROR_CODE[rooted.reason],
          "The producer turn is not authorized for this workspace root.",
        ),
      },
    };
  }
  const authority = editorAgentAuthorityRegistry.resolve(
    request.authorityRef,
    rooted.root.workspaceRoot,
    deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist",
    new Date().toISOString(),
  );
  if (!authority.ok) return producerAdmissionDenied("AUTHORITY_INVALID");
  try {
    if (deps.workspaceScriptTrust?.trustLevelForRoot(rooted.root.workspaceRoot) !== "trusted") {
      return producerAdmissionDenied("WORKSPACE_RESTRICTED");
    }
  } catch {
    return producerAdmissionDenied("WORKSPACE_RESTRICTED");
  }
  return {
    ok: true,
    snapshot:
      rooted.root.workspaceRoot === snapshot.workspaceRoot
        ? snapshot
        : { ...snapshot, workspaceRoot: rooted.root.workspaceRoot },
  };
}

function producerAdmissionDenied(
  code: "AUTHORITY_INVALID" | "WORKSPACE_RESTRICTED",
): Extract<ProducerAdmission, { readonly ok: false }> {
  return {
    ok: false,
    response: {
      status: 403,
      body: errorBody(code, "The producer turn is not authorized for this workspace root."),
    },
  };
}

export async function handleEditorAgentProducerTurn(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonObject(ctx.req, MAX_PRODUCER_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const request = parseProducerTurnRequest(body);
  if (request === undefined) {
    if (body.authorityRef !== undefined && !isAuthorityRefShape(body.authorityRef)) {
      return {
        status: 400,
        body: errorBody("AUTHORITY_INVALID", "The supplied authority reference is malformed."),
      };
    }
    return { status: 400, body: errorBody("INVALID_REQUEST", "Producer turn request is invalid.") };
  }
  const snapshot = editorAgentRegistry.snapshotFor(request.sessionId);
  if (snapshot === undefined || !editorAgentRegistry.hasLiveBridge(request.sessionId)) {
    return {
      status: 404,
      body: errorBody("SESSION_NOT_FOUND", "No live editor session for the given sessionId."),
    };
  }
  const admission = producerAdmission(request, snapshot, deps);
  if (!admission.ok) return admission.response;
  const rootedSnapshot = admission.snapshot;
  const model = deps.modelPortFactory(request.modelId);
  if (model === undefined) {
    return {
      status: 503,
      body: errorBody("MODEL_UNAVAILABLE", "No model is configured for the producer turn."),
    };
  }
  const hostOutcome = buildProducerToolHost(ctx, request.authorityRef, rootedSnapshot.rootBinding);
  if (!hostOutcome.ok) return hostOutcome.response;
  const summary = await runProducerTurn(
    request,
    rootedSnapshot.workspaceRoot,
    model,
    hostOutcome.host,
  );
  return { status: 200, body: summary };
}
