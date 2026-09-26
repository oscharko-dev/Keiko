// The six read-only BFF endpoints (ADR-0011 D5 routes 2,3,4,10,11,12). Each returns a redacted JSON
// projection of already-safe data: config via `toSafeObject` (strips apiKey), configured model
// capabilities, the workflow launch-form descriptors, the workspace summary built from the workspace
// layer, and evidence list/detail served straight from the store (manifests are redacted-by-
// construction on disk, served as-is per D9). No secret reaches any response; the config route
// never leaks the config path even on a load failure (handled upstream in deps.ts, which yields
// `config: undefined` rather than throwing).

import { resolve } from "node:path";
import {
  findConfiguredCapability,
  toSafeObject,
  listSafeConfiguredCapabilities,
  resolveVoiceCapability,
  selectRealtimeVoiceModel,
  type EnvSource,
} from "@oscharko-dev/keiko-model-gateway";
import {
  UNIT_TEST_WORKFLOW_DESCRIPTOR,
  BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR,
} from "@oscharko-dev/keiko-workflows";
import { DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import {
  listEvidence,
  loadEvidence,
  assertValidRunId,
  EvidenceReadError,
  EvidenceSchemaError,
  InvalidRunIdError,
  type EvidenceListEntry,
} from "@oscharko-dev/keiko-evidence";
import {
  buildContextPackFromFiles,
  buildWorkspaceSummary,
  DEFAULT_CONTEXT_REQUEST,
  detectWorkspace,
  discoverWithStatsAsync,
  WORKSPACE_CODES,
  WorkspaceError,
  WorkspaceNotFoundError,
  type WorkspaceCode,
  type DiscoveryResult,
  type WorkspaceSummary,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { resolveRecordedWorkspaceRoot } from "./workspace-root-denial-log.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  currentConversationReadinessObservation,
  currentGatewayConfig,
  currentGatewayConfigPresent,
  currentGroundingLimits,
} from "./deps.js";
import { validateProjectPath } from "./store/validation.js";

// Route 2 — resolved config (SafeGatewayConfig, never apiKey/baseUrl) or null when no config was resolved.
// effectiveGroundingLimits carries the runtime-resolved limits (file config + env) so the UI can
// surface caps without a separate API call.
export function handleConfig(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = currentGatewayConfig(deps);
  return {
    status: 200,
    body: {
      config: config === undefined ? null : toSafeObject(config),
      configPresent: currentGatewayConfigPresent(deps),
      effectiveGroundingLimits: currentGroundingLimits(deps),
    },
  };
}

// Route 3 — models published by the resolved UI gateway config. If no config is resolved, no
// model-backed run can start, so the endpoint returns an empty list. `conversationReady` is
// TRI-STATE on the wire (see currentConversationReadinessObservation): the observation store is
// process-local, so a hard `false` for never-probed models told the UI after every restart that
// nothing was usable until a manual probe plus reload (customer field incident, 0.3.11). Absent
// means "unknown — the on-demand probe at the conversation entry points decides honestly".
export function handleModels(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = currentGatewayConfig(deps);
  const models =
    config === undefined
      ? []
      : listSafeConfiguredCapabilities(config).map((model) => {
          const conversationReady = currentConversationReadinessObservation(deps, model.id);
          return {
            ...model,
            ...(conversationReady === undefined ? {} : { conversationReady }),
          };
        });
  return { status: 200, body: { models } };
}

// Voice-capability disable kill-switch (Issue #493, ADR-0100 D1). A regulated deployment can
// disable voice entirely via `KEIKO_VOICE_DISABLED`; the resolver then reports a clean
// `unavailable` (reason "policy-disabled") and Keiko stays fully usable. Exported so the voice
// dictation route (Issue #494) gates on the identical kill-switch, keeping one source of truth.
export function isVoiceDisabledByPolicy(env: EnvSource): boolean {
  const value = env.KEIKO_VOICE_DISABLED;
  return value === "1" || value?.toLowerCase() === "true";
}

// Route — voice capability resolution (Issue #493, Epic #491). Returns the content-free voice
// capability the UI reads before rendering any voice affordance. The resolution carries only enum
// literals and booleans — never a provider base URL, credential, model id, audio, or transcript —
// so provider credentials are never returned to the browser (AC4) and nothing sensitive can leak
// into UI logs (AC5), by construction. When no config is resolved, voice is disabled by policy, or
// no voice provider is configured, the endpoint returns a clean `unavailable` resolution rather
// than failing — Keiko stays fully usable in no-voice environments (AC1). Capability detection is
// metadata-only and performs NO network probe (ADR-0100 out-of-scope for #493).
export function handleVoiceCapability(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const config = currentGatewayConfig(deps);
  const policyDisabled = isVoiceDisabledByPolicy(deps.env);
  const voice = resolveVoiceCapability(config ?? { providers: [] }, { policyDisabled });
  return { status: 200, body: { voice } };
}

// Issue #495, Epic #491 — whether the running deployment should permit browser microphone capture.
// True only when the resolved voice capability advertises speech-to-text and voice is not disabled by
// policy. The server scopes the Permissions-Policy microphone directive to this (headers.ts /
// server.ts) so a no-voice deployment keeps the strict `microphone=()`. It mirrors the dictation
// route's capability gate (voice-handlers.ts selectDictationProvider) so the header and the route
// agree on exactly when dictation is permitted.
export function isVoiceDictationCapable(deps: UiHandlerDeps): boolean {
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return false;
  }
  const voice = resolveVoiceCapability(config, {
    policyDisabled: isVoiceDisabledByPolicy(deps.env),
  });
  return voice.available && voice.capabilities.speechToText;
}

// Issue #497, Epic #491 (ADR-0100 D3, ADR-0101) — whether the running deployment may open the
// realtime voice WebSocket control plane and the browser-native WebRTC media plane. True only when
// the resolved voice capability is the full-realtime profile (`transport.webrtcMedia`) and voice is
// not disabled by policy. It is the single source of truth for two gates: the capability-gated
// WebSocket upgrade (server.ts re-opens the BFF upgrade only for this) and the Permissions-Policy
// microphone scoping (a realtime-only-without-STT deployment still needs `microphone=(self)` for the
// WebRTC capture track, which `isVoiceDictationCapable` alone would not grant). A no-voice or
// STT-only deployment returns false, so the upgrade stays hard-rejected (AC1/AC3).
export function isVoiceRealtimeCapable(deps: UiHandlerDeps): boolean {
  const config = currentGatewayConfig(deps);
  if (config === undefined) {
    return false;
  }
  const voice = resolveVoiceCapability(config, {
    policyDisabled: isVoiceDisabledByPolicy(deps.env),
  });
  const realtimeModelId = selectRealtimeVoiceModel(config);
  const transcriptionModel =
    realtimeModelId === undefined
      ? undefined
      : findConfiguredCapability(config, realtimeModelId)?.realtimeTranscriptionModel?.trim();
  return voice.available && voice.transport.webrtcMedia && Boolean(transcriptionModel);
}

// Route 4 — launch-form metadata: the workflow descriptors plus the synthesized explain-plan and
// verify inputs (both are harness tasks with no workflow descriptor — verify is BFF-only and runs
// the deterministic verification orchestrator).
export function handleWorkflows(): RouteResult {
  return {
    status: 200,
    body: {
      descriptors: [UNIT_TEST_WORKFLOW_DESCRIPTOR, BUG_INVESTIGATION_WORKFLOW_DESCRIPTOR],
      explainPlan: {
        inputs: [
          {
            name: "filePath",
            type: "string",
            required: true,
            description: "Path to the file to explain (read-only task).",
          },
          {
            name: "question",
            type: "string",
            required: false,
            description: "Optional focusing question for the explanation.",
          },
        ],
        defaultLimits: DEFAULT_LIMITS,
      },
      verify: {
        inputs: [
          {
            name: "workspaceRoot",
            type: "string",
            required: true,
            description: "Project root to verify.",
          },
          {
            name: "targetFiles",
            type: "string[]",
            required: false,
            description: "Optional file subset to target tests for.",
          },
        ],
        defaultLimits: DEFAULT_LIMITS,
      },
    },
  };
}

function parsePositiveBudget(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("invalid budget");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("invalid budget");
  }
  return parsed;
}

export function workspaceErrorStatus(code: WorkspaceCode): number {
  if (code === WORKSPACE_CODES.NOT_FOUND) {
    return 404;
  }
  if (code === WORKSPACE_CODES.FILE_TOO_LARGE || code === WORKSPACE_CODES.READ_FAILED) {
    return 422;
  }
  return 400;
}

function workspaceErrorResult(error: WorkspaceError): RouteResult {
  return {
    status: workspaceErrorStatus(error.code),
    body: errorBody(error.code, workspaceErrorMessage(error.code)),
  };
}

const WORKSPACE_ERROR_MESSAGES: Record<WorkspaceCode, string> = {
  [WORKSPACE_CODES.PATH_ESCAPE]: "The workspace path is outside the registered project.",
  [WORKSPACE_CODES.PATH_DENIED]: "The workspace path is denied by policy.",
  [WORKSPACE_CODES.NOT_FOUND]: "The workspace could not be found.",
  [WORKSPACE_CODES.FILE_TOO_LARGE]: "The workspace file is too large.",
  [WORKSPACE_CODES.READ_FAILED]: "The workspace could not be read.",
  [WORKSPACE_CODES.REPO_SEARCH_INVALID_QUERY]: "The repository search query is invalid.",
  [WORKSPACE_CODES.REPO_SEARCH_INVALID_RANGE]:
    "The repository search range or scope path is invalid.",
  [WORKSPACE_CODES.REPO_SEARCH_UNSUPPORTED_FILE]:
    "The repository search does not support this file.",
};

function workspaceErrorMessage(code: WorkspaceCode): string {
  return WORKSPACE_ERROR_MESSAGES[code];
}

interface WorkspaceRequest {
  readonly dir: string;
  readonly task: string | undefined;
  readonly budget: number | undefined;
}

function readWorkspaceRequest(q: URLSearchParams): WorkspaceRequest | RouteResult {
  let budget: number | undefined;
  try {
    budget = parsePositiveBudget(q.get("budget"));
  } catch {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The budget query parameter must be a positive integer."),
    };
  }
  const dir = q.get("dir");
  if (dir === null) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The dir query parameter is required."),
    };
  }
  return { dir, task: q.get("task") ?? undefined, budget };
}

function workspaceNotRegisteredResult(): RouteResult {
  return {
    status: 403,
    body: errorBody(
      "WORKSPACE_NOT_REGISTERED",
      "The workspace directory is not a registered project.",
    ),
  };
}

function resolveRegisteredWorkspace(
  rawDir: string,
  deps: UiHandlerDeps,
): { readonly normalized: string } | RouteResult {
  let normalized: string;
  try {
    normalized = validateProjectPath(rawDir, { mustExist: false });
  } catch {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", "The dir query parameter must be a valid local project path."),
    };
  }
  const registered = deps.store.listProjects().some((project) => project.path === normalized);
  if (!registered) {
    return workspaceNotRegisteredResult();
  }
  return { normalized };
}

// KEIKO-0136: the workspace layer now yields during a full-tree walk. This cache preserves that
// responsiveness on cold reads too: concurrent callers share the same in-flight walk rather than
// starting duplicate scans. Completed results retain the short TTL used by gitRepositoryReads.
// Exported (not just an internal literal) so hermetic tests assert the TTL-expiry and
// max-entries-eviction behaviour against the value the production module actually owns, instead of
// restating the numbers as a second, driftable copy.
export const WORKSPACE_WALK_CACHE_TTL_MS = 2_000;
export const WORKSPACE_WALK_CACHE_MAX_ENTRIES = 32;

interface WorkspaceWalkCacheEntry {
  readonly expiresAt?: number | undefined;
  readonly value?: DiscoveryResult | undefined;
  readonly pending?: Promise<DiscoveryResult> | undefined;
}

const workspaceWalkCache = new Map<string, WorkspaceWalkCacheEntry>();

function cachedWorkspaceWalk(root: string, now: number): DiscoveryResult | undefined {
  const cached = workspaceWalkCache.get(root);
  if (cached?.value !== undefined && (cached.expiresAt ?? 0) > now) return cached.value;
  if (cached?.pending !== undefined) return undefined;
  workspaceWalkCache.delete(root);
  return undefined;
}

function storeWorkspaceWalk(root: string, value: DiscoveryResult, now: number): void {
  // Opportunistic sweep of expired entries and bounded-size eviction so a long-running server
  // with many roots never grows the cache without bound.
  for (const [key, entry] of workspaceWalkCache) {
    if (entry.pending === undefined && (entry.expiresAt ?? 0) <= now)
      workspaceWalkCache.delete(key);
  }
  if (workspaceWalkCache.size >= WORKSPACE_WALK_CACHE_MAX_ENTRIES) {
    const oldest = [...workspaceWalkCache.entries()].find(
      ([, entry]) => entry.pending === undefined,
    )?.[0];
    if (oldest !== undefined) workspaceWalkCache.delete(oldest);
  }
  workspaceWalkCache.set(root, { expiresAt: now + WORKSPACE_WALK_CACHE_TTL_MS, value });
}

function workspaceWalkFor(
  workspace: ReturnType<typeof detectWorkspace>,
  now: () => number,
): Promise<DiscoveryResult> {
  const root = workspace.root;
  const cached = cachedWorkspaceWalk(root, now());
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = workspaceWalkCache.get(root)?.pending;
  if (existing !== undefined) return existing;
  const pending = discoverWithStatsAsync(workspace, DEFAULT_CONTEXT_REQUEST.discovery);
  workspaceWalkCache.set(root, { pending });
  return pending.then(
    (value) => {
      storeWorkspaceWalk(root, value, now());
      return value;
    },
    (error: unknown) => {
      if (workspaceWalkCache.get(root)?.pending === pending) workspaceWalkCache.delete(root);
      throw error;
    },
  );
}

// Exported test-only helpers so hermetic unit tests never see cross-suite bleed and can observe
// cache population. Product code never calls these — the TTL sweep handles staleness by itself.
export function __resetWorkspaceWalkCacheForTests(): void {
  workspaceWalkCache.clear();
}
export function __workspaceWalkCacheSizeForTests(): number {
  return workspaceWalkCache.size;
}
export function __workspaceWalkCacheEntryForTests(root: string): DiscoveryResult | undefined {
  return workspaceWalkCache.get(root)?.value;
}

// A detected workspace carries two identities (see WorkspaceInfo): `root` is the realpath-admitted
// canonical directory every filesystem effect binds to, and `selectedRoot` is the lexical path the
// caller named. The authorization decision below stays canonical-to-canonical on purpose — it is
// the identity that holds even when no lexical alias could be verified — so the registered project
// path is canonicalized through the SAME admission before it is compared. Comparing the canonical
// walk result against the lexical registration denied every project reached through a symlinked
// ancestor: on macOS the platform aliases resolve `/tmp/...` and `/var/...` to `/private/...`, so
// an ordinary user-selected root answered 403 on every workspace read. The response body is the
// other half of that pair and reports `selectedRoot` (via buildWorkspaceSummary), so a client that
// hands the reported root back as `dir` still names a registered project. Root admission is
// unchanged and still runs first — a denied root raises PathDeniedError (recorded on the activity
// log by the shared helper) and an unresolvable one surfaces as WORKSPACE_NOT_FOUND, mirroring the
// detection layer's own taxonomy rather than escaping as an opaque 500.
function canonicalRegisteredWorkspaceRoot(
  registeredRoot: string,
  correlationId: string | undefined,
): string {
  try {
    return resolveRecordedWorkspaceRoot(nodeWorkspaceFs, resolve(registeredRoot), {
      correlationId,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceNotFoundError("workspace root is unavailable", registeredRoot);
  }
}

async function workspaceSummaryResult(
  request: WorkspaceRequest,
  registeredRoot: string,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  now: () => number = Date.now,
): Promise<RouteResult> {
  try {
    const canonicalRoot = canonicalRegisteredWorkspaceRoot(registeredRoot, correlationId);
    const workspace = detectWorkspace(registeredRoot);
    // The walk-up must land on the registered directory itself and never on a parent workspace,
    // whose wider tree would otherwise be summarized for a project the user never registered.
    // That invariant is unchanged; it is now decided canonical-to-canonical.
    if (workspace.root !== canonicalRoot) {
      return workspaceNotRegisteredResult();
    }
    const walk = await workspaceWalkFor(workspace, now);
    const { files, stats } = walk;
    const wantsContext = request.task !== undefined || request.budget !== undefined;
    const pack = wantsContext
      ? buildContextPackFromFiles(
          workspace,
          {
            ...DEFAULT_CONTEXT_REQUEST,
            task: request.task,
            budgetBytes: request.budget ?? DEFAULT_CONTEXT_REQUEST.budgetBytes,
          },
          files,
        )
      : undefined;
    const summary = buildWorkspaceSummary(workspace, pack, stats);
    const body = deps.redactor({ summary }) as { readonly summary: WorkspaceSummary };
    return { status: 200, body };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const result = workspaceErrorResult(error);
      return { status: result.status, body: deps.redactor(result.body) };
    }
    throw error;
  }
}

// Route 12 — workspace summary and optional context pack, built by the safe workspace layer. `now`
// is an injectable clock for the walk-cache TTL (KEIKO-0253); it defaults to Date.now so the route
// table's two-argument call is unchanged and only hermetic tests ever pass an override.
export async function handleWorkspace(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  now: () => number = Date.now,
): Promise<RouteResult> {
  const request = readWorkspaceRequest(ctx.url.searchParams);
  if ("status" in request) {
    return request;
  }
  const registered = resolveRegisteredWorkspace(request.dir, deps);
  if ("status" in registered) {
    return registered;
  }
  return workspaceSummaryResult(request, registered.normalized, deps, ctx.correlationId, now);
}

interface EvidenceFilters {
  readonly workspace: string | undefined;
  readonly date: string | undefined;
  readonly workflow: string | undefined;
  readonly model: string | undefined;
  readonly outcome: string | undefined;
}

function readFilters(url: URL): EvidenceFilters {
  const q = url.searchParams;
  return {
    workspace: q.get("workspace") ?? undefined,
    date: q.get("date") ?? undefined,
    workflow: q.get("workflow") ?? undefined,
    model: q.get("model") ?? undefined,
    outcome: q.get("outcome") ?? undefined,
  };
}

// `EvidenceListEntry.startedAt` is epoch ms; the `date` filter matches the started-at calendar day
// (UTC `YYYY-MM-DD`). `workspace` is a substring match to support path-fragment filtering, while
// `model` is an exact model-id match.
function matchesOptionalFilter(value: string | undefined, filter: string | undefined): boolean {
  return filter === undefined || value === filter;
}

function matchesDateFilter(entry: EvidenceListEntry, date: string | undefined): boolean {
  return date === undefined || new Date(entry.startedAt).toISOString().slice(0, 10) === date;
}

function matchesWorkspaceFilter(entry: EvidenceListEntry, workspace: string | undefined): boolean {
  return workspace === undefined || entry.workspaceRoot?.includes(workspace) === true;
}

function matchesFilters(entry: EvidenceListEntry, filters: EvidenceFilters): boolean {
  return (
    matchesOptionalFilter(entry.taskType, filters.workflow) &&
    matchesOptionalFilter(entry.outcome, filters.outcome) &&
    matchesDateFilter(entry, filters.date) &&
    matchesOptionalFilter(entry.modelId, filters.model) &&
    matchesWorkspaceFilter(entry, filters.workspace)
  );
}

// Route 10 — evidence list header projection, filtered server-side.
export function handleEvidenceList(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const filters = readFilters(ctx.url);
  try {
    const entries = listEvidence(deps.evidenceStore).filter((entry) =>
      matchesFilters(entry, filters),
    );
    return { status: 200, body: { entries } };
  } catch (error) {
    // listEvidence skips a single bad manifest, so reaching here means a store-level fault. Map it
    // the way the detail sibling does instead of surfacing an opaque 500 for a diagnosable,
    // pre-redacted condition; anything unrecognised still propagates to the top-level handler.
    if (error instanceof EvidenceSchemaError) {
      return { status: 422, body: errorBody("EVIDENCE_SCHEMA", error.message) };
    }
    if (error instanceof EvidenceReadError) {
      return { status: 422, body: errorBody("EVIDENCE_READ", EVIDENCE_READ_CLIENT_MESSAGE) };
    }
    throw error;
  }
}

// EvidenceReadError wraps whatever the underlying fs call's own error carried (constructed across
// keiko-evidence, e.g. store.ts's getManifest: `cannot read evidence manifest: ${error.message}`),
// and a raw Node fs error message can embed the evidence directory's absolute path (an EACCES/ENOENT
// message quotes the path it failed on). EvidenceSchemaError's message never does — every
// constructor call embeds only a bounded, already-client-known runId — so only EVIDENCE_READ needs
// this static substitute.
const EVIDENCE_READ_CLIENT_MESSAGE = "The evidence record could not be read.";

// Route 11 — a single evidence manifest, served as-is (already redacted on disk). Invalid runId →
// 400; absent → 404; an EvidenceSchemaError → 422 (safe, runId-only `.message`); an
// EvidenceReadError → 422 with a static client message (see EVIDENCE_READ_CLIENT_MESSAGE).
export function handleEvidenceDetail(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const runId = ctx.params.runId ?? "";
  try {
    assertValidRunId(runId);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "The run id is not valid.") };
  }
  try {
    const manifest = loadEvidence(deps.evidenceStore, runId);
    if (manifest === undefined) {
      return { status: 404, body: errorBody("NOT_FOUND", "No evidence for that run id.") };
    }
    return { status: 200, body: { manifest } };
  } catch (error) {
    // Issue #622 — an over-long runId is rejected by the store with a static, path-free
    // InvalidRunIdError before any fs read; surface it as a 400 (not a generic 500).
    if (error instanceof InvalidRunIdError) {
      return { status: 400, body: errorBody("BAD_REQUEST", error.message) };
    }
    if (error instanceof EvidenceSchemaError) {
      return { status: 422, body: errorBody("EVIDENCE_SCHEMA", error.message) };
    }
    if (error instanceof EvidenceReadError) {
      return { status: 422, body: errorBody("EVIDENCE_READ", EVIDENCE_READ_CLIENT_MESSAGE) };
    }
    throw error;
  }
}
