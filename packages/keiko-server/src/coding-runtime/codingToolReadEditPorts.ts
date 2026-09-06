import { createHash } from "node:crypto";
import type {
  EditorAgentAction,
  EditorAgentChangeset,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import type { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import {
  detectWorkspaceAt,
  discoverWithStats,
  isDenied,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";

import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import {
  correlationIdOrUnknown,
  isValidCorrelationId,
  UNKNOWN_CORRELATION_ID,
} from "../correlation.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import { isExactEditorAgentChangeset, type CodingToolReadResult } from "./codingToolIpc.js";
import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import type {
  CodingRuntimeEditorMutationLeaseCoordinator,
  CodingRuntimeEditorMutationLeaseRequest,
  CodingRuntimeMutationOutcome,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { ServerLogSink } from "../observability/server-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";

const MAX_READ_BYTES = 65_536;
const RAW_SINGLE_FILE_PATCH =
  /^:[0-7]{6} [0-7]{6} [a-f0-9]{7,64} [a-f0-9]{7,64} M ([^\r\n]+)\r?\n(@@ [\s\S]+)$/u;

type RepositoryReadRequest = CodingToolActionOf<"read">;
type RepositoryDiscoverRequest = CodingToolActionOf<"discover">;
type EditorChangesetRequest = CodingToolActionOf<"edit">;

// A rejected edit's reason code is a closed, content-free vocabulary (EditorAgentConflictCode /
// EditorAgentFailureCode, plus this port's own transport/no-session markers) — never raw command
// output — so, unlike the other governed ports, it is safe for `codingToolFacade.ts` to forward
// verbatim instead of collapsing it to the bare status.
//
// `message`, where present, is a fixed, content-free, actionable ONE-SENTENCE explanation of the
// closed `reasonCode` above it — never raw command output, never anything from the changeset or
// the workspace. It exists because a bare reason code such as NO_ACTIVE_SESSION reads to the model
// as an opaque failure it can only ask the operator about, instead of the actionable condition it
// names (epic #3384 cascade, end-to-end run 2026-09-05: the model asked "how would you like to
// proceed?" instead of telling the operator to open the Workbench). The activity-log diagnostic
// for a refusal stays reason-code-only regardless (`emitEditRefusedDiagnostic` never reads this
// field) — `message` is carried only on the outcome returned to the caller, never logged.
type EditOutcome =
  | { readonly status: "completed" }
  | {
      readonly status: "failed";
      readonly reasonCode?: string | undefined;
      readonly message?: string | undefined;
    };

// NO_ACTIVE_SESSION means the bounded wait for a live Workbench editor bridge
// (bindLiveEditorSession) never found one for this run's workspace — the model's edit was refused
// before it ever reached the editor route, so nothing was attempted against the tree.
export const NO_ACTIVE_SESSION_MESSAGE =
  "no Coding Workbench is connected for this workspace; keep the Workbench open and retry";

type EditorAgentActionClient = Pick<EditorAgentHttpClient, "action"> &
  Partial<Pick<EditorAgentHttpClient, "listSessions">>;

// The delays total 11.75 s. Together with seven worst-case 2 s session-list calls this remains
// below the production tool bridge's 30 s deadline, leaving the generated client its outer margin.
const EDITOR_SESSION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 3_000, 5_000] as const;

export interface CodingToolReadEditPorts {
  readonly repositoryRead: GovernedCodingToolPort<"read">;
  readonly repositoryDiscover: GovernedCodingToolPort<"discover">;
  readonly editorChangeset: GovernedCodingToolPort<"edit">;
}

export interface CodingToolReadEditPortDeps {
  readonly secureWorkspaceTextRead: SecureWorkspaceTextReadPort;
  readonly editorAgentClient: EditorAgentActionClient;
  readonly resolveEditorActionContext: () => EditorActionContext;
  readonly resolveRepositoryReadContext?: (() => RuntimeProducerBinding) | undefined;
  readonly resolveWorkspaceRoot?: (() => string | undefined) | undefined;
  readonly resolveWorkspaceRootAccess?: (() => WorkspaceRootAccess | undefined) | undefined;
  readonly requiresEditorReview?: (() => boolean) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly mutationLeaseCoordinator?:
    | Pick<CodingRuntimeEditorMutationLeaseCoordinator, "register" | "discard" | "waitForMutation">
    | undefined;
  /**
   * When true, a mutationGuard that carries no `binding` property at all fails closed at the
   * preflight boundary — read/discover/edit return failed rather than proceeding as if no
   * binding enforcement were required. Defaults to false so that pre-existing wirings and tests
   * that supplied bindingless guards keep their prior semantics. The single production wiring
   * (createRuntimeCodingToolFacade in productionManagedWorktreeTools.ts) opts in to lock the
   * defense-in-depth behavior KEIKO-0469 called for; new/alternative wirings should follow.
   */
  readonly enforceProducerBinding?: boolean | undefined;
}

interface EditorActionContext {
  readonly sessionId: string;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
  readonly origin: "agent";
  readonly workspaceRoot?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly workspaceRootDigest?: string | undefined;
  readonly expiresAt?: string | undefined;
}

interface RuntimeProducerBinding {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceId: string;
  readonly workspaceRootDigest: string;
  readonly expiresAt: string;
}

/**
 * Server-private producer adapters. They intentionally retain no invocation content: the facade's
 * invocation registry owns that lifecycle, while this bridge only passes a bounded value onward.
 */
export function createCodingToolReadEditPorts(
  deps: CodingToolReadEditPortDeps,
): CodingToolReadEditPorts {
  return {
    repositoryRead: {
      execute: (request, signal, mutationGuard) =>
        executeRead(deps, request, signal, mutationGuard),
    },
    repositoryDiscover: {
      execute: (request, signal, mutationGuard) =>
        executeDiscover(deps, request, signal, mutationGuard),
    },
    editorChangeset: {
      execute: (request, signal, mutationGuard) =>
        executeEdit(deps, request, signal, mutationGuard),
    },
  };
}

function executeDiscover(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryDiscoverRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed" }
> {
  return Promise.resolve(executeDiscoverSync(deps, request, signal, mutationGuard));
}

function executeDiscoverSync(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryDiscoverRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
):
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed" } {
  const preflight = discoveryPreflight(deps, signal, mutationGuard);
  if (!preflight.ok) return { status: "failed" };
  const binding = preflight.binding;
  try {
    const resolved = discoveryWorkspace(deps);
    if (resolved === undefined) return { status: "failed" };
    const workspace = detectWorkspaceAt(resolved.root, resolved.fs);
    const discovered = discoverWithStats(
      workspace,
      {
        maxDepth: 40,
        maxFiles: 20_000,
        applyGitignore: true,
      },
      resolved.fs,
    );
    const text = discoveredPathText(
      discovered.files.map(({ relativePath }): string => relativePath),
      request.query,
      request.maxResults,
    );
    if (!discoveryPostflight(deps, resolved.root, binding, signal, mutationGuard)) {
      return { status: "failed" };
    }
    return { status: "completed", read: discoveryReadResult(text) };
  } catch (error) {
    emitDiscoveryFailureDiagnostic(deps.diagnostics, binding, error);
    return { status: "failed" };
  }
}

interface DiscoveryWorkspace {
  readonly root: string;
  readonly fs?: WorkspaceFs | undefined;
}

function discoveryWorkspace(deps: CodingToolReadEditPortDeps): DiscoveryWorkspace | undefined {
  if (deps.resolveWorkspaceRootAccess !== undefined) {
    const access = deps.resolveWorkspaceRootAccess();
    return access === undefined ? undefined : { root: access.canonicalRoot, fs: access.fs };
  }
  const root = deps.resolveWorkspaceRoot?.();
  return root === undefined ? undefined : { root };
}

// Same rule as `editCorrelationId`/`editContextCorrelationId` below: the run id is the timeline a
// discovery failure belongs to, and the ONE sanctioned stand-in when there is no run in scope is
// UNKNOWN_CORRELATION_ID (correlation.ts, AGENTS.md §8). The local `[A-Za-z0-9:._-]{1,128}` regex
// this replaced admitted the tool action id — a `session:call` shape the sink rewrites to
// "invalid-correlation-id" — and otherwise fell back to an ad-hoc literal, so a wiring with no
// producer binding logged a line indistinguishable from a hostile id (PR #3381 review).
function emitDiscoveryFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  binding: RuntimeProducerBinding | undefined,
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId: correlationIdOrUnknown(binding?.runId),
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.workspace-discovery",
    source: "coding-tool-read-edit-ports.discover",
    errorClass: contentFreeErrorClass(error),
    message: "workspace-discovery-failed",
  });
}

function discoveredPathText(paths: readonly string[], query: string, maxResults: number): string {
  const terms = discoveryTerms(query);
  const selected: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (selected.length >= maxResults) break;
    if (isDenied(path) || !matchesDiscoveryTerms(path, terms)) continue;
    const lineBytes = Buffer.byteLength(`${path}\n`, "utf8");
    if (bytes + lineBytes > MAX_READ_BYTES) break;
    selected.push(path);
    bytes += lineBytes;
  }
  return selected.length === 0 ? "" : `${selected.join("\n")}\n`;
}

function matchesDiscoveryTerms(path: string, terms: readonly string[]): boolean {
  const candidate = path.toLowerCase();
  for (const term of terms) {
    if (!candidate.includes(term)) return false;
  }
  return true;
}

function discoveryTerms(query: string): readonly string[] {
  if (query.trim() === "*") return [];
  const terms: string[] = [];
  for (const term of query.toLowerCase().split(/[\s/_.-]+/u)) {
    if (term.length === 0) continue;
    terms.push(term);
    if (terms.length === 8) break;
  }
  return terms;
}

function discoveryReadResult(text: string): CodingToolReadResult {
  const totalLines = text.length === 0 ? 0 : text.split("\n").length - 1;
  return {
    text,
    byteCount: Buffer.byteLength(text, "utf8"),
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    totalLines,
  };
}

async function executeRead(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed" }
> {
  const preflight = readPreflight(deps, request, signal, mutationGuard);
  if (!preflight.ok) return { status: "failed" };
  const binding = preflight.binding;
  const result = await deps.secureWorkspaceTextRead.readText({
    relativePath: request.relativePath,
    signal,
  });
  if (!readPostflight(deps, result, binding, signal, mutationGuard)) return { status: "failed" };
  if (Buffer.byteLength(result.text, "utf8") > MAX_READ_BYTES) return { status: "failed" };
  const window = readWindow(result.text, request.startLine, request.maxLines);
  recordCompletedRead(deps, binding, request);
  return {
    status: "completed",
    read: {
      text: window.text,
      byteCount: Buffer.byteLength(window.text, "utf8"),
      // The digest always covers the WHOLE file so a later changeset's expectedContentHash stays
      // anchored to the governed read even when the model only saw a window of it.
      digest: createHash("sha256").update(result.text, "utf8").digest("hex"),
      totalLines: window.totalLines,
      ...(window.nextStartLine === undefined ? {} : { nextStartLine: window.nextStartLine }),
    },
  };
}

function recordCompletedRead(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
  request: RepositoryReadRequest,
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    category: "process",
    op: "coding-runtime.workspace-read",
    correlationId: correlationIdOrUnknown(binding?.runId),
    extra: {
      state: "completed",
      targetPathSha256: createHash("sha256").update(request.relativePath, "utf8").digest("hex"),
      startLine: request.startLine ?? 1,
      maxLines: request.maxLines ?? 0,
    },
  });
}

/**
 * Cuts the requested 1-based line window out of the full governed read. The whole file always
 * stays server-side; only the window travels back to the model (#2473 large-file reads).
 */
function readWindow(
  text: string,
  startLine: number | undefined,
  maxLines: number | undefined,
): ReadWindowResult {
  const lines = text.split("\n");
  const trailingNewline = lines.length > 1 && lines.at(-1) === "";
  let totalLines = trailingNewline ? lines.length - 1 : lines.length;
  if (text.length === 0) totalLines = 0;
  if (startLine === undefined && maxLines === undefined) return { text, totalLines };
  const first = (startLine ?? 1) - 1;
  if (first >= totalLines) return { text: "", totalLines };
  return slicedWindow({ lines, trailingNewline, totalLines, first, maxLines });
}

interface ReadWindowResult {
  readonly text: string;
  readonly totalLines: number;
  readonly nextStartLine?: number;
}

function slicedWindow(input: {
  readonly lines: readonly string[];
  readonly trailingNewline: boolean;
  readonly totalLines: number;
  readonly first: number;
  readonly maxLines: number | undefined;
}): ReadWindowResult {
  const { lines, trailingNewline, totalLines, first, maxLines } = input;
  const end = maxLines === undefined ? totalLines : Math.min(totalLines, first + maxLines);
  const window = lines.slice(first, end).join("\n");
  const keepsTrailingNewline = end < totalLines || trailingNewline;
  return {
    text: keepsTrailingNewline ? `${window}\n` : window,
    totalLines,
    ...(end < totalLines ? { nextStartLine: end + 1 } : {}),
  };
}

/** A single explicit result shape for both preflight checks below: every branch returns an
 * object literal discriminated on `ok`, instead of mixing a `RuntimeProducerBinding | undefined`
 * payload with the bare boolean literal `false` "abort" signal. */
type ReadEditPreflightOutcome =
  | { readonly ok: false }
  | { readonly ok: true; readonly binding: RuntimeProducerBinding | undefined };

function readPreflight(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): ReadEditPreflightOutcome {
  if (isAborted(signal) || isDenied(request.relativePath) || !hasLiveWorkspaceAccess(deps)) {
    return { ok: false };
  }
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return { ok: false };
  if (binding === undefined && deps.enforceProducerBinding === true) return { ok: false };
  if (!readContextMatches(deps, binding) || !checkGuard(mutationGuard)) return { ok: false };
  return isDenied(request.relativePath) ? { ok: false } : { ok: true, binding };
}

function discoveryPreflight(
  deps: CodingToolReadEditPortDeps,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): ReadEditPreflightOutcome {
  if (isAborted(signal)) return { ok: false };
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return { ok: false };
  if (binding === undefined && deps.enforceProducerBinding === true) return { ok: false };
  return readContextMatches(deps, binding) && checkGuard(mutationGuard)
    ? { ok: true, binding }
    : { ok: false };
}

function discoveryPostflight(
  deps: CodingToolReadEditPortDeps,
  workspaceRoot: string,
  binding: RuntimeProducerBinding | undefined,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): boolean {
  const currentRoot = discoveryWorkspace(deps)?.root;
  return (
    currentRoot === workspaceRoot &&
    checkGuard(mutationGuard) &&
    readContextMatches(deps, binding) &&
    !isAborted(signal)
  );
}

function readPostflight(
  deps: CodingToolReadEditPortDeps,
  result: Awaited<ReturnType<SecureWorkspaceTextReadPort["readText"]>>,
  binding: RuntimeProducerBinding | undefined,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): result is Extract<typeof result, { readonly ok: true }> {
  return (
    result.ok &&
    hasLiveWorkspaceAccess(deps) &&
    checkGuard(mutationGuard) &&
    readContextMatches(deps, binding) &&
    !isAborted(signal)
  );
}

interface PreparedEdit {
  readonly action: EditorAgentAction;
  readonly leaseRequest: CodingRuntimeEditorMutationLeaseRequest | undefined;
  readonly signal: AbortSignal;
  readonly workspaceRoot: string | undefined;
}

// EVERY failed exit here carries a closed reason code and one `edit-refused` line. The two that did
// not — the prepare stage refusing (malformed changeset, revoked mutation guard, cross-wired
// producer binding, unresolvable editor context) and the post-session-bind workspace-access recheck
// — returned a bare `{ status: "failed" }` with nothing in the activity log, which is exactly the
// workbench failure mode this file's diagnostic was added for: the model saw a retryable-looking
// failure and re-issued the edit while the log stayed empty (cursor review, PR #3381).
async function executeEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<EditOutcome> {
  const prepared = prepareEdit(deps, request, signal, mutationGuard);
  if (prepared === undefined) {
    return editRefused(deps, editContextCorrelationId(deps), "EDIT_PREPARE_FAILED");
  }
  const correlationId = editCorrelationId(prepared.action);
  try {
    const action = await bindLiveEditorSession(
      deps.editorAgentClient,
      prepared.action,
      prepared.workspaceRoot,
      prepared.signal,
    );
    if (action === undefined) {
      discardMutationLease(deps, prepared.leaseRequest);
      return editRefused(deps, correlationId, "NO_ACTIVE_SESSION", NO_ACTIVE_SESSION_MESSAGE);
    }
    if (!hasLiveWorkspaceAccess(deps)) {
      discardMutationLease(deps, prepared.leaseRequest);
      return editRefused(deps, correlationId, "WORKSPACE_ACCESS_LOST");
    }
    // Capture before dispatch: an automatic editor apply may settle before its HTTP response.
    const completion =
      prepared.leaseRequest === undefined
        ? undefined
        : deps.mutationLeaseCoordinator?.waitForMutation(prepared.leaseRequest, prepared.signal);
    const result = await deps.editorAgentClient.action(action, prepared.signal);
    if (result.ok && editorStatusCompleted(result.value.result.status)) {
      return await completedEdit(deps, correlationId, completion);
    }
    discardMutationLease(deps, prepared.leaseRequest);
    return editRefused(deps, correlationId, editFailureReasonCode(result));
  } catch (error) {
    discardMutationLease(deps, prepared.leaseRequest);
    emitEditFailureDiagnostic(deps.diagnostics, correlationId, error);
    return { status: "failed", reasonCode: "EDIT_TRANSPORT_ERROR" };
  }
}

async function completedEdit(
  deps: CodingToolReadEditPortDeps,
  correlationId: string,
  completion: Promise<CodingRuntimeMutationOutcome> | undefined,
): Promise<EditOutcome> {
  if (completion === undefined) return { status: "completed" };
  const outcome = await completion;
  (deps.activityLog ?? processServerLogSink()).write({
    category: "security",
    op: "coding-runtime.editor-mutation.settled",
    correlationId,
    extra: { state: outcome, actionKind: "edit" },
  });
  const reasonCode = outcome === "cancelled" ? "CANCELLED" : "EDIT_MUTATION_FAILED";
  return outcome === "succeeded"
    ? { status: "completed" }
    : editRefused(deps, correlationId, reasonCode);
}

function editRefused(
  deps: CodingToolReadEditPortDeps,
  correlationId: string,
  reasonCode: string | undefined,
  message?: string,
): EditOutcome {
  // The diagnostic stays reason-code-only (body-free, AGENTS.md §8) — `message` never reaches the
  // activity log, only the outcome returned to the caller.
  emitEditRefusedDiagnostic(deps.diagnostics, correlationId, reasonCode);
  return message === undefined
    ? { status: "failed", reasonCode }
    : { status: "failed", reasonCode, message };
}

// The closed vocabulary a rejected edit can name (EditorAgentConflictCode/EditorAgentFailureCode
// plus this port's own transport/no-session markers) is content-free by construction — a fixed
// enum of machine reason codes, never raw command output — so it is safe to forward to the model
// unlike the command/verification/git ports' delegate evidence (codingToolFacade.ts strips theirs).
function editFailureReasonCode(
  result: Awaited<ReturnType<EditorAgentActionClient["action"]>>,
): string | undefined {
  if (!result.ok) return result.error.code;
  const outcome = result.value.result;
  return outcome.conflict?.code ?? outcome.failure?.code;
}

// The run id is the timeline an edit failure belongs to; the tool action id carries the sidecar's
// `session:call` shape, which the diagnostics sink rejects as a correlation id (it wrote
// "invalid-correlation-id" on every edit diagnostic before this, end-to-end run 2026-09-03).
function editCorrelationId(action: EditorAgentAction): string {
  const runId = action.authorityRef?.runId;
  return runId !== undefined && isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID;
}

// The prepare stage can refuse before any action exists, so that refusal takes its correlation from
// the run's own editor context instead of an action that was never built. Same run id, same
// timeline: a prepare refusal and an editor-route refusal for one run join on the one key.
function editContextCorrelationId(deps: CodingToolReadEditPortDeps): string {
  const runId = resolveEditorContext(deps)?.authorityRef.runId;
  return runId !== undefined && isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID;
}

function emitEditFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.editor-changeset",
    source: "coding-tool-read-edit-ports.edit",
    errorClass: contentFreeErrorClass(error),
    message: "edit-transport-failed",
  });
}

// A governed edit the editor route refused (a policy denial, a conflict, a failed apply) is a
// decision the activity log must be able to reconstruct: before this line the only trace was the
// in-memory audit feed, and a workbench run that could never edit a file left an empty log
// (end-to-end run, 2026-09-03). The reason is the closed editor-agent vocabulary, never content.
function emitEditRefusedDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string,
  reasonCode: string | undefined,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.editor-changeset",
    source: "coding-tool-read-edit-ports.edit",
    errorClass: reasonCode ?? "unclassified",
    message: "edit-refused",
  });
}

async function bindLiveEditorSession(
  client: EditorAgentActionClient,
  action: EditorAgentAction,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<EditorAgentAction | undefined> {
  if (client.listSessions === undefined || workspaceRoot === undefined) return action;
  // One listing per retry delay, plus a final listing that is not followed by a wait.
  const attempts = EDITOR_SESSION_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) return undefined;
    const listed = await client.listSessions(signal);
    if (!listed.ok) return undefined;
    const session = listed.value.sessions.find(
      (candidate) => candidate.workspaceRoot === workspaceRoot,
    );
    if (session !== undefined) return { ...action, sessionId: session.sessionId };
    const delay = EDITOR_SESSION_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !(await waitForEditorSession(delay, signal))) return undefined;
  }
  return undefined;
}

function waitForEditorSession(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// The checkGuard(mutationGuard) call this delegates into (validatedChangeset) runs at PREPARE
// time — before bindLiveEditorSession's up-to-~11.75s session-binding wait and before the actual
// mutating editorAgentClient.action() call. It is NOT the final mutation-authority recheck. The
// true final-boundary recheck happens in packages/keiko-server/src/editor/agentRoutes.ts's
// applyChangeset(), which calls claimRuntimeMutation() → deps.runtimeMutationLease.claim() → the
// same mutationGuard closure registered by registerMutationLease() below (via
// codingRuntimeEditorMutationLeaseCoordinator), immediately before applyPatch(). A future reader
// must not treat the single local checkGuard() here as the only guard: the coordinator is what
// binds the mutation authority to the commit boundary.
function prepareEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): PreparedEdit | undefined {
  const changeset = validatedChangeset(deps, request, signal, mutationGuard);
  if (changeset === undefined) return undefined;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return undefined;
  if (binding === undefined && deps.enforceProducerBinding === true) return undefined;
  const context = resolveEditorContext(deps);
  if (context === undefined || !editorContextMatches(context, binding)) return undefined;
  const action = changesetAction(request, changeset, context);
  const leaseRequest = registerMutationLease(deps, action, context, binding, mutationGuard);
  if (binding !== undefined && leaseRequest === undefined) return undefined;
  return {
    action,
    leaseRequest,
    signal: signal ?? new AbortController().signal,
    workspaceRoot: context.workspaceRoot,
  };
}

function hasLiveWorkspaceAccess(deps: CodingToolReadEditPortDeps): boolean {
  const resolveAccess = deps.resolveWorkspaceRootAccess;
  if (resolveAccess === undefined) return true;
  try {
    const access = resolveAccess();
    const expectedRoot = deps.resolveWorkspaceRoot?.();
    return (
      access !== undefined && (expectedRoot === undefined || access.canonicalRoot === expectedRoot)
    );
  } catch {
    return false;
  }
}

function validatedChangeset(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): EditorAgentChangeset | undefined {
  if (
    !hasLiveWorkspaceAccess(deps) ||
    isAborted(signal) ||
    !checkGuard(mutationGuard) ||
    !("changeset" in request)
  ) {
    return undefined;
  }
  if (!isExactEditorAgentChangeset(request.changeset)) return undefined;
  return normalizeRawSingleFilePatch(request.changeset);
}

function normalizeRawSingleFilePatch(
  changeset: EditorAgentChangeset,
): EditorAgentChangeset | undefined {
  if (!changeset.patch.startsWith(":")) return changeset;
  const file = changeset.files[0]?.file;
  if (changeset.files.length !== 1 || file === undefined) return undefined;
  const match = RAW_SINGLE_FILE_PATCH.exec(changeset.patch);
  if (match?.[1] !== file || match[2] === undefined) return undefined;
  return {
    ...changeset,
    patch: `--- a/${file}\n+++ b/${file}\n${match[2]}`,
  };
}

function editorStatusCompleted(status: string): boolean {
  return status === "queued" || status === "succeeded";
}

function discardMutationLease(
  deps: CodingToolReadEditPortDeps,
  request: CodingRuntimeEditorMutationLeaseRequest | undefined,
): void {
  if (request !== undefined) deps.mutationLeaseCoordinator?.discard(request);
}

function registerMutationLease(
  deps: CodingToolReadEditPortDeps,
  action: EditorAgentAction,
  context: EditorActionContext,
  binding: RuntimeProducerBinding | undefined,
  mutationGuard: CodingToolMutationGuard,
): CodingRuntimeEditorMutationLeaseRequest | undefined {
  if (binding === undefined) return undefined;
  const coordinator = deps.mutationLeaseCoordinator;
  if (coordinator === undefined || context.workspaceId === undefined) return undefined;
  const request = leaseRequest(action, binding);
  const registered = coordinator.register({
    authorityRef: action.authorityRef ?? context.authorityRef,
    workspaceId: context.workspaceId,
    workspaceRootDigest: binding.workspaceRootDigest,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
    requiresReview: resolveReviewRequirement(deps),
    mutationGuard: (): boolean => checkGuard(mutationGuard),
  });
  return registered ? request : undefined;
}

function resolveReviewRequirement(deps: CodingToolReadEditPortDeps): boolean {
  try {
    return deps.requiresEditorReview?.() ?? true;
  } catch {
    return true;
  }
}

function leaseRequest(
  action: EditorAgentAction,
  binding: RuntimeProducerBinding,
): CodingRuntimeEditorMutationLeaseRequest {
  return {
    authorityRef: action.authorityRef ?? {
      runId: binding.runId,
      envelopeDigest: binding.envelopeDigest,
    },
    runId: binding.runId,
    envelopeDigest: binding.envelopeDigest,
    workspaceId: binding.workspaceId,
    workspaceRootDigest: binding.workspaceRootDigest,
    actionId: action.actionId,
    idempotencyKey: action.idempotencyKey,
  };
}

function changesetAction(
  request: EditorChangesetRequest,
  changeset: EditorAgentChangeset,
  context: EditorActionContext,
): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    sessionId: context.sessionId,
    type: "applyChangeset",
    authorityRef: context.authorityRef,
    origin: context.origin,
    changeset,
  };
}

function resolveEditorContext(deps: CodingToolReadEditPortDeps): EditorActionContext | undefined {
  try {
    return deps.resolveEditorActionContext();
  } catch {
    return undefined;
  }
}

function readContextMatches(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
): boolean {
  if (binding === undefined) return true;
  try {
    const context = deps.resolveRepositoryReadContext?.();
    return context !== undefined && bindingMatches(binding, context);
  } catch {
    return false;
  }
}

function editorContextMatches(
  context: EditorActionContext,
  binding: RuntimeProducerBinding | undefined,
): boolean {
  if (binding === undefined) return true;
  return (
    context.authorityRef.runId === binding.runId &&
    context.authorityRef.envelopeDigest === binding.envelopeDigest &&
    context.workspaceId === binding.workspaceId &&
    context.workspaceRootDigest === binding.workspaceRootDigest &&
    context.expiresAt === binding.expiresAt &&
    !expired(binding.expiresAt)
  );
}

function bindingMatches(left: RuntimeProducerBinding, right: RuntimeProducerBinding): boolean {
  return (
    left.runId === right.runId &&
    left.envelopeDigest === right.envelopeDigest &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRootDigest === right.workspaceRootDigest &&
    left.expiresAt === right.expiresAt &&
    !expired(left.expiresAt)
  );
}

function expired(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || Date.now() >= expiry;
}

function checkGuard(mutationGuard: CodingToolMutationGuard): boolean {
  try {
    return mutationGuard.check();
  } catch {
    return false;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

// Returns `null` when the guard carries a `binding` property whose shape is malformed, `undefined`
// when the guard omits `binding` altogether, or the extracted binding when it is well-formed.
// Callers that opted in to `enforceProducerBinding` (KEIKO-0469) treat both `null` and `undefined`
// as fail-closed — otherwise `undefined` preserves the pre-existing "no binding, no check" path.
function mutationBinding(
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined | null {
  const record = mutationGuard as unknown as Record<string, unknown>;
  if (!("binding" in record)) return undefined;
  return isRuntimeProducerBinding(record.binding) ? record.binding : null;
}

function isRuntimeProducerBinding(value: unknown): value is RuntimeProducerBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    nonEmpty(record.runId) &&
    digest(record.envelopeDigest) &&
    nonEmpty(record.workspaceId) &&
    digest(record.workspaceRootDigest) &&
    typeof record.expiresAt === "string" &&
    Number.isFinite(Date.parse(record.expiresAt))
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
