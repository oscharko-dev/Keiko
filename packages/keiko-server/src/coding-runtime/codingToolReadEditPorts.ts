import { createHash } from "node:crypto";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentAction,
  type EditorAgentChangeset,
  type EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import type { EditorAgentHttpClient } from "@oscharko-dev/keiko-tools";
import { detectWorkspaceAt, discoverWithStats, isDenied } from "@oscharko-dev/keiko-workspace";

import {
  contentFreeErrorClass,
  emitServerDiagnostic,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";
import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import { isExactEditorAgentChangeset, type CodingToolReadResult } from "./codingToolIpc.js";
import type { CodingToolActionOf, GovernedCodingToolPort } from "./codingToolGovernedDelegate.js";
import type {
  CodingRuntimeEditorMutationLeaseCoordinator,
  CodingRuntimeEditorMutationLeaseRequest,
} from "./codingRuntimeEditorMutationLeaseCoordinator.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

const MAX_READ_BYTES = 65_536;
const RAW_SINGLE_FILE_PATCH =
  /^:[0-7]{6} [0-7]{6} [a-f0-9]{7,64} [a-f0-9]{7,64} M ([^\r\n]+)\r?\n(@@ [\s\S]+)$/u;

type RepositoryReadRequest = CodingToolActionOf<"read">;
type RepositoryDiscoverRequest = CodingToolActionOf<"discover">;
type EditorChangesetRequest = CodingToolActionOf<"edit">;

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
  readonly requiresEditorReview?: (() => boolean) | undefined;
  readonly diagnostics?: ServerDiagnosticSink | undefined;
  readonly mutationLeaseCoordinator?:
    Pick<CodingRuntimeEditorMutationLeaseCoordinator, "register" | "discard"> | undefined;
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
  const binding = discoveryPreflight(deps, signal, mutationGuard);
  if (binding === false) return { status: "failed" };
  try {
    const workspaceRoot = deps.resolveWorkspaceRoot?.();
    if (workspaceRoot === undefined) return { status: "failed" };
    const workspace = detectWorkspaceAt(workspaceRoot);
    const discovered = discoverWithStats(workspace, {
      maxDepth: 40,
      maxFiles: 20_000,
      applyGitignore: true,
    });
    const text = discoveredPathText(
      discovered.files.map(({ relativePath }): string => relativePath),
      request.query,
      request.maxResults,
    );
    if (!discoveryPostflight(deps, workspaceRoot, binding, signal, mutationGuard)) {
      return { status: "failed" };
    }
    return { status: "completed", read: discoveryReadResult(text) };
  } catch (error) {
    emitDiscoveryFailureDiagnostic(deps.diagnostics, binding, request.actionId, error);
    return { status: "failed" };
  }
}

const SAFE_DISCOVERY_CORRELATION_ID = /^[A-Za-z0-9:._-]{1,128}$/u;

function emitDiscoveryFailureDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  binding: RuntimeProducerBinding | undefined,
  actionId: string,
  error: unknown,
): void {
  const candidate = binding?.runId ?? actionId;
  emitServerDiagnostic(diagnostics, {
    correlationId: SAFE_DISCOVERY_CORRELATION_ID.test(candidate)
      ? candidate
      : "coding-discovery-failure",
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
  const binding = readPreflight(deps, request, signal, mutationGuard);
  if (binding === false) return { status: "failed" };
  const result = await deps.secureWorkspaceTextRead.readText({
    relativePath: request.relativePath,
    signal,
  });
  if (!readPostflight(deps, result, binding, signal, mutationGuard)) return { status: "failed" };
  if (Buffer.byteLength(result.text, "utf8") > MAX_READ_BYTES) return { status: "failed" };
  const window = readWindow(result.text, request.startLine, request.maxLines);
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

function readPreflight(
  deps: CodingToolReadEditPortDeps,
  request: RepositoryReadRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined | false {
  if (isAborted(signal) || isDenied(request.relativePath)) return false;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return false;
  if (!readContextMatches(deps, binding) || !checkGuard(mutationGuard)) return false;
  return isDenied(request.relativePath) ? false : binding;
}

function discoveryPreflight(
  deps: CodingToolReadEditPortDeps,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): RuntimeProducerBinding | undefined | false {
  if (isAborted(signal)) return false;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return false;
  return readContextMatches(deps, binding) && checkGuard(mutationGuard) ? binding : false;
}

function discoveryPostflight(
  deps: CodingToolReadEditPortDeps,
  workspaceRoot: string,
  binding: RuntimeProducerBinding | undefined,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): boolean {
  return (
    deps.resolveWorkspaceRoot?.() === workspaceRoot &&
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

async function executeEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): Promise<{ readonly status: "completed" | "failed" }> {
  const prepared = prepareEdit(deps, request, signal, mutationGuard);
  if (prepared === undefined) return { status: "failed" };
  try {
    const action = await bindLiveEditorSession(
      deps.editorAgentClient,
      prepared.action,
      prepared.workspaceRoot,
      prepared.signal,
    );
    if (action === undefined) {
      discardMutationLease(deps, prepared.leaseRequest);
      return { status: "failed" };
    }
    const result = await deps.editorAgentClient.action(action, prepared.signal);
    const completed = result.ok && editorStatusCompleted(result.value.result.status);
    if (!completed) discardMutationLease(deps, prepared.leaseRequest);
    return editOutcome(completed);
  } catch {
    discardMutationLease(deps, prepared.leaseRequest);
    return { status: "failed" };
  }
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

function prepareEdit(
  deps: CodingToolReadEditPortDeps,
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): PreparedEdit | undefined {
  const changeset = validatedChangeset(request, signal, mutationGuard);
  if (changeset === undefined) return undefined;
  const binding = mutationBinding(mutationGuard);
  if (binding === null) return undefined;
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

function validatedChangeset(
  request: EditorChangesetRequest,
  signal: AbortSignal | undefined,
  mutationGuard: CodingToolMutationGuard,
): EditorAgentChangeset | undefined {
  if (isAborted(signal) || !checkGuard(mutationGuard) || !("changeset" in request)) {
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

function editOutcome(completed: boolean): { readonly status: "completed" | "failed" } {
  return { status: completed ? "completed" : "failed" };
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
