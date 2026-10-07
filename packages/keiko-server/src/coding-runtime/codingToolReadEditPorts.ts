import { createHash } from "node:crypto";
import type {
  CodingWorkbenchRuntimeFailureCode,
  EditorAgentAction,
  EditorAgentChangeset,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import { isCodingSafeActivityPresentationPath } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import {
  detectWorkspaceAt,
  discoverWorkspacePaths,
  executionControlledWorkspaceFs,
  isDenied,
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  StructuralExecutionStoppedError,
  type WorkspacePathDiscoveryResult,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import {
  correlationIdOrUnknown,
  isValidCorrelationId,
  UNKNOWN_CORRELATION_ID,
} from "../correlation.js";
import {
  EDIT_PREPARE_CAUSES,
  EDIT_PREPARE_ERROR_KINDS,
  EDIT_READ_REASONS,
  type CodingToolMutationGuard,
  type EditPrepareCause,
  type MaterializedPatchCharge,
} from "./codingToolFacadePorts.js";
import {
  isExactEditorAgentChangeset,
  codingToolDiscoveryText,
  type CodingToolDiscoveryResult,
  type CodingToolReadResult,
} from "./codingToolIpc.js";
import {
  changesetPayloadBytes,
  isReplacementChangeset,
  materializeReplacementChangeset,
  REPLACEMENT_REFUSALS,
  type CodingToolReplacementChangeset,
  type GovernedWorkspaceReadFailure,
  type GovernedWorkspaceReadResult,
  type ReplacementMaterialization,
  type ReplacementReadPort,
  type ReplacementRefusal,
} from "./codingToolReplacementEdits.js";
import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "./secureWorkspaceTextReadProtocol.js";
import type {
  CodingRuntimeEditorMutationLeaseCoordinator,
  CodingRuntimeEditorMutationLeaseRequest,
  CodingRuntimeMutationOutcome,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { MaterializedPatchRegistry } from "./materializedPatchRegistry.js";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import { processServerLogSink } from "../process-log-sink.js";
import {
  secureWorkspaceTextDigest,
  type SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import {
  WORKSPACE_PATH_ABSENCE_VERDICTS,
  type WorkspacePathAbsence,
} from "./secureWorkspaceTextReadAbsence.js";
import type { WorkspaceRootAccess } from "../task-workspace/workspace-root-access.js";
import type {
  RuntimeChangesetApplyInput,
  RuntimeChangesetApplyPort,
} from "../editor/agentRoutes.js";

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
//
// `prepareCause` and `readReason` ride out with an `EDIT_PREPARE_FAILED` refusal only: the closed step
// that refused the edit and, for a failed materialization read, the closed reason of that read. The
// run's refusal escalation classifies the refusal by them (F5, #3873 review: a read the model cannot
// repair is not "edits that no longer match the file"). They are closed words, never read text, and
// the facade never forwards them to the model.
type EditOutcome =
  | { readonly status: "completed" }
  | {
      readonly status: "failed";
      readonly reasonCode?: string | undefined;
      readonly message?: string | undefined;
      readonly prepareCause?: EditPrepareCause | undefined;
      readonly readReason?: WorkspaceReadFailureReason | undefined;
      readonly affectedRelativePath?: string | undefined;
    };

// NO_ACTIVE_SESSION means the bounded wait for a live Workbench editor bridge
// (bindLiveEditorSession) never found one for this run's workspace — the model's edit was refused
// before it ever reached the editor route, so nothing was attempted against the tree.
export const NO_ACTIVE_SESSION_MESSAGE =
  "no Coding Workbench is connected for this workspace; keep the Workbench open and retry";
const NO_ACTIVE_SESSION_DETAIL = { message: NO_ACTIVE_SESSION_MESSAGE } as const;

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
  /** Server-owned allowed changesets reuse the Editor transaction without a browser decision. */
  readonly serverRuntimeChangeset?: RuntimeChangesetApplyPort | undefined;
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
   * The server's record of which diff text it rendered itself (PR #3876 review). Once a replacement
   * changeset is materialized and the run's budget has taken its diff, the exact patch text is
   * registered, so the editor route may lift keiko-tools' collapsed-diff heuristic for that diff
   * alone. A diff a caller supplied is never registered. Absent, nothing is, and the heuristic stays.
   */
  readonly materializedPatches?: Pick<MaterializedPatchRegistry, "register"> | undefined;
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

async function executeDiscover(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryDiscoverRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed"; readonly reasonCode?: string }
> {
  const preflight = discoveryPreflight(deps, signal, mutationGuard);
  if (!preflight.ok) return { status: "failed" };
  const binding = preflight.binding;
  const startedAtMs = Date.now();
  let reason: DiscoverySettlementReason = "authority-denied";
  let discovered: WorkspacePathDiscoveryResult | undefined;
  let read: CodingToolReadResult | undefined;
  let failure: unknown;
  try {
    const resolved = discoveryWorkspace(deps);
    if (resolved === undefined) return { status: "failed" };
    discovered = await discoverPaths(resolved, request, signal, mutationGuard);
    read = discoveryReadResult(discovered);
    if (!discoveryPostflight(deps, resolved.root, binding, signal, mutationGuard)) {
      reason = isAborted(signal) ? "cancelled" : "authority-denied";
      return { status: "failed" };
    }
    reason = "none";
    return { status: "completed", read };
  } catch (error) {
    failure = error;
    reason = discoveryFailureReason(signal, error);
    emitDiscoveryFailureDiagnostic(deps.diagnostics, binding, error);
    return discoveryRefusal(reason);
  } finally {
    recordDiscoverySettlement(
      deps,
      binding,
      reason,
      startedAtMs,
      discovered,
      reason === "none" ? read : undefined,
      failure,
    );
  }
}

function discoverPaths(
  resolved: DiscoveryWorkspace,
  request: RepositoryDiscoverRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<WorkspacePathDiscoveryResult> {
  const nowMs = mutationGuard.executionBudget?.nowMs ?? Date.now;
  const deadlineAtMs = Math.min(
    nowMs() + DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
    mutationGuard.executionBudget?.deadlineAtMs ?? Infinity,
  );
  const control = { nowMs, deadlineAtMs, ...(signal === undefined ? {} : { signal }) };
  const workspace = detectWorkspaceAt(
    resolved.root,
    executionControlledWorkspaceFs(resolved.fs ?? nodeWorkspaceFs, control),
    {
      scanSourceFilesForLanguages: false,
    },
  );
  return discoverWorkspacePaths(
    workspace,
    {
      mode: request.mode ?? "keywords",
      directory: request.directory ?? "",
      query: request.mode === "glob" ? request.query : request.query.trim(),
      maxResults: request.maxResults,
    },
    control,
    resolved.fs,
  );
}

type DiscoverySettlementReason =
  | "none"
  | "cancelled"
  | "authority-denied"
  | "inventory-failed"
  | "timeout"
  | "scope-denied"
  | "invalid-request";

export const WORKSPACE_DISCOVERY_REFUSAL_CODES = Object.freeze({
  SCOPE_DENIED: "WORKSPACE_DISCOVERY_SCOPE_DENIED",
  INVALID_REQUEST: "WORKSPACE_DISCOVERY_INVALID_REQUEST",
  TIMEOUT: "WORKSPACE_DISCOVERY_TIMEOUT",
});

function discoveryFailureReason(
  signal: AbortSignal | undefined,
  error: unknown,
): DiscoverySettlementReason {
  if (isAborted(signal)) return "cancelled";
  if (error instanceof StructuralExecutionStoppedError)
    return error.reason === "timeout" ? "timeout" : "cancelled";
  if (error instanceof PathDeniedError || error instanceof PathEscapeError) return "scope-denied";
  if (error instanceof RepoSearchInvalidQueryError) return "invalid-request";
  return "inventory-failed";
}

function discoveryRefusal(reason: DiscoverySettlementReason): {
  readonly status: "failed";
  readonly reasonCode?: string;
} {
  if (reason === "scope-denied")
    return { status: "failed", reasonCode: WORKSPACE_DISCOVERY_REFUSAL_CODES.SCOPE_DENIED };
  if (reason === "invalid-request")
    return { status: "failed", reasonCode: WORKSPACE_DISCOVERY_REFUSAL_CODES.INVALID_REQUEST };
  if (reason === "timeout")
    return { status: "failed", reasonCode: WORKSPACE_DISCOVERY_REFUSAL_CODES.TIMEOUT };
  return { status: "failed" };
}

const CODING_RUNTIME_WORKSPACE_DISCOVERY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.workspace-discovery",
  category: "search",
  owner: "keiko-server",
  emitter: "coding-runtime.codingToolReadEditPorts.recordDiscoverySettlement",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "cancelled",
        "authority-denied",
        "inventory-failed",
        "timeout",
        "scope-denied",
        "invalid-request",
      ],
    },
    cooperative: { type: "boolean", dataClass: "closed-enum", required: true },
    sourceLanguageScan: { type: "boolean", dataClass: "closed-enum", required: true },
    directorySortStrategy: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["once-per-directory", "retained-results-only"],
    },
    discovered: { type: "integer", dataClass: "count", required: false },
    denied: { type: "integer", dataClass: "count", required: false },
    ignored: { type: "integer", dataClass: "count", required: false },
    depthPruned: { type: "integer", dataClass: "count", required: false },
    maxFilesPruned: { type: "integer", dataClass: "count", required: false },
    unrepresentablePaths: { type: "integer", dataClass: "count", required: false },
    directoriesDiscovered: { type: "integer", dataClass: "count", required: false },
    directoriesPruned: { type: "integer", dataClass: "count", required: false },
    ioErrors: { type: "integer", dataClass: "count", required: false },
    returnedPathCount: { type: "integer", dataClass: "count", required: false },
    matchedCount: { type: "integer", dataClass: "count", required: false },
    coverageIncomplete: { type: "boolean", dataClass: "closed-enum", required: false },
    truncationReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 6,
      values: [
        "result-limit",
        "output-limit",
        "directory-limit",
        "io-error",
        "time-limit",
        "unrepresentable-path",
      ],
    },
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
  diagnosticWhen: [{ field: "reason", values: ["inventory-failed"] }],
  analyzerProjection: "process-lifecycle",
  failureClasses: ["coding-workspace-discovery"],
  proofIds: ["coding-runtime.workspace-discovery.emitted-line"],
  releaseImpact: "patch",
});

function recordDiscoverySettlement(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
  reason: DiscoverySettlementReason,
  startedAtMs: number,
  discovered: WorkspacePathDiscoveryResult | undefined,
  read: CodingToolReadResult | undefined,
  failure: unknown,
): void {
  const errorKind: ActivityLogErrorKind | undefined =
    reason === "none" ? undefined : discoveryErrorKind(reason);
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_WORKSPACE_DISCOVERY_OPERATION,
      {
        correlationId: correlationIdOrUnknown(binding?.runId),
        durationMs: Math.max(0, Date.now() - startedAtMs),
        ...(errorKind === undefined ? {} : { level: "warn", errorKind }),
      },
      {
        state: reason === "none" ? "completed" : "failed",
        reason,
        cooperative: true,
        sourceLanguageScan: false,
        directorySortStrategy: "retained-results-only",
        ...discoverySettlementFacts(discovered, read),
        ...(failure === undefined
          ? {}
          : { frames: keikoStackFrames(failure), causeChain: causeChain(failure) }),
      },
    ),
  );
}

function discoveryErrorKind(
  reason: Exclude<DiscoverySettlementReason, "none">,
): ActivityLogErrorKind {
  if (reason === "inventory-failed") return "internal";
  if (reason === "invalid-request") return "validation-failed";
  return reason === "scope-denied" ? "authority-denied" : reason;
}

function discoverySettlementFacts(
  discovered: WorkspacePathDiscoveryResult | undefined,
  read: CodingToolReadResult | undefined,
): Partial<ActivityLogFields<typeof CODING_RUNTIME_WORKSPACE_DISCOVERY_OPERATION>> {
  if (discovered === undefined) return {};
  const { filesDiscovered, ...stats } = discovered.stats;
  return {
    discovered: filesDiscovered,
    ...stats,
    returnedPathCount: read?.returnedPathCount ?? 0,
    matchedCount: discovered.matchedCount,
    coverageIncomplete: read?.discovery?.coverageIncomplete ?? discovered.coverageIncomplete,
    truncationReasons: read?.discovery?.truncationReasons ?? discovered.truncationReasons,
  };
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

function discoveryReadProjection(discovery: CodingToolDiscoveryResult): CodingToolReadResult {
  const text = codingToolDiscoveryText(discovery.entries);
  const totalLines = text.length === 0 ? 0 : text.split("\n").length - 1;
  return {
    text,
    byteCount: Buffer.byteLength(text, "utf8"),
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    totalLines,
    returnedPathCount: discovery.entries.length,
    discovery,
  };
}

function discoveryReadResult(result: WorkspacePathDiscoveryResult): CodingToolReadResult {
  const entries = [...result.entries];
  const truncationReasons = [...result.truncationReasons];
  const project = (): CodingToolReadResult =>
    discoveryReadProjection({
      entries,
      truncationReasons,
      matchedCount: result.matchedCount,
      coverageIncomplete: truncationReasons.length > 0,
    });
  let read = project();
  while (Buffer.byteLength(JSON.stringify(read), "utf8") > MAX_READ_BYTES) {
    entries.pop();
    if (!truncationReasons.includes("output-limit")) truncationReasons.push("output-limit");
    read = project();
  }
  return read;
}

async function executeRead(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed"; readonly reasonCode?: string }
> {
  const read = await governedWorkspaceRead(
    deps,
    request.relativePath,
    signal,
    mutationGuard,
    "tool-result",
  );
  if (!read.ok) return readRefusal(read.reason);
  return completedRead(deps, read.binding, request, read.text);
}

type GovernedRead =
  | {
      readonly ok: true;
      readonly text: string;
      readonly binding: RuntimeProducerBinding | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: WorkspaceReadFailureReason;
      readonly binding: RuntimeProducerBinding | undefined;
      readonly error?: unknown;
      // The closed verdict of the secure read's walk, set only when the helper answered
      // `access-denied` (#3873 review); the line it explains is written from here.
      readonly absence?: WorkspacePathAbsence;
    };

// The one governed read: preflight (abort, denied path, live workspace, producer binding, guard),
// the secure read, postflight, and the response bound. The model's own read and a replacement
// materialization both read through it (#3873 review), so both fail closed the same way, and every
// failure, a thrown one included, leaves its `coding-runtime.workspace-read` line here with the
// closed reason and the purpose the read served.
async function governedWorkspaceRead(
  deps: CodingToolReadEditPortDeps,
  relativePath: string,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
  purpose: ReadPurpose,
): Promise<GovernedRead> {
  const binding = safeMutationBinding(mutationGuard);
  try {
    const read = await attemptGovernedRead(deps, relativePath, signal, mutationGuard, binding);
    if (!read.ok) recordReadFailure(deps, read, relativePath, purpose);
    return read;
  } catch (error) {
    const read: GovernedRead = { ok: false, reason: "exception", binding, error };
    logFailedRead(deps, read, relativePath, purpose);
    return read;
  }
}

async function attemptGovernedRead(
  deps: CodingToolReadEditPortDeps,
  relativePath: string,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
  initialBinding: RuntimeProducerBinding | undefined,
): Promise<GovernedRead> {
  const preflight = readPreflight(deps, relativePath, signal, mutationGuard);
  if (!preflight.ok) return { ok: false, reason: "preflight-refused", binding: initialBinding };
  const binding = preflight.binding;
  const result = await deps.secureWorkspaceTextRead.readText({ relativePath, signal });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      binding,
      ...(result.absence === undefined ? {} : { absence: result.absence }),
    };
  }
  if (!readPostflight(deps, result, binding, signal, mutationGuard)) {
    return { ok: false, reason: "postflight-refused", binding };
  }
  if (Buffer.byteLength(result.text, "utf8") > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) {
    return { ok: false, reason: "response-too-large", binding };
  }
  return { ok: true, text: result.text, binding };
}

// A path that does not exist is a legitimate precondition of the file a materialization creates or
// moves to, recorded as `absent`; for the model's own read, and for every other reason, it is a
// failed read.
function recordReadFailure(
  deps: CodingToolReadEditPortDeps,
  read: Extract<GovernedRead, { readonly ok: false }>,
  relativePath: string,
  purpose: ReadPurpose,
): void {
  if (purpose === "edit-materialization" && read.reason === "not-found") {
    recordMaterializationRead(deps, read.binding, relativePath, "absent", read.absence);
    return;
  }
  logFailedRead(deps, read, relativePath, purpose);
}

// #3873 review: a materialization reads through the governed read above, never the raw port, so
// every file it reads leaves a read line with its purpose and closed reason, a denied path or a
// switched workspace fails closed as it would for the model's own read, and a cancelled run is
// recorded as cancelled.
function materializationReadPort(
  deps: CodingToolReadEditPortDeps,
  mutationGuard: CodingToolMutationGuard,
): ReplacementReadPort {
  return {
    readText: async ({ relativePath, signal }): Promise<GovernedWorkspaceReadResult> => {
      // An aborted run is cancelled, not refused: the preflight would fold the abort into
      // `preflight-refused`, and the refusal must record the cancellation it actually was.
      if (isAborted(signal)) {
        const cancelled: GovernedRead = {
          ok: false,
          reason: "cancelled",
          binding: safeMutationBinding(mutationGuard),
        };
        logFailedRead(deps, cancelled, relativePath, "edit-materialization");
        return { ok: false, reason: "cancelled" };
      }
      const read = await governedWorkspaceRead(
        deps,
        relativePath,
        signal,
        mutationGuard,
        "edit-materialization",
      );
      if (!read.ok) return { ok: false, reason: read.reason };
      recordMaterializationRead(deps, read.binding, relativePath, "completed");
      return { ok: true, text: read.text };
    },
  };
}

function recordMaterializationRead(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
  relativePath: string,
  state: "completed" | "absent",
  absence?: WorkspacePathAbsence,
): void {
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_WORKSPACE_READ_OPERATION,
      { correlationId: correlationIdOrUnknown(binding?.runId) },
      {
        state,
        purpose: "edit-materialization",
        targetPathSha256: targetPathDigest(relativePath),
        ...(absence === undefined ? {} : { absence }),
      },
    ),
  );
}

function targetPathDigest(relativePath: string): string {
  return createHash("sha256").update(relativePath, "utf8").digest("hex");
}

type WorkspaceReadFailureReason = GovernedWorkspaceReadFailure;

// #3873 review: which consumer a read served. Absent on lines written before the field existed.
const READ_PURPOSES = ["tool-result", "edit-materialization"] as const;
type ReadPurpose = (typeof READ_PURPOSES)[number];

const CODING_RUNTIME_WORKSPACE_READ_PURPOSE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [...READ_PURPOSES],
} as const;

const CODING_RUNTIME_WORKSPACE_READ_REASON_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [...EDIT_READ_REASONS],
} as const;

// #3873 review (PR #3876): the closed verdict of the server's no-follow walk, set only when the native
// helper answered `access-denied`, which it gives for a missing path, a link, a file used as a
// directory, another device, an unprobeable directory and an unusable root alike. It is how a creation
// refused `denied` is told apart in the log; one closed word, never the path or an error text.
const CODING_RUNTIME_WORKSPACE_READ_ABSENCE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [...WORKSPACE_PATH_ABSENCE_VERDICTS],
} as const;

const CODING_RUNTIME_WORKSPACE_READ_FRAMES_FIELD = {
  type: "string-array",
  dataClass: "opaque-id",
  required: false,
  maxLength: 512,
  maxItems: 8,
} as const;

const CODING_RUNTIME_WORKSPACE_READ_CAUSE_CHAIN_FIELD = {
  type: "string-array",
  dataClass: "error-kind",
  required: false,
  maxLength: 128,
  maxItems: 5,
} as const;

const CODING_RUNTIME_WORKSPACE_READ_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.workspace-read",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingToolReadEditPorts.workspaceRead",
  fields: {
    // `absent`: a materialization read found no file at the path, which is the expected state of
    // a file the edit creates or a rename target, not a failure (#3873 review).
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "failed", "absent"],
    },
    purpose: CODING_RUNTIME_WORKSPACE_READ_PURPOSE_FIELD,
    reason: CODING_RUNTIME_WORKSPACE_READ_REASON_FIELD,
    absence: CODING_RUNTIME_WORKSPACE_READ_ABSENCE_FIELD,
    targetPathSha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    startLine: { type: "integer", dataClass: "count", required: false },
    maxLines: { type: "integer", dataClass: "count", required: false },
    frames: CODING_RUNTIME_WORKSPACE_READ_FRAMES_FIELD,
    causeChain: CODING_RUNTIME_WORKSPACE_READ_CAUSE_CHAIN_FIELD,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["coding-workspace-read"],
  proofIds: ["coding-runtime.workspace-read.emitted-line"],
  releaseImpact: "patch",
});

// #3873: which of the two edit forms the model used; body-free evidence on the edit lines. A
// replacement changeset also records how many files it deletes and moves (#3873 follow-up), each
// bounded by the form's 50-entry arrays; both counts are absent on the unified-diff form, where
// they were not measured.
const EDIT_FORMS = ["unified-diff", "replacements"] as const;
type EditForm = (typeof EDIT_FORMS)[number];

interface EditFormEvidence {
  readonly executionPath?: "server" | "browser";
  readonly editForm: EditForm;
  readonly deletionCount?: number;
  readonly renameCount?: number;
}

const EDIT_FORM_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [...EDIT_FORMS],
} as const;
const EDIT_DELETION_COUNT_FIELD = { type: "integer", dataClass: "count", required: false } as const;
const EDIT_RENAME_COUNT_FIELD = { type: "integer", dataClass: "count", required: false } as const;

const CODING_RUNTIME_EDITOR_MUTATION_SETTLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.editor-mutation.settled",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.codingToolReadEditPorts.completedEdit",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "failed", "cancelled", "rejected"],
    },
    actionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["edit"],
    },
    editForm: EDIT_FORM_FIELD,
    executionPath: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["server", "browser"],
    },
    deletionCount: EDIT_DELETION_COUNT_FIELD,
    renameCount: EDIT_RENAME_COUNT_FIELD,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["coding-editor-mutation"],
  proofIds: ["coding-runtime.editor-mutation.settled.emitted-line"],
  releaseImpact: "patch",
});

// #3610: a governed edit the editor route or this port refused is a decision, not a server
// failure — a stale base (CONTENT_HASH_MISMATCH), a policy denial, an invalid patch, no live
// Workbench. It rode the failure diagnostic at level error with errorKind internal, which also
// opened a support incident for every stale edit. The reason is the closed code the model receives;
// a client error's own code is free text, so it is recorded only as EDIT_CLIENT_ERROR. The first two
// groups are the editor-agent conflict and failure codes; the op catalog needs them as literals, and
// a test pins that every contract code is listed.
const EDIT_REFUSAL_REASONS = [
  "DIRTY",
  "VERSION_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "NO_ACTIVE_SESSION",
  "NO_ACTIVE_BRIDGE",
  "INVALID_EDITS",
  "OUT_OF_SCOPE",
  "DECOMPOSE_PER_ROOT",
  "PRECONDITION_REQUIRED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "TIMED_OUT",
  "QUEUE_FULL",
  "CANCELLED",
  "PROVIDER_UNAVAILABLE",
  "UNSUPPORTED_OPERATION",
  "LIMIT_EXCEEDED",
  "DUPLICATE_ACTION",
  "MUTATION_IN_FLIGHT",
  "EDIT_PREPARE_FAILED",
  "WORKSPACE_ACCESS_LOST",
  "EDIT_MUTATION_FAILED",
  "CHANGE_REJECTED",
  "EDIT_CLIENT_ERROR",
  "UNCLASSIFIED",
] as const;
type EditRefusalReason = (typeof EDIT_REFUSAL_REASONS)[number];
const EDIT_REFUSAL_REASON_SET: ReadonlySet<string> = new Set(EDIT_REFUSAL_REASONS);

// #3873 review: why a replacement changeset was refused before any editor action, so the log can
// separate a stale read from an ambiguous match or an exhausted budget. The materializer owns the
// vocabulary; the one entry added here is this port's own budget refusal.
type ReplacementRefusalEvidence = ReplacementRefusal | "patch-budget-exhausted";

const EDIT_REPLACEMENT_REFUSAL_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: [...REPLACEMENT_REFUSALS, "patch-budget-exhausted"],
} as const;

const CODING_RUNTIME_EDIT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.edit.refused",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.codingToolReadEditPorts.logEditRefused",
  fields: {
    reasonCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EDIT_REFUSAL_REASONS],
    },
    // #3611 review: EDIT_PREPARE_FAILED covers several causes; this names which one refused the
    // edit before it reached the editor route. The model-facing reason code stays the same.
    prepareCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...EDIT_PREPARE_CAUSES],
    },
    // The closed reason of the governed read a materialization could not complete (#3873 review).
    readReason: CODING_RUNTIME_WORKSPACE_READ_REASON_FIELD,
    replacementRefusal: EDIT_REPLACEMENT_REFUSAL_FIELD,
    editForm: EDIT_FORM_FIELD,
    executionPath: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["server", "browser"],
    },
    deletionCount: EDIT_DELETION_COUNT_FIELD,
    renameCount: EDIT_RENAME_COUNT_FIELD,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-editor-mutation"],
  proofIds: ["coding-runtime.edit.refused.emitted-line"],
  releaseImpact: "patch",
});

const EDIT_REFUSAL_ERROR_KINDS: Readonly<Record<EditRefusalReason, ActivityLogErrorKind>> = {
  DIRTY: "conflict",
  VERSION_MISMATCH: "conflict",
  CONTENT_HASH_MISMATCH: "conflict",
  DUPLICATE_ACTION: "conflict",
  MUTATION_IN_FLIGHT: "conflict",
  NO_ACTIVE_SESSION: "unavailable",
  NO_ACTIVE_BRIDGE: "unavailable",
  QUEUE_FULL: "unavailable",
  PROVIDER_UNAVAILABLE: "unavailable",
  EDIT_CLIENT_ERROR: "unavailable",
  INVALID_EDITS: "validation-failed",
  DECOMPOSE_PER_ROOT: "validation-failed",
  PRECONDITION_REQUIRED: "validation-failed",
  UNSUPPORTED_OPERATION: "validation-failed",
  LIMIT_EXCEEDED: "validation-failed",
  EDIT_PREPARE_FAILED: "validation-failed",
  OUT_OF_SCOPE: "authority-denied",
  POLICY_DENIED: "authority-denied",
  APPROVAL_REQUIRED: "authority-denied",
  CHANGE_REJECTED: "authority-denied",
  WORKSPACE_ACCESS_LOST: "authority-denied",
  TIMED_OUT: "timeout",
  CANCELLED: "cancelled",
  EDIT_MUTATION_FAILED: "internal",
  UNCLASSIFIED: "unknown",
};

function editRefusalReason(reasonCode: string | undefined): EditRefusalReason {
  if (reasonCode === undefined) return "UNCLASSIFIED";
  return EDIT_REFUSAL_REASON_SET.has(reasonCode)
    ? (reasonCode as EditRefusalReason)
    : "EDIT_CLIENT_ERROR";
}

const WORKSPACE_READ_ERROR_KINDS: Partial<
  Readonly<Record<WorkspaceReadFailureReason, ActivityLogErrorKind>>
> = {
  cancelled: "cancelled",
  timeout: "timeout",
  denied: "authority-denied",
  "preflight-refused": "authority-denied",
  "postflight-refused": "authority-denied",
  "not-found": "unavailable",
  "workspace-unavailable": "unavailable",
  "too-large": "validation-failed",
  "response-too-large": "validation-failed",
  exception: "internal",
  "process-failed": "internal",
};

function workspaceReadErrorKind(reason: WorkspaceReadFailureReason): ActivityLogErrorKind {
  return WORKSPACE_READ_ERROR_KINDS[reason] ?? "read-failed";
}

function completedRead(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
  request: RepositoryReadRequest,
  text: string,
):
  | { readonly status: "completed"; readonly read: CodingToolReadResult }
  | { readonly status: "failed"; readonly reasonCode?: string } {
  const window = readWindow(text, request.startLine, request.maxLines);
  const byteCount = Buffer.byteLength(window.text, "utf8");
  if (byteCount > MAX_READ_BYTES) {
    recordReadFailure(
      deps,
      { ok: false, reason: "too-large", binding },
      request.relativePath,
      "tool-result",
    );
    return readRefusal("too-large");
  }
  recordCompletedRead(deps, binding, request);
  return {
    status: "completed",
    read: {
      text: window.text,
      byteCount,
      // The digest always covers the WHOLE file so a later changeset's expectedContentHash stays
      // anchored to the governed read even when the model only saw a window of it.
      digest: wholeFileDigest(text),
      totalLines: window.totalLines,
      ...(window.nextStartLine === undefined ? {} : { nextStartLine: window.nextStartLine }),
    },
  };
}

// One formula for the digest a read reports and the pre-ask base check compares against (#3612):
// `secureWorkspaceTextDigest`, owned by the read port the replacement materializer checks its
// preconditions through as well (#3873 review). Exported under this name for the
// repository-instructions loader, whose `contentSha256` is this same digest.
export function wholeFileDigest(text: string): string {
  return secureWorkspaceTextDigest(text);
}

function recordCompletedRead(
  deps: CodingToolReadEditPortDeps,
  binding: RuntimeProducerBinding | undefined,
  request: RepositoryReadRequest,
): void {
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_WORKSPACE_READ_OPERATION,
      { correlationId: correlationIdOrUnknown(binding?.runId) },
      {
        state: "completed",
        purpose: "tool-result",
        targetPathSha256: targetPathDigest(request.relativePath),
        startLine: request.startLine ?? 1,
        maxLines: request.maxLines ?? 0,
      },
    ),
  );
}

// The refusals the secure read gives for the model's own request, by closed code: a path the policy
// denies, a file that does not exist, is not text, or exceeds the helper's bound. They reach the
// model and let the catalog settle the call as a refusal, not as a handler fault (#3615). A fault
// stays bare -- including a port that returns more than the read bound, which is not the model's
// request but a port this server must not trust.
export const WORKSPACE_READ_REFUSAL_CODES = {
  denied: "workspace-read-denied",
  "not-found": "workspace-read-not-found",
  "not-text": "workspace-read-not-text",
  "too-large": "workspace-read-too-large",
} as const satisfies Partial<Record<WorkspaceReadFailureReason, string>>;

function readRefusalCode(reason: WorkspaceReadFailureReason): string | undefined {
  return Object.hasOwn(WORKSPACE_READ_REFUSAL_CODES, reason)
    ? WORKSPACE_READ_REFUSAL_CODES[reason as keyof typeof WORKSPACE_READ_REFUSAL_CODES]
    : undefined;
}

// The model-facing shape of a failed read; its line was written by the governed read itself.
function readRefusal(reason: WorkspaceReadFailureReason): {
  readonly status: "failed";
  readonly reasonCode?: string;
} {
  const reasonCode = readRefusalCode(reason);
  return reasonCode === undefined ? { status: "failed" } : { status: "failed", reasonCode };
}

function logFailedRead(
  deps: CodingToolReadEditPortDeps,
  read: Extract<GovernedRead, { readonly ok: false }>,
  relativePath: string,
  purpose: ReadPurpose,
): void {
  const correlationId = correlationIdOrUnknown(read.binding?.runId);
  const { reason, error } = read;
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_WORKSPACE_READ_OPERATION,
      { correlationId, level: "warn", errorKind: workspaceReadErrorKind(reason) },
      {
        state: "failed",
        purpose,
        reason,
        ...(read.absence === undefined ? {} : { absence: read.absence }),
        targetPathSha256: targetPathDigest(relativePath),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
  if (error !== undefined) emitReadFailureDiagnostic(deps.diagnostics, correlationId, error);
}

function emitReadFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string,
  error: unknown,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "coding-runtime.workspace-read",
    source: "coding-tool-read-edit-ports.read",
    errorClass: contentFreeErrorClass(error),
    message: "workspace-read-failed",
  });
}

/**
 * Cuts the requested 1-based line window out of the full governed read. The whole file always
 * stays server-side; only the window travels back to the model (#2473 large-file reads).
 * Exported for the repository-instructions loader, which attaches the first-lines window of
 * AGENTS.md exactly as this read would answer it.
 */
export function readWindow(
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
  relativePath: string,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): ReadEditPreflightOutcome {
  if (isAborted(signal) || isDenied(relativePath) || !hasLiveWorkspaceAccess(deps)) {
    return { ok: false };
  }
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return { ok: false };
  if (binding === undefined && deps.enforceProducerBinding === true) return { ok: false };
  if (!readContextMatches(deps, binding) || !checkGuard(mutationGuard)) return { ok: false };
  return isDenied(relativePath) ? { ok: false } : { ok: true, binding };
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
  readonly requiresReview: boolean;
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
  const materialized = await materializedEdit(deps, request, signal, mutationGuard);
  if ("outcome" in materialized) return materialized.outcome;
  return executeMaterializedEdit(deps, materialized, signal, mutationGuard);
}

interface MaterializedEdit {
  readonly request: EditorChangesetRequest;
  readonly evidence: EditFormEvidence;
}

const PATCH_BUDGET_MESSAGE =
  "The materialized changeset does not fit the run's remaining patch budget; split it into smaller calls or finish with the changes already applied.";

// #3873: a replacement edit becomes the unified-diff changeset the rest of this path validates,
// reviews and applies; a refusal names the file and the reason the model can act on. Its reads
// are governed reads, its materialized diff is charged against the run's patch budget before any
// editor action exists, and every refusal records its closed class (#3873 review).
async function materializedEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<MaterializedEdit | { readonly outcome: EditOutcome }> {
  if (!("changeset" in request) || !isReplacementChangeset(request.changeset)) {
    return { request, evidence: { editForm: "unified-diff" } };
  }
  const evidence: EditFormEvidence = {
    editForm: "replacements",
    deletionCount: request.changeset.deletions?.length ?? 0,
    renameCount: request.changeset.renames?.length ?? 0,
  };
  const result = await materializeReplacementChangeset(
    materializationReadPort(deps, mutationGuard),
    request.changeset,
    signal,
  );
  if (result.status !== "materialized") {
    return { outcome: materializationRefused(deps, result, evidence) };
  }
  const charge = chargedMaterialization(request.changeset, result.changeset.patch, mutationGuard);
  if (!charge.ok) return { outcome: materializedChargeRefused(deps, charge.reason, evidence) };
  // Registered only now: a diff the run's budget refused never reaches an editor action, so it
  // must not leave provenance behind. The route asks for it again at admission and at the result.
  deps.materializedPatches?.register(result.changeset.patch);
  return { request: { ...request, changeset: result.changeset }, evidence };
}

// A refused charge names its real cause (#3873 review): only an exhausted budget is a budget
// refusal with the advice to split; a run that stopped, an authority that expired, drifted or was
// replayed is the guard's denial, and a workspace drift is lost workspace access.
function materializedChargeRefused(
  deps: CodingToolReadEditPortDeps,
  reason: CodingWorkbenchRuntimeFailureCode,
  evidence: EditFormEvidence,
): EditOutcome {
  const correlationId = editContextCorrelationId(deps);
  if (reason === "authority-budget-exceeded") {
    return editRefused(deps, correlationId, "LIMIT_EXCEEDED", {
      message: PATCH_BUDGET_MESSAGE,
      replacementRefusal: "patch-budget-exhausted",
      ...evidence,
    });
  }
  return editRefused(deps, correlationId, "EDIT_PREPARE_FAILED", {
    prepareCause: reason === "workspace-drift" ? "workspace-access-lost" : "guard-denied",
    ...evidence,
  });
}

// The governed reads a file can never answer, with what the model can do instead (#3873 review):
// retrying the same call cannot help, so the message says so.
const UNREADABLE_FOR_EDIT_MESSAGES: Partial<
  Record<GovernedWorkspaceReadFailure, (file: string) => string>
> = {
  "not-text": (file) =>
    `${file} is not a UTF-8 text file; keiko_changeset_edit changes text files only. Leave it in place and report it.`,
  "too-large": (file) =>
    `${file} is larger than the ${String(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES)} bytes a governed read returns, so keiko_changeset_edit cannot edit, move or delete it. Leave it in place and report it.`,
};

// A materialization that produced no changeset: a governed read that did not answer, recorded with
// its closed reason (a cancelled run as cancelled), or a refusal recorded with its closed class.
function materializationRefused(
  deps: CodingToolReadEditPortDeps,
  result: Exclude<ReplacementMaterialization, { readonly status: "materialized" }>,
  evidence: EditFormEvidence,
): EditOutcome {
  const correlationId = editContextCorrelationId(deps);
  if (result.status === "read-failed") {
    const message = UNREADABLE_FOR_EDIT_MESSAGES[result.reason]?.(result.file);
    return editRefused(deps, correlationId, "EDIT_PREPARE_FAILED", {
      prepareCause: result.reason === "cancelled" ? "cancelled" : "replacement-read-failed",
      readReason: result.reason,
      ...(isCodingSafeActivityPresentationPath(result.file) && !isDenied(result.file)
        ? { affectedRelativePath: result.file }
        : {}),
      ...(message === undefined ? {} : { message }),
      ...evidence,
    });
  }
  return editRefused(deps, correlationId, result.reasonCode, {
    message: result.message,
    replacementRefusal: result.refusal,
    ...evidence,
  });
}

// #3873 review: the run's patch budget bounds what is applied. Admission reserved the request
// payload as its floor; the materialized diff's excess over that floor is charged here, against the
// same authority record, before any editor action exists. A guard without the charge belongs to a
// wiring that owns no edit budget and charges nothing, as its admission charged nothing.
function chargedMaterialization(
  changeset: CodingToolReplacementChangeset,
  patch: string,
  mutationGuard: CodingToolMutationGuard,
): MaterializedPatchCharge {
  const charge = mutationGuard.chargeMaterializedPatch;
  if (charge === undefined) return { ok: true };
  const excess = Buffer.byteLength(patch, "utf8") - changesetPayloadBytes(changeset);
  return excess <= 0 ? { ok: true } : charge(excess);
}

// Binds the live editor session a prepared edit needs; a refusal here discards the mutation lease.
async function bindPreparedEdit(
  deps: CodingToolReadEditPortDeps,
  prepared: PreparedEdit,
  correlationId: string,
  evidence: EditFormEvidence,
): Promise<{ readonly action: EditorAgentAction } | { readonly refused: EditOutcome }> {
  const action = await bindLiveEditorSession(
    deps.editorAgentClient,
    prepared.action,
    prepared.workspaceRoot,
    prepared.signal,
  );
  if (action === undefined) {
    discardMutationLease(deps, prepared.leaseRequest);
    return {
      refused: editRefused(deps, correlationId, "NO_ACTIVE_SESSION", {
        ...NO_ACTIVE_SESSION_DETAIL,
        ...evidence,
      }),
    };
  }
  if (!hasLiveWorkspaceAccess(deps)) {
    discardMutationLease(deps, prepared.leaseRequest);
    return { refused: editRefused(deps, correlationId, "WORKSPACE_ACCESS_LOST", evidence) };
  }
  return { action };
}

async function executeMaterializedEdit(
  deps: CodingToolReadEditPortDeps,
  { request, evidence }: MaterializedEdit,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<EditOutcome> {
  const prepared = prepareEdit(deps, request, signal, mutationGuard);
  if ("refused" in prepared) {
    return editRefused(deps, editContextCorrelationId(deps), "EDIT_PREPARE_FAILED", {
      prepareCause: prepared.refused,
      ...evidence,
    });
  }
  const correlationId = editCorrelationId(prepared.action);
  try {
    const serverInput = serverPreparedEditInput(prepared);
    if (deps.serverRuntimeChangeset !== undefined && serverInput !== undefined) {
      return await executeServerPreparedEdit(
        deps,
        deps.serverRuntimeChangeset,
        serverInput,
        correlationId,
        { ...evidence, executionPath: "server" },
      );
    }
    return await executeBrowserPreparedEdit(deps, prepared, correlationId, {
      ...evidence,
      executionPath: "browser",
    });
  } catch (error) {
    discardMutationLease(deps, prepared.leaseRequest);
    emitEditFailureDiagnostic(deps.diagnostics, correlationId, error);
    return { status: "failed", reasonCode: "EDIT_TRANSPORT_ERROR" };
  }
}

function serverPreparedEditInput(prepared: PreparedEdit): RuntimeChangesetApplyInput | undefined {
  if (
    prepared.requiresReview ||
    prepared.leaseRequest === undefined ||
    prepared.workspaceRoot === undefined
  )
    return undefined;
  return {
    action: prepared.action,
    leaseRequest: prepared.leaseRequest,
    workspaceRoot: prepared.workspaceRoot,
    signal: prepared.signal,
  };
}

async function executeBrowserPreparedEdit(
  deps: CodingToolReadEditPortDeps,
  prepared: PreparedEdit,
  correlationId: string,
  evidence: EditFormEvidence,
): Promise<EditOutcome> {
  const bound = await bindPreparedEdit(deps, prepared, correlationId, evidence);
  if ("refused" in bound) return bound.refused;
  // Capture before dispatch: an automatic editor apply may settle before its HTTP response.
  const completion =
    prepared.leaseRequest === undefined
      ? undefined
      : deps.mutationLeaseCoordinator?.waitForMutation(prepared.leaseRequest, prepared.signal);
  const result = await deps.editorAgentClient.action(bound.action, prepared.signal);
  if (result.ok && editorStatusCompleted(result.value.result.status))
    return completedEdit(deps, correlationId, completion, evidence);
  discardMutationLease(deps, prepared.leaseRequest);
  return editRefused(deps, correlationId, editFailureReasonCode(result), {
    ...editFailureDetail(result),
    ...evidence,
  });
}

async function executeServerPreparedEdit(
  deps: CodingToolReadEditPortDeps,
  apply: RuntimeChangesetApplyPort,
  input: RuntimeChangesetApplyInput,
  correlationId: string,
  evidence: EditFormEvidence,
): Promise<EditOutcome> {
  const completion = deps.mutationLeaseCoordinator?.waitForMutation(
    input.leaseRequest,
    input.signal,
  );
  const result = await apply(input);
  if (result.status === "succeeded")
    return completedEdit(deps, correlationId, completion, evidence);
  discardMutationLease(deps, input.leaseRequest);
  if (input.signal.aborted) return editRefused(deps, correlationId, "CANCELLED", evidence);
  return editRefused(
    deps,
    correlationId,
    result.conflict?.code ?? result.failure?.code ?? "EDIT_MUTATION_FAILED",
    {
      ...(result.message === undefined ? {} : { message: result.message }),
      ...evidence,
    },
  );
}

// A change applied or rejected in its review is the human's decision, logged as such; a cancelled
// or failed mutation keeps its warn line (owner decision 2026-09-26, ADR-0124 D6: the review's "no"
// read as an internal mutation failure, and the model was told EDIT_MUTATION_FAILED).
const SETTLED_EDIT_REFUSALS: Readonly<
  Record<Exclude<CodingRuntimeMutationOutcome, "succeeded">, EditRefusalReason>
> = {
  rejected: "CHANGE_REJECTED",
  cancelled: "CANCELLED",
  failed: "EDIT_MUTATION_FAILED",
};

async function completedEdit(
  deps: CodingToolReadEditPortDeps,
  correlationId: string,
  completion: Promise<CodingRuntimeMutationOutcome> | undefined,
  evidence: EditFormEvidence,
): Promise<EditOutcome> {
  if (completion === undefined) return { status: "completed" };
  const outcome = await completion;
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_EDITOR_MUTATION_SETTLED_OPERATION,
      {
        correlationId,
        ...(outcome === "succeeded" || outcome === "rejected"
          ? {}
          : { level: "warn", errorKind: outcome === "cancelled" ? "cancelled" : "internal" }),
      },
      { state: outcome, actionKind: "edit", ...editFormFields(evidence) },
    ),
  );
  return outcome === "succeeded"
    ? { status: "completed" }
    : editRefused(deps, correlationId, SETTLED_EDIT_REFUSALS[outcome], evidence);
}

interface EditRefusalDetail extends Partial<EditFormEvidence> {
  readonly message?: string;
  readonly prepareCause?: EditPrepareCause;
  readonly readReason?: WorkspaceReadFailureReason;
  readonly replacementRefusal?: ReplacementRefusalEvidence;
  readonly affectedRelativePath?: string;
}

function editRefused(
  deps: CodingToolReadEditPortDeps,
  correlationId: string,
  reasonCode: string | undefined,
  detail: EditRefusalDetail = {},
): EditOutcome {
  const { message, affectedRelativePath, ...evidence } = detail;
  // The refusal line stays reason-code-only (body-free, AGENTS.md §8) — `message` never reaches
  // the activity log, only the outcome returned to the caller.
  logEditRefused(deps, correlationId, reasonCode, evidence);
  return {
    status: "failed",
    reasonCode,
    ...(message === undefined ? {} : { message }),
    ...(affectedRelativePath === undefined ? {} : { affectedRelativePath }),
    ...refusalCauseFields(evidence),
  };
}

// The closed cause of a preparation refusal, for the caller that classifies it: the same two words
// the refusal line records.
function refusalCauseFields({
  prepareCause,
  readReason,
}: Omit<EditRefusalDetail, "message">): Pick<EditRefusalDetail, "prepareCause" | "readReason"> {
  return {
    ...(prepareCause === undefined ? {} : { prepareCause }),
    ...(readReason === undefined ? {} : { readReason }),
  };
}

function editFormFields({
  executionPath,
  editForm,
  deletionCount,
  renameCount,
}: Partial<EditFormEvidence>): Partial<EditFormEvidence> {
  return {
    ...(executionPath === undefined ? {} : { executionPath }),
    ...(editForm === undefined ? {} : { editForm }),
    ...(deletionCount === undefined ? {} : { deletionCount }),
    ...(renameCount === undefined ? {} : { renameCount }),
  };
}

function refusalContextFields({
  prepareCause,
  readReason,
  replacementRefusal,
}: Omit<EditRefusalDetail, "message">): Pick<
  EditRefusalDetail,
  "prepareCause" | "readReason" | "replacementRefusal"
> {
  return {
    ...(prepareCause === undefined ? {} : { prepareCause }),
    ...(readReason === undefined ? {} : { readReason }),
    ...(replacementRefusal === undefined ? {} : { replacementRefusal }),
  };
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

// The editor route's own sentence for a conflict or failure -- "context mismatch at original line
// 12", "A declared file is missing from the patch." -- is product-authored text over paths and line
// numbers, never file content or command output. It rides to the caller (the facade decides what the
// model sees) and, like `message` above, never into the activity log. Without it the model saw the
// bare code and retried the same patch blind: the probe rehearsal of 2026-09-08 sent six
// INVALID_EDITS patches in a row and then gave up without delivering (#3390).
function editFailureDetail(result: Awaited<ReturnType<EditorAgentActionClient["action"]>>): {
  readonly message?: string;
} {
  if (!result.ok) return {};
  const outcome = result.value.result;
  const message = outcome.conflict?.message ?? outcome.failure?.message;
  return message === undefined ? {} : { message };
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
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "coding-runtime.editor-changeset",
      source: "coding-tool-read-edit-ports.edit",
      error,
      redact: (): string => "edit-transport-failed",
    }),
  );
}

// A governed edit the editor route refused (a policy denial, a conflict, a failed apply) is a
// decision the activity log must be able to reconstruct: before 2026-09-03 the only trace was the
// in-memory audit feed, and a workbench run that could never edit a file left an empty log. The
// reason is the closed refusal vocabulary above, never content, at warn level (#3610).
function logEditRefused(
  deps: CodingToolReadEditPortDeps,
  correlationId: string,
  reasonCode: string | undefined,
  evidence: Omit<EditRefusalDetail, "message">,
): void {
  const reason = editRefusalReason(reasonCode);
  const errorKind =
    evidence.prepareCause === undefined
      ? EDIT_REFUSAL_ERROR_KINDS[reason]
      : EDIT_PREPARE_ERROR_KINDS[evidence.prepareCause];
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_EDIT_REFUSED_OPERATION,
      { level: "warn", correlationId, errorKind },
      {
        reasonCode: reason,
        ...refusalContextFields(evidence),
        ...editFormFields(evidence),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
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
): PreparedEdit | { readonly refused: EditPrepareCause } {
  const validated = validatedChangeset(deps, request, signal, mutationGuard);
  if ("refused" in validated) return validated;
  const { changeset } = validated;
  const binding = mutationBinding(mutationGuard);
  if (binding === null || (binding === undefined && deps.enforceProducerBinding === true))
    return { refused: "binding-unavailable" };
  const context = resolveEditorContext(deps);
  if (context === undefined || !editorContextMatches(context, binding))
    return { refused: "editor-context-unavailable" };
  const action = changesetAction(request, changeset, context);
  const requiresReview = resolveReviewRequirement(deps);
  const leaseRequest = registerMutationLease(
    deps,
    action,
    context,
    binding,
    mutationGuard,
    requiresReview,
  );
  if (binding !== undefined && leaseRequest === undefined) return { refused: "lease-unavailable" };
  return {
    requiresReview,
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

type ValidatedChangeset =
  { readonly changeset: EditorAgentChangeset } | { readonly refused: EditPrepareCause };

function validatedChangeset(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): ValidatedChangeset {
  if (!hasLiveWorkspaceAccess(deps)) return { refused: "workspace-access-lost" };
  if (isAborted(signal)) return { refused: "cancelled" };
  if (!checkGuard(mutationGuard)) return { refused: "guard-denied" };
  if (!("changeset" in request) || !isExactEditorAgentChangeset(request.changeset))
    return { refused: "changeset-invalid" };
  const changeset = normalizeRawSingleFilePatch(request.changeset);
  return changeset === undefined ? { refused: "changeset-invalid" } : { changeset };
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
  requiresReview: boolean,
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
    requiresReview,
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

function safeMutationBinding(
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined {
  try {
    return mutationBinding(mutationGuard) ?? undefined;
  } catch {
    return undefined;
  }
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
