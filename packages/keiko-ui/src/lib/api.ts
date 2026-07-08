/**
 * Typed fetch wrapper for the 12 BFF routes (ADR-0011 D5).
 * Same-origin relative paths (/api/...). Parses the {error:{code,message}} envelope.
 * Never logs response bodies.
 */

import type {
  BffError,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  Chat,
  ChatMessage,
  ChatResponse,
  ChatsResponse,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  ChatStatus,
  ChatMessageRole,
  ChatWorkflowStatus,
  DesktopChatBootstrapResponse,
  DesktopChatSendResponse,
  EvidenceListEntry,
  EvidenceManifest,
  GroundedAnswer,
  GroundedAskRequest,
  FilesDirectoryListing,
  FilesContentResponse,
  FilesMutationResponse,
  FilesPreviewResponse,
  FilesSearchResponse,
  FilesTreeResponse,
  GitDiffScope,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
  GitHistoryResponse,
  GitRepositorySummary,
  GitRemotesResponse,
  GitSyncExecuteResponse,
  GitSyncOperation,
  GitSyncPreview,
  GatewayReadinessOptions,
  GatewayReadinessReport,
  EditorDocumentVersion,
  EditorCompletionContextSelectors,
  EditorCompletionWireRequest,
  EditorCompletionWireResponse,
  EditorCompletionWireTriggerKind,
  EditorInlineCompletionWireRequest,
  EditorInlineCompletionWireResponse,
  EditorInlineCompletionWireTriggerKind,
  EditorInlineCompletionTelemetryReport,
  EditorTestGenerationWireRequest,
  EditorTestGenerationWireResponse,
  EditorTestGenerationWireTarget,
  EditorPatchApplyDecision,
  EditorPatchApplyWireRequest,
  EditorPatchApplyWireResponse,
  LanguageDiagnosticsResult,
  LanguageServiceCapabilities,
  LanguageHoverResult,
  LanguageSymbolResult,
  LanguageFormattingResult,
  LanguageFormattingOptions,
  EditorAgentAction,
  EditorAgentActionQueuedResponse,
  EditorAgentActionResultRequest,
  EditorAgentAuditResponse,
  EditorAgentSessionSnapshot,
  EditorAgentSessionsResponse,
  EditorAgentSnapshotRequest,
  EditorAgentSnapshotResponse,
  CostClass,
  GroundingLimits,
  MessageResponse,
  MessagesResponse,
  ModelCapability,
  PatchChatMessageBody,
  PatchMessageResponse,
  PromptEnhancementWireRequest,
  PromptEnhancementWireResponse,
  ProjectResponse,
  ProjectsResponse,
  RunReport,
  SafeGatewayConfig,
  VoiceCapabilityResolution,
  UpdatePreflightReport,
  UpdateRemediationActionRequest,
  UpdateRemediationStatusReport,
  UpdateRemediationStatusRequest,
  UpdateRestartVerificationRequest,
  UpdateSession,
  UpdateSessionStartRequest,
  UpdateSessionStatus,
  WorkspaceSummary,
  WorkflowsResponse,
} from "./types";
import type {
  GitCommitChangeSummary,
  GitCommitIntentAnalysis,
  GitCommitMessageValidation,
  GitCommitMessageViolationCode,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchSidecarGatewayResult,
  GitDeliveryActionSheet,
  GitDeliveryActionSheetRequest,
  GitDeliveryApprovalClaim,
  EditorHotExitSnapshotV1,
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
  PdfCitationPreviewStatusResponse,
  VoicePersona,
  GitRepositoryValidation,
} from "@oscharko-dev/keiko-contracts";
import {
  validateGitHistoryResponse,
  validateGitRemotesResponse,
  validateGitRepositoryDiffResponse,
  validateGitRepositoryStatusResponse,
  validateGitRepositorySummary,
  validateGitSyncExecuteResponse,
  validateGitSyncPreview,
  validateCodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import {
  DESKTOP_CHAT_STREAM_EVENT_TYPES,
  isDesktopChatStreamEvent,
  type DesktopChatSendRequestWire,
  type DesktopChatStreamDoneEvent,
  type DesktopChatStreamErrorEvent,
  type DesktopChatStreamEventType,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  DEFAULT_GROUNDING_LIMITS,
  EDITOR_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
  EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
  EDITOR_TEST_GENERATION_SCHEMA_VERSION,
  EDITOR_PATCH_APPLY_SCHEMA_VERSION,
} from "./types";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  // RB-6 (GEN-OBS-CORRELATION-103/601): the server-issued request correlation id for this failure,
  // when the response carried one (X-Keiko-Correlation-Id header or `error.correlationId`). Optional
  // and set after construction so the many `new ApiError(code, message, status)` call sites are
  // unchanged; error surfaces can show it as a copyable support id that ties the UI failure to exactly
  // one server-side diagnostic record.
  public correlationId?: string;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ResponseValidator = (value: unknown) => GitRepositoryValidation;

function validateBffResponse<T>(path: string, value: unknown, validator: ResponseValidator): T {
  const validation = validator(value);
  if (validation.ok) return value as T;
  const reason = validation.reasons[0] ?? "unknown validation failure";
  throw new ApiError(
    "CONTRACT_VALIDATION_FAILED",
    `BFF response for ${path} failed contract validation: ${reason}`,
    502,
  );
}

function validateCodexSubscriptionProfileResponse(value: unknown): GitRepositoryValidation {
  const result = validateCodingWorkbenchCodexSubscriptionProfile(value);
  return result.ok ? { ok: true } : { ok: false, reasons: result.errors };
}

// GEN-RES-FETCH-001 — reads against the loopback BFF must not hang the UI when the BFF
// stalls (a GET still pending after 15s is a failure, not a slow success; the browser's
// own network timeout is minutes). State-changing requests keep NO default deadline —
// long-running mutations (git operations, index builds) are legitimate — and a
// caller-supplied signal is COMBINED with the deadline, never replaced by it.
const DEFAULT_READ_TIMEOUT_MS = 15_000;

function withReadDeadline(
  init: RequestInit | undefined,
  isStateChanging: boolean,
): AbortSignal | null {
  if (isStateChanging) return init?.signal ?? null;
  const deadline = AbortSignal.timeout(DEFAULT_READ_TIMEOUT_MS);
  const caller = init?.signal;
  return caller === undefined || caller === null ? deadline : AbortSignal.any([caller, deadline]);
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  validator?: ResponseValidator,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    ...init,
    signal: withReadDeadline(init, isStateChanging),
    headers: {
      Accept: "application/json",
      ...(isStateChanging ? { "Content-Type": "application/json" } : {}),
      ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message, never log body
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const value = (await res.json()) as unknown;
  return validator === undefined ? (value as T) : validateBffResponse<T>(path, value, validator);
}

async function fetchBinary(path: string, init?: RequestInit): Promise<Uint8Array> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    signal: withReadDeadline(init, isStateChanging),
    headers: {
      Accept: "application/pdf",
      ...(isStateChanging ? { "Content-Type": "application/json" } : {}),
      ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message, never log body
    }
    throw new ApiError(code, message, res.status);
  }

  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Route 1 — health
// ---------------------------------------------------------------------------

export async function fetchHealth(): Promise<{ status: "ok"; version: string }> {
  return fetchJson("/api/health");
}

// ---------------------------------------------------------------------------
// Coding Workbench
// ---------------------------------------------------------------------------

export async function fetchCodingWorkbenchSidecarGatewayProfile(): Promise<CodingWorkbenchSidecarGatewayResult> {
  return fetchJson("/api/coding-sidecar/gateway/profile", { cache: "no-store" });
}

export async function fetchCodingWorkbenchCodexSubscriptionProfile(): Promise<CodingWorkbenchCodexSubscriptionProfile> {
  return fetchJson(
    "/api/coding-workbench/codex-subscription/profile",
    { cache: "no-store" },
    validateCodexSubscriptionProfileResponse,
  );
}

// ---------------------------------------------------------------------------
// Update preflight
// ---------------------------------------------------------------------------

export async function fetchStartupUpdatePreflight(): Promise<UpdatePreflightReport> {
  return fetchJson("/api/update/preflight", { cache: "no-store" });
}

export async function checkUpdatePreflight(): Promise<UpdatePreflightReport> {
  return fetchJson("/api/update/preflight/check", { method: "POST", cache: "no-store" });
}

export async function fetchUpdateSessionStatus(): Promise<UpdateSessionStatus> {
  return fetchJson("/api/update/session", { cache: "no-store" });
}

export async function startUpdateSession(input: UpdateSessionStartRequest): Promise<UpdateSession> {
  return fetchJson("/api/update/session", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export async function retryUpdateSession(): Promise<UpdateSession> {
  return fetchJson("/api/update/session/retry", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify({}),
  });
}

export async function cancelUpdateSession(): Promise<UpdateSession> {
  return fetchJson("/api/update/session", { method: "DELETE", cache: "no-store" });
}

export async function verifyUpdateRestart(
  input: UpdateRestartVerificationRequest = {},
): Promise<UpdateSession> {
  return fetchJson("/api/update/session/verify-restart", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export async function fetchUpdateRemediationStatus(): Promise<UpdateRemediationStatusReport> {
  return fetchJson("/api/update/remediation", { cache: "no-store" });
}

export async function prepareUpdateRemediationStatus(
  input: UpdateRemediationStatusRequest,
): Promise<UpdateRemediationStatusReport> {
  return fetchJson("/api/update/remediation/status", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export async function runUpdateRemediationAction(
  input: UpdateRemediationActionRequest,
): Promise<UpdateRemediationStatusReport> {
  return fetchJson("/api/update/remediation/actions", {
    method: "POST",
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Route 2 — config
// ---------------------------------------------------------------------------

interface FetchConfigResponse {
  readonly config: SafeGatewayConfig | null;
  readonly configPresent: boolean;
  readonly effectiveGroundingLimits: GroundingLimits;
}

let configRequest: Promise<FetchConfigResponse> | undefined;

export function clearConfigCacheForTests(): void {
  configRequest = undefined;
}

export async function fetchConfig(): Promise<FetchConfigResponse> {
  configRequest ??= fetchJson<{
    config: SafeGatewayConfig | null;
    configPresent: boolean;
    effectiveGroundingLimits?: GroundingLimits;
  }>("/api/config")
    .then((raw) => ({
      config: raw.config,
      configPresent: raw.configPresent,
      effectiveGroundingLimits: raw.effectiveGroundingLimits ?? DEFAULT_GROUNDING_LIMITS,
    }))
    .finally(() => {
      configRequest = undefined;
    });
  return configRequest;
}

export type { FetchConfigResponse };

// ---------------------------------------------------------------------------
// Route 3 — models
// ---------------------------------------------------------------------------

let modelsRequest: Promise<{ models: ModelCapability[] }> | undefined;

export function clearModelCacheForTests(): void {
  modelsRequest = undefined;
}

export async function fetchModels(): Promise<{ models: ModelCapability[] }> {
  modelsRequest ??= fetchJson<{ models: ModelCapability[] }>("/api/models").catch(
    (error: unknown) => {
      modelsRequest = undefined;
      throw error;
    },
  );
  return modelsRequest;
}

// ---------------------------------------------------------------------------
// Voice capability (Issue #493, Epic #491)
// ---------------------------------------------------------------------------

// Reads the content-free voice capability resolution the UI consults before rendering any voice
// affordance. The response carries only enum literals and booleans — never a provider base URL,
// credential, or model id — so it is safe to read and display (AC4/AC5). When voice is unavailable
// the resolution reports `available: false` with a `profile` of "none", and the UI renders no
// voice affordance at all (AC1).
export async function fetchVoiceCapability(): Promise<{ voice: VoiceCapabilityResolution }> {
  return fetchJson<{ voice: VoiceCapabilityResolution }>("/api/voice/capability");
}

// Issue #495, Epic #491 — controlled composer dictation. Posts one short audio clip to the local
// BFF speech-to-text route (Issue #494) and returns its transcript. The audio rides as base64 inside
// the standard JSON + CSRF envelope `fetchJson` already applies, so the server's "state-changing
// requests must be JSON and carry the CSRF guard" invariant is preserved — the browser never sets a
// raw audio body or reaches a model directly. The request carries only the audio bytes plus
// content-free metadata; the response carries only the transcript and content-free provider metadata
// (never a provider base URL, credential, or model id — AC4/AC5, by construction on the BFF side).
export interface VoiceTranscriptionRequest {
  // Base64-encoded audio bytes (no `data:` URI prefix, no whitespace).
  readonly audio: string;
  // Audio container MIME type the BFF accepts (e.g. "audio/webm"); parameters such as `;codecs=opus`
  // are stripped server-side before the allowlist check.
  readonly mimeType: string;
  // Optional declared clip length in milliseconds (positive integer within the dictation limit).
  readonly durationMs?: number | undefined;
  // Optional BCP-47 language tag hint for the provider.
  readonly language?: string | undefined;
  // Optional short domain-keyword prompt (length-bounded server-side) to bias transcription toward
  // in-domain proper nouns / identifiers. Omitted lets the BFF apply its language-neutral default.
  readonly prompt?: string | undefined;
}

export interface VoiceTranscriptionResult {
  readonly transcript: string;
  readonly confidence?: number | undefined;
  readonly language?: string | undefined;
  readonly durationMs?: number | undefined;
}

export async function transcribeDictation(
  input: VoiceTranscriptionRequest,
): Promise<VoiceTranscriptionResult> {
  return fetchJson<VoiceTranscriptionResult>("/api/voice/transcribe", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Issue #1558, Epic #1556 — assistant speech output. Posts the visible assistant answer text to the
// local BFF synthesis route (Issue #1558) and returns the synthesized audio as base64 inside the
// standard JSON + CSRF envelope `fetchJson` already applies. The browser never reaches a provider
// directly and never sees a provider base URL, credential, or voice id (content-free on the BFF
// side). The request is abortable so a stop / mute / session switch cancels pending provider work
// (AC3); on abort `fetch` throws and the caller treats it as a silent cancel rather than a failure.
export interface VoiceSpeechRequest {
  // The exact assistant answer text shown in the transcript, so the spoken output cannot diverge from
  // the visible text (AC2).
  readonly text: string;
  // Issue #1559 — the selected product voice persona ("male" | "female" | "neutral"). Content-free: the
  // server resolves the actual voice id from this enum and the configured provider; the browser never
  // sees or sends a voice id. Optional so existing callers keep their provider-default voice.
  readonly persona?: VoicePersona;
}

export interface VoiceSpeechResult {
  // Base64-encoded synthesized audio bytes (no `data:` URI prefix).
  readonly audio: string;
  // The audio container MIME type to label the decoded blob with (e.g. "audio/mpeg").
  readonly mimeType: string;
}

export async function synthesizeAssistantSpeech(
  input: VoiceSpeechRequest,
  signal?: AbortSignal,
): Promise<VoiceSpeechResult> {
  return fetchJson<VoiceSpeechResult>("/api/voice/speak", {
    method: "POST",
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Streaming synthesis: returns the raw Response so the caller can read `response.body` as PCM chunks
// (AudioWorklet playback). The same CSRF + JSON-request envelope applies; a non-2xx is parsed into an
// ApiError exactly like fetchJson so the caller can fall back to the buffered route. Abortable — on a
// stop / mute / barge-in the fetch throws and the caller treats it as a silent cancel.
export async function streamAssistantSpeech(
  input: VoiceSpeechRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch("/api/voice/speak/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      Accept: "audio/pcm",
    },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message, never log body
    }
    throw new ApiError(code, message, res.status);
  }
  return res;
}

export interface GatewaySetupInput {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiKeyHeaderName?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly deploymentNames?: readonly string[] | undefined;
  readonly imageInputModelIds?: readonly string[] | undefined;
  readonly voiceBaseUrl?: string | undefined;
  readonly voiceApiKey?: string | undefined;
  readonly voiceApiKeyHeaderName?: string | undefined;
  readonly voiceModelId?: string | undefined;
  readonly voiceProviderLocality?: string | undefined;
  readonly voiceTimeoutMs?: number | undefined;
  readonly figmaAccessToken?: string | undefined;
  readonly preserveExisting?: boolean | undefined;
}

export interface GatewaySetupResponse {
  readonly ok: true;
  readonly testedModelId: string;
  readonly testedModelIds: readonly string[];
  readonly skippedModelIds?: readonly string[] | undefined;
  readonly providerCount: number;
  readonly models: ModelCapability[];
  readonly config: SafeGatewayConfig;
}

export async function setupGateway(body: GatewaySetupInput): Promise<GatewaySetupResponse> {
  const response = await fetchJson<GatewaySetupResponse>("/api/gateway/setup", {
    method: "POST",
    body: JSON.stringify(body),
  });
  clearConfigCacheForTests();
  clearModelCacheForTests();
  return response;
}

export async function runGatewayReadiness(
  modelId?: string,
  options?: GatewayReadinessOptions,
): Promise<GatewayReadinessReport> {
  return fetchJson<GatewayReadinessReport>("/api/gateway/readiness", {
    method: "POST",
    body: JSON.stringify({
      ...(modelId === undefined ? {} : { modelId }),
      ...(options === undefined ? {} : { options }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Route 4 — workflows
// ---------------------------------------------------------------------------

export async function fetchWorkflows(): Promise<WorkflowsResponse> {
  return fetchJson("/api/workflows");
}

// ---------------------------------------------------------------------------
// Route 5 — start run
// ---------------------------------------------------------------------------

export interface StartRunInput {
  workflowId?: string;
  taskType?: string;
  input: Record<string, unknown>;
  modelId: string;
  apply?: boolean;
  limits?: Record<string, unknown>;
  governedHandoff?: Record<string, unknown>;
  governedHandoffSourceGroundedRunId?: string;
  voiceOrigin?: {
    readonly profile: string;
    readonly turnIndex: number;
    readonly source: string;
    readonly committedSegments: number;
    readonly committedText: string;
    readonly confirmationDigest?: string | undefined;
  };
}

export async function startRun(
  body: StartRunInput,
): Promise<{ runId: string; fingerprint: string }> {
  return fetchJson("/api/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Epic #1307 / Issue #1314 — generate a governed, reviewable Enhanced Prompt. Deterministic and
// provider-neutral; the result is data for review, never executed. The optional AbortSignal lets the
// panel cancel an in-flight request when the user edits the draft again.
export async function enhancePrompt(
  body: PromptEnhancementWireRequest,
  signal?: AbortSignal,
): Promise<PromptEnhancementWireResponse> {
  return fetchJson<PromptEnhancementWireResponse>("/api/prompt-enhancement", {
    method: "POST",
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ---------------------------------------------------------------------------
// Route 7 — cancel run
// ---------------------------------------------------------------------------

export async function cancelRun(runId: string): Promise<{ ok: true }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

// ---------------------------------------------------------------------------
// Route 8 — get run report
// ---------------------------------------------------------------------------

export async function fetchRunReport(runId: string): Promise<{ report: RunReport }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
}

// ---------------------------------------------------------------------------
// Route 9 — apply patch
// ---------------------------------------------------------------------------

export async function applyRun(runId: string): Promise<{ report: RunReport }> {
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

// ---------------------------------------------------------------------------
// Route 10 — list evidence
// ---------------------------------------------------------------------------

export interface EvidenceFilters {
  workspace?: string;
  date?: string;
  workflow?: string;
  model?: string;
  outcome?: string;
}

export async function fetchEvidenceList(
  filters: EvidenceFilters = {},
): Promise<{ entries: EvidenceListEntry[] }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return fetchJson(`/api/evidence${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// Route 11 — get evidence manifest
// ---------------------------------------------------------------------------

export async function fetchEvidenceManifest(
  runId: string,
): Promise<{ manifest: EvidenceManifest }> {
  return fetchJson(`/api/evidence/${encodeURIComponent(runId)}`);
}

// ---------------------------------------------------------------------------
// Route 12 — workspace summary
// ---------------------------------------------------------------------------

export interface WorkspaceSummaryFilters {
  dir: string;
  task?: string;
  budget?: number;
}

export async function fetchWorkspaceSummary(
  filters: WorkspaceSummaryFilters,
): Promise<{ summary: WorkspaceSummary }> {
  const params = new URLSearchParams();
  params.set("dir", filters.dir);
  if (filters.task !== undefined) {
    params.set("task", filters.task);
  }
  if (filters.budget !== undefined) {
    params.set("budget", String(filters.budget));
  }
  const qs = params.toString();
  return fetchJson(`/api/workspace${qs ? `?${qs}` : ""}`);
}

// ---------------------------------------------------------------------------
// ADR-0013 — UI-local persistence client (routes 13–22)
// ---------------------------------------------------------------------------

const PROJECTS_CACHE_TTL_MS = 2000;

let projectsRequest: Promise<ProjectsResponse> | undefined;
let projectsCache: { readonly value: ProjectsResponse; readonly expiresAt: number } | undefined;

function clearProjectCache(): void {
  projectsRequest = undefined;
  projectsCache = undefined;
}

export function clearProjectRequestForTests(): void {
  clearProjectCache();
}

export async function fetchProjects(): Promise<ProjectsResponse> {
  const now = Date.now();
  if (projectsCache !== undefined && projectsCache.expiresAt > now) {
    return projectsCache.value;
  }
  projectsRequest ??= fetchJson<ProjectsResponse>("/api/projects")
    .then((value) => {
      projectsCache = { value, expiresAt: Date.now() + PROJECTS_CACHE_TTL_MS };
      return value;
    })
    .catch((error: unknown) => {
      projectsCache = undefined;
      throw error;
    })
    .finally(() => {
      projectsRequest = undefined;
    });
  return projectsRequest;
}

export interface CreateProjectInput {
  path: string;
  name?: string;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectResponse> {
  const response = await fetchJson<ProjectResponse>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  clearProjectCache();
  return response;
}

export interface CloneRepositoryInput {
  repositoryUrl: string;
  destinationPath: string;
  name?: string;
}

export async function cloneRepository(input: CloneRepositoryInput): Promise<ProjectResponse> {
  const response = await fetchJson<ProjectResponse>("/api/repositories/clone", {
    method: "POST",
    body: JSON.stringify(input),
  });
  clearProjectCache();
  return response;
}

export interface UpdateProjectInput {
  name?: string;
  favorite?: boolean;
}

export async function updateProject(
  path: string,
  patch: UpdateProjectInput,
): Promise<ProjectResponse> {
  const response = await fetchJson<ProjectResponse>(
    `/api/projects?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  clearProjectCache();
  return response;
}

export async function deleteProject(path: string): Promise<void> {
  await fetchJson<void>(`/api/projects?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    body: "{}",
  });
  clearProjectCache();
}

export async function fetchChats(projectPath: string): Promise<ChatsResponse> {
  return fetchJson(`/api/chats?projectPath=${encodeURIComponent(projectPath)}`);
}

export interface CreateChatInput {
  projectPath: string;
  title: string;
  selectedModel: string;
  branchLabel?: string;
}

export async function createChat(input: CreateChatInput): Promise<ChatResponse> {
  return fetchJson("/api/chats", { method: "POST", body: JSON.stringify(input) });
}

export interface UpdateChatInput {
  title?: string;
  selectedModel?: string;
  branchLabel?: string;
  status?: ChatStatus;
  connectedScope?: ChatConnectedScope | null;
  connectedScopes?: readonly ChatConnectedScope[] | null;
  localKnowledgeScope?: ChatLocalKnowledgeScope | null;
  localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[] | null;
}

export async function updateChat(id: string, patch: UpdateChatInput): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// Epic #532 — M3: bind a list of sources (1+N) to a chat. `null` clears ALL
// connected scopes. Kept separate from the single-source helper so callers
// that still use singular binding are not affected. Always patches the plural
// `connectedScopes` field so the BFF stores and returns the canonical list.
export async function updateChatConnectedScopes(
  chatId: string,
  scopes: readonly ChatConnectedScope[] | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ connectedScopes: scopes }),
  });
}

export async function updateChatLocalKnowledgeScope(
  chatId: string,
  scope: ChatLocalKnowledgeScope | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ localKnowledgeScope: scope }),
  });
}

// Epic #189 — Slice 3 M1: bind a plural list of connector sources to a chat. `null` clears ALL
// localKnowledgeScopes. Mirrors `updateChatConnectedScopes` for the local-knowledge side.
// Always patches the plural `localKnowledgeScopes` field so the BFF stores and returns the list.
export async function updateChatLocalKnowledgeScopes(
  chatId: string,
  scopes: readonly ChatLocalKnowledgeScope[] | null,
): Promise<ChatResponse> {
  return fetchJson(`/api/chats?id=${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: JSON.stringify({ localKnowledgeScopes: scopes }),
  });
}

export async function deleteChat(id: string): Promise<void> {
  await fetchJson<void>(`/api/chats?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: "{}",
  });
}

export async function fetchChatMessages(
  chatId: string,
  projectPath: string,
): Promise<MessagesResponse> {
  const params = new URLSearchParams();
  params.set("chatId", chatId);
  params.set("projectPath", projectPath);
  return fetchJson(`/api/chats/messages?${params.toString()}`);
}

export interface CreateMessageInput {
  chatId: string;
  projectPath: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  runId?: string;
  workflowId?: string;
  workflowStatus?: ChatWorkflowStatus;
  shortResult?: string;
  /** Issue #66 — labels harness task runs (verify, explain-plan). */
  taskType?: string;
}

export async function createChatMessage(input: CreateMessageInput): Promise<MessageResponse> {
  return fetchJson("/api/chats/messages", { method: "POST", body: JSON.stringify(input) });
}

export interface CreateRunSummaryPairInput {
  chatId: string;
  projectPath: string;
  user: {
    content: string;
    timestamp: number;
  };
  summary: {
    content: string;
    timestamp: number;
    runId: string;
    workflowId?: string;
    workflowStatus: ChatWorkflowStatus;
    shortResult?: string;
    /** Issue #66 — labels harness task runs (verify, explain-plan). */
    taskType?: string;
  };
}

export async function createRunSummaryPair(
  input: CreateRunSummaryPairInput,
): Promise<MessagesResponse> {
  return fetchJson("/api/chats/messages/run-summary-pair", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Issue #66 — PATCH the run-summary message in place and keep the selected project's
// normalized path on the request so the BFF can enforce chat ownership before patching.
export async function patchChatMessage(
  id: string,
  chatId: string,
  projectPath: string,
  body: PatchChatMessageBody,
): Promise<PatchMessageResponse> {
  const params = new URLSearchParams();
  params.set("id", id);
  params.set("chatId", chatId);
  params.set("projectPath", projectPath);
  return fetchJson(`/api/chats/messages?${params.toString()}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Desktop canvas V1 — real chat through the existing model gateway
// ---------------------------------------------------------------------------

export interface CreateDesktopChatInput {
  projectPath?: string;
  title?: string;
  modelId?: string;
}

export async function createDesktopChat(
  input: CreateDesktopChatInput = {},
): Promise<DesktopChatBootstrapResponse> {
  return fetchJson("/api/desktop/chats", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type SendDesktopChatInput = DesktopChatSendRequestWire;

export interface AppendDesktopChatVoiceTurnMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp?: number | undefined;
}

export interface AppendDesktopChatVoiceTurnInput {
  readonly chatId: string;
  readonly projectPath: string;
  readonly messages: readonly AppendDesktopChatVoiceTurnMessage[];
  readonly modelId?: string | undefined;
  readonly memory?: ConversationMemoryRequestWire;
  readonly idempotencyKey?: string | undefined;
}

export interface AppendDesktopChatVoiceTurnResponse {
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly memory?: ConversationMemoryResultWire;
}

export async function appendDesktopChatVoiceTurn(
  input: AppendDesktopChatVoiceTurnInput,
): Promise<AppendDesktopChatVoiceTurnResponse> {
  return fetchJson<AppendDesktopChatVoiceTurnResponse>("/api/desktop/chat/voice-turn", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface RealtimeGroundedToolInput {
  readonly chatId: string;
  readonly projectPath: string;
  readonly callId: string;
  readonly query: string;
  readonly userTranscript?: string | undefined;
  readonly modelId?: string | undefined;
  readonly memory?: ConversationMemoryRequestWire | undefined;
}

export interface RealtimeGroundedToolOutput {
  readonly status: "ok";
  readonly answer: string;
  readonly groundingKind: GroundedAnswer["groundingKind"];
  readonly elapsedMs: number;
  readonly citations: readonly {
    readonly marker: string;
    readonly label: string;
    readonly source?: string | undefined;
  }[];
  readonly evidenceRunId?: string | undefined;
  readonly persisted: {
    readonly userMessageId: string;
    readonly assistantMessageId: string;
  };
  readonly instruction: string;
}

export interface RealtimeGroundedToolResponse {
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly groundedAnswer: GroundedAnswer;
  readonly toolOutput: RealtimeGroundedToolOutput;
  readonly memory?: ConversationMemoryResultWire | undefined;
}

export async function runRealtimeGroundedTool(
  input: RealtimeGroundedToolInput,
  signal?: AbortSignal,
): Promise<RealtimeGroundedToolResponse> {
  return fetchJson<RealtimeGroundedToolResponse>("/api/voice/realtime/grounded-tool", {
    method: "POST",
    body: JSON.stringify(input),
    signal: signal ?? null,
  });
}

// Issue #152 — accepts an optional AbortSignal so the Conversation Center can
// cancel an in-flight ungrounded send. RequestInit.signal is `AbortSignal |
// null` under exactOptionalPropertyTypes; convert at the boundary so callers
// pass `AbortSignal | undefined` like every other API helper here.
export async function sendDesktopChat(
  input: SendDesktopChatInput,
  signal?: AbortSignal,
): Promise<DesktopChatSendResponse> {
  return fetchJson("/api/desktop/chat", {
    method: "POST",
    body: JSON.stringify(input),
    signal: signal ?? null,
  });
}

export interface RegenerateDesktopChatInput {
  readonly chatId: string;
  readonly projectPath: string;
  readonly assistantMessageId: string;
  readonly modelId?: string;
  readonly memory?: ConversationMemoryRequestWire;
}

export async function regenerateDesktopChat(
  input: RegenerateDesktopChatInput,
  signal?: AbortSignal,
): Promise<DesktopChatSendResponse> {
  return fetchJson("/api/desktop/chat/regenerate", {
    method: "POST",
    body: JSON.stringify(input),
    signal: signal ?? null,
  });
}

// ---------------------------------------------------------------------------
// Desktop chat SSE streaming — Issue #152 Layer 3
// ---------------------------------------------------------------------------

// Thrown pre-stream when the BFF responds with a non-SSE content-type (e.g.
// STREAMING_UNSUPPORTED). The caller falls back to sendDesktopChat.
export class StreamingUnavailableError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamingUnavailableError";
  }
}

export type SseDonePayload = DesktopChatStreamDoneEvent["data"];
type SseErrorPayload = DesktopChatStreamErrorEvent["data"];

export interface StreamHandlers {
  readonly onToken: (text: string) => void;
  readonly onDone: (payload: SseDonePayload) => void;
  readonly onError: (payload: SseErrorPayload) => void;
  readonly onCancelled: () => void;
}

function parseSseEventName(value: string): DesktopChatStreamEventType | undefined {
  return DESKTOP_CHAT_STREAM_EVENT_TYPES.includes(value as DesktopChatStreamEventType)
    ? (value as DesktopChatStreamEventType)
    : undefined;
}

function assertNeverStreamEvent(event: never): never {
  throw new Error(`Unhandled desktop chat stream event: ${JSON.stringify(event)}`);
}

function malformedDesktopChatStreamError(): ApiError {
  return new ApiError(
    "MALFORMED_DESKTOP_CHAT_STREAM_EVENT",
    "The chat stream returned an invalid event. Retry the request.",
    502,
  );
}

// Dispatches a parsed SSE (event, data) pair to the appropriate handler.
function dispatchSseEvent(
  eventName: DesktopChatStreamEventType | undefined,
  parsed: unknown,
  handlers: StreamHandlers,
): void {
  const candidate = { event: eventName, data: parsed };
  if (!isDesktopChatStreamEvent(candidate)) throw malformedDesktopChatStreamError();
  switch (candidate.event) {
    case "token": {
      handlers.onToken(candidate.data.text);
      break;
    }
    case "done": {
      handlers.onDone(candidate.data);
      break;
    }
    case "error": {
      handlers.onError(candidate.data);
      break;
    }
    case "cancelled": {
      handlers.onCancelled();
      break;
    }
    default:
      assertNeverStreamEvent(candidate);
  }
}

// Processes one chunk of lines from the SSE stream. Returns the updated
// `pendingEvent` name (carries over across chunk boundaries).
function processSseLines(
  lines: readonly string[],
  pendingEvent: DesktopChatStreamEventType | undefined,
  handlers: StreamHandlers,
): DesktopChatStreamEventType | undefined {
  let current = pendingEvent;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      current = parseSseEventName(line.slice("event:".length).trim());
    } else if (line.startsWith("data:")) {
      const dataText = line.slice("data:".length).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataText) as unknown;
      } catch {
        throw malformedDesktopChatStreamError();
      }
      dispatchSseEvent(current, parsed, handlers);
      current = undefined;
    } else if (line === "") {
      current = undefined;
    }
  }
  return current;
}

// Reads `response.body` as a text/event-stream, buffering partial lines across
// reads. Dispatches typed events to `handlers`. Respects the passed `signal` —
// when aborted it stops reading without dispatching further events.
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let pendingEvent: DesktopChatStreamEventType | undefined;
  let reachedEof = false;

  try {
    while (!signal.aborted) {
      const read = await reader.read();
      if (read.done) {
        reachedEof = true;
        break;
      }
      lineBuffer += decoder.decode(read.value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      pendingEvent = processSseLines(lines, pendingEvent, handlers);
    }
    // Flush any residual content left in lineBuffer when the stream ends
    // naturally (EOF). A proxy or buffer that drops the terminal \n\n would
    // otherwise silently lose the final SSE frame. Skipped on abort because
    // the contract is "stop reading without dispatching further events".
    if (reachedEof && lineBuffer !== "") {
      processSseLines([lineBuffer], pendingEvent, handlers);
    }
  } finally {
    reader.releaseLock();
  }
}

// Issue #152 Layer 3 — POST to /api/desktop/chat/stream with the same
// headers/body as sendDesktopChat. If the response is NOT text/event-stream
// (BFF returned a JSON pre-stream error), throws StreamingUnavailableError
// so the caller can fall back. Otherwise reads the stream and dispatches to
// handlers. Respects `signal` (abort stops reading immediately).
export async function sendDesktopChatStream(
  input: SendDesktopChatInput,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await fetch("/api/desktop/chat/stream", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(input),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // Pre-stream error — parse the JSON envelope and throw typed.
    let code = "STREAMING_UNSUPPORTED";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as { error?: { code?: string; message?: string } };
      code = envelope.error?.code ?? code;
      message = envelope.error?.message ?? message;
    } catch {
      // parse failure — keep generic values, never log body
    }
    throw new StreamingUnavailableError(code, message);
  }

  if (res.body === null) {
    throw new StreamingUnavailableError("STREAMING_UNSUPPORTED", "Response body was null.");
  }

  await consumeSseStream(res.body, signal, handlers);
}

// ---------------------------------------------------------------------------
// Desktop terminal — ADR-0018 bounded permitted-command execution; client moved to
// ./terminal-api.ts. The PTY routes (/api/terminal/shells, /sessions, WS upgrade) are removed.

// ---------------------------------------------------------------------------
// Desktop files — selected-root browser, preview, and editor control plane
// ---------------------------------------------------------------------------

export async function fetchFilesDirectories(
  root: string,
  path?: string,
): Promise<FilesDirectoryListing> {
  const params = new URLSearchParams();
  params.set("root", root);
  if (path !== undefined && path.length > 0) params.set("path", path);
  return fetchJson(`/api/files/directories?${params.toString()}`);
}

export async function fetchFilesTree(root: string, path = ""): Promise<FilesTreeResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  if (path.length > 0) params.set("path", path);
  return fetchJson(`/api/files/tree?${params.toString()}`);
}

export async function fetchFilesSearch(
  root: string,
  query: string,
  limit?: number,
  init?: Pick<RequestInit, "signal">,
): Promise<FilesSearchResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  return fetchJson(`/api/files/search?${params.toString()}`, init);
}

export async function fetchFilesPreview(root: string, path: string): Promise<FilesPreviewResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("path", path);
  return fetchJson(`/api/files/preview?${params.toString()}`);
}

export async function fetchFilesContent(root: string, path: string): Promise<FilesContentResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  params.set("path", path);
  return fetchJson(`/api/files/content?${params.toString()}`);
}

export async function saveFilesContent(input: {
  readonly root: string;
  readonly path: string;
  readonly content: string;
  readonly expectedModifiedAt?: number | undefined;
  // Issue #1197: version-aware optimistic-concurrency token. Supersedes expectedModifiedAt.
  readonly baseVersion?: EditorDocumentVersion | undefined;
}): Promise<FilesContentResponse> {
  return fetchJson("/api/files/content", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface EditorHotExitWriteResponse {
  readonly snapshotRef: string;
  readonly contentSizeBytes: number;
  readonly suppressed?: boolean;
}

export interface EditorHotExitReadResponse {
  readonly found: boolean;
  readonly snapshot?: Omit<
    EditorHotExitSnapshotV1,
    "schemaVersion" | "workspaceRoot" | "relativePath"
  > & {
    readonly schemaVersion: 1;
    readonly contentSizeBytes: number;
  };
}

export async function writeEditorHotExitContent(
  snapshot: EditorHotExitSnapshotV1,
): Promise<EditorHotExitWriteResponse> {
  return fetchJson("/api/editor/hot-exit/write", {
    method: "POST",
    body: JSON.stringify({ snapshot }),
  });
}

export async function readEditorHotExitContent(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly snapshotRef: string;
}): Promise<EditorHotExitReadResponse> {
  return fetchJson("/api/editor/hot-exit/read", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteEditorHotExitContent(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly snapshotRef: string;
}): Promise<void> {
  await fetchJson<void>("/api/editor/hot-exit/delete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// File-tree mutations. fetchJson adds the CSRF header + JSON content-type for these POSTs and maps a
// non-2xx envelope to ApiError; the server keeps every mutation inside the selected root.
export async function createFilesEntry(input: {
  readonly root: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}): Promise<FilesMutationResponse> {
  return fetchJson("/api/files/create", { method: "POST", body: JSON.stringify(input) });
}

export async function renameFilesEntry(input: {
  readonly root: string;
  readonly path: string;
  readonly newPath: string;
  // Issue 2.6: optional version-aware precondition; only an editor/agent holding the open buffer sets it.
  readonly baseVersion?: EditorDocumentVersion | undefined;
}): Promise<FilesMutationResponse> {
  return fetchJson("/api/files/rename", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteFilesEntry(input: {
  readonly root: string;
  readonly path: string;
  readonly baseVersion?: EditorDocumentVersion | undefined;
}): Promise<FilesMutationResponse> {
  return fetchJson("/api/files/delete", { method: "POST", body: JSON.stringify(input) });
}

export async function copyFilesEntry(input: {
  readonly root: string;
  readonly sourcePath: string;
  readonly destPath: string;
}): Promise<FilesMutationResponse> {
  return fetchJson("/api/files/copy", { method: "POST", body: JSON.stringify(input) });
}

export async function fetchGitStatus(root: string): Promise<GitRepositoryStatusResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(
    `/api/git/status?${params.toString()}`,
    undefined,
    validateGitRepositoryStatusResponse,
  );
}

export interface GitBranchListEntry {
  readonly name: string;
  readonly headRefHash: string;
  readonly current: boolean;
}

export interface GitBranchListResponse {
  readonly schemaVersion: "1";
  readonly root: string;
  readonly repositoryRoot?: string | undefined;
  readonly available: boolean;
  readonly state: "available" | "unavailable" | "unsafe";
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly branches: readonly GitBranchListEntry[];
  readonly truncated: boolean;
}

export async function fetchGitBranches(root: string): Promise<GitBranchListResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(`/api/git/branches?${params.toString()}`);
}

export async function fetchGitSummary(root: string): Promise<GitRepositorySummary> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(
    `/api/git/summary?${params.toString()}`,
    undefined,
    validateGitRepositorySummary,
  );
}

export async function fetchGitHistory(input: {
  readonly root: string;
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
}): Promise<GitHistoryResponse> {
  const params = new URLSearchParams();
  params.set("root", input.root);
  if (input.limit !== undefined) params.set("limit", input.limit.toString());
  if (input.skip !== undefined) params.set("skip", input.skip.toString());
  return fetchJson(`/api/git/history?${params.toString()}`, undefined, validateGitHistoryResponse);
}

export async function fetchGitRemotes(root: string): Promise<GitRemotesResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(`/api/git/remotes?${params.toString()}`, undefined, validateGitRemotesResponse);
}

export async function fetchGitDiff(input: {
  readonly root: string;
  readonly path?: string | undefined;
  readonly scope?: GitDiffScope | undefined;
}): Promise<GitRepositoryDiffResponse> {
  const params = new URLSearchParams();
  params.set("root", input.root);
  if (input.path !== undefined && input.path.length > 0) params.set("path", input.path);
  if (input.scope !== undefined) params.set("scope", input.scope);
  return fetchJson(
    `/api/git/diff?${params.toString()}`,
    undefined,
    validateGitRepositoryDiffResponse,
  );
}

// Issue #1199 — governed editor completion gateway. Posts the overlay buffer + cursor to the BFF,
// which runs deterministic language-service completion and (when a governed model is configured)
// gated model-assisted completion. The browser never reaches a model directly. `signal` lets the
// editor cancel a superseded request.
export interface EditorCompletionRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly triggerKind: EditorCompletionWireTriggerKind;
  readonly triggerCharacter?: string | undefined;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
  readonly maxCostClass?: CostClass | undefined;
}

export async function requestEditorCompletion(
  input: EditorCompletionRequestInput,
  signal?: AbortSignal,
): Promise<EditorCompletionWireResponse> {
  const requestBody: EditorCompletionWireRequest = {
    schemaVersion: EDITOR_COMPLETION_SCHEMA_VERSION,
    root: input.root,
    document: { path: input.path, languageId: input.languageId, text: input.text },
    position: input.position,
    triggerKind: input.triggerKind,
    ...(input.triggerCharacter === undefined ? {} : { triggerCharacter: input.triggerCharacter }),
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.maxCostClass === undefined ? {} : { maxCostClass: input.maxCostClass }),
  };
  return fetchJson("/api/editor/completion", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1200 — governed editor inline completion (ghost text). Posts the overlay buffer + cursor to
// the BFF, which runs a gated aligned suffix-aware (FIM) model over coding context and returns a
// single ghost-text continuation (or zero items when degraded/disabled/rate-limited). The browser
// never reaches a model directly. `signal` lets the editor cancel a superseded request.
export interface EditorInlineCompletionRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly triggerKind: EditorInlineCompletionWireTriggerKind;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
  readonly maxCostClass?: CostClass | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export async function requestEditorInlineCompletion(
  input: EditorInlineCompletionRequestInput,
  signal?: AbortSignal,
): Promise<EditorInlineCompletionWireResponse> {
  const requestBody: EditorInlineCompletionWireRequest = {
    schemaVersion: EDITOR_INLINE_COMPLETION_SCHEMA_VERSION,
    root: input.root,
    document: { path: input.path, languageId: input.languageId, text: input.text },
    position: input.position,
    triggerKind: input.triggerKind,
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.maxCostClass === undefined ? {} : { maxCostClass: input.maxCostClass }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  };
  return fetchJson("/api/editor/inline-completion", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1200 — content-free inline-completion acceptance/rejection telemetry. Best-effort, fire and
// forget: the editor reports cumulative counts (no code content) which the BFF records as evidence.
export interface EditorInlineCompletionTelemetryInput {
  readonly root: string;
  readonly offered: number;
  readonly shown: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly ignored: number;
  readonly partiallyAccepted: number;
  readonly requestCount: number;
  readonly requestLatencyMsP50: number;
  readonly requestLatencyMsP95: number;
}

export async function reportEditorInlineCompletionTelemetry(
  input: EditorInlineCompletionTelemetryInput,
): Promise<void> {
  const report: EditorInlineCompletionTelemetryReport = {
    schemaVersion: EDITOR_INLINE_COMPLETION_TELEMETRY_SCHEMA_VERSION,
    root: input.root,
    offered: input.offered,
    shown: input.shown,
    accepted: input.accepted,
    rejected: input.rejected,
    ignored: input.ignored,
    partiallyAccepted: input.partiallyAccepted,
    requestCount: input.requestCount,
    requestLatencyMsP50: input.requestLatencyMsP50,
    requestLatencyMsP95: input.requestLatencyMsP95,
  };
  await fetchJson("/api/editor/inline-completion/telemetry", {
    method: "POST",
    body: JSON.stringify(report),
  });
}

// Issue #1202 — governed editor-driven test generation (ADR-0042 D7). Posts the editor target (the
// overlay buffer + scope coordinates) to the wave-2 BFF, which returns a `disabled`/`deferred` outcome
// in v1 (no candidate; the feature ships switched off) or, once an enforced egress boundary unlocks it,
// a reviewable candidate patch. The browser never reaches a model directly. `signal` cancels a run.
export interface EditorTestGenerationRequestInput {
  readonly root: string;
  readonly target: EditorTestGenerationWireTarget;
  readonly contextBudgetBytes: number;
  readonly context?: EditorCompletionContextSelectors | undefined;
}

export async function requestEditorTestGeneration(
  input: EditorTestGenerationRequestInput,
  signal?: AbortSignal,
): Promise<EditorTestGenerationWireResponse> {
  const requestBody: EditorTestGenerationWireRequest = {
    schemaVersion: EDITOR_TEST_GENERATION_SCHEMA_VERSION,
    root: input.root,
    target: input.target,
    contextBudgetBytes: input.contextBudgetBytes,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
  return fetchJson("/api/editor/test-generation", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1204 — governed editor-driven patch apply + post-apply verification. Applies (or rejects) a
// reviewed candidate patch only on an explicit user decision; the BFF validates scope/conflict/overwrite,
// applies atomically, then re-confirms the applied test under an enforced egress boundary. The browser
// never writes files or runs tests directly; the response is content-free apart from a guarded revert
// diff. `signal` lets the editor cancel a superseded request.
export interface EditorPatchApplyRequestInput {
  readonly root: string;
  readonly patchId: string;
  readonly decision: EditorPatchApplyDecision;
  readonly diff: string;
  readonly allowOverwrite?: boolean | undefined;
}

export async function requestEditorPatchApply(
  input: EditorPatchApplyRequestInput,
  signal?: AbortSignal,
): Promise<EditorPatchApplyWireResponse> {
  const requestBody: EditorPatchApplyWireRequest = {
    schemaVersion: EDITOR_PATCH_APPLY_SCHEMA_VERSION,
    root: input.root,
    patchId: input.patchId,
    decision: input.decision,
    diff: input.diff,
    ...(input.allowOverwrite === undefined ? {} : { allowOverwrite: input.allowOverwrite }),
  };
  return fetchJson("/api/editor/patch-apply", {
    method: "POST",
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  });
}

// Issue #1201 — deterministic language intelligence (diagnostics, hover, document symbols,
// formatting). All four reuse the governed `POST /api/editor/language` route (#1198): a single
// model-free, workspace-contained, bounded analysis over the in-editor overlay. The browser never
// reaches a model. `signal` lets the editor cancel a superseded or in-flight request.
export interface EditorLanguageRequestInput {
  readonly root: string;
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
}

interface LanguageOperationEnvelope<TResult> {
  readonly operation: string;
  readonly result: TResult;
}

function languageDocument(input: EditorLanguageRequestInput): {
  readonly path: string;
  readonly languageId: string;
  readonly text: string;
} {
  return { path: input.path, languageId: input.languageId, text: input.text };
}

export async function fetchEditorLanguageCapabilities(
  root?: string | undefined,
): Promise<LanguageServiceCapabilities> {
  const query = root === undefined || root.length === 0 ? "" : `?root=${encodeURIComponent(root)}`;
  return fetchJson(`/api/editor/language/capabilities${query}`);
}

export async function requestEditorDiagnostics(
  input: EditorLanguageRequestInput,
  signal?: AbortSignal,
): Promise<LanguageDiagnosticsResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageDiagnosticsResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "diagnostics",
        root: input.root,
        document: languageDocument(input),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorHover(
  input: EditorLanguageRequestInput & {
    readonly position: { readonly line: number; readonly character: number };
  },
  signal?: AbortSignal,
): Promise<LanguageHoverResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageHoverResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "hover",
        root: input.root,
        document: languageDocument(input),
        position: input.position,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorSymbols(
  input: EditorLanguageRequestInput,
  signal?: AbortSignal,
): Promise<LanguageSymbolResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageSymbolResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "symbols",
        root: input.root,
        document: languageDocument(input),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function requestEditorFormatting(
  input: EditorLanguageRequestInput & { readonly options?: LanguageFormattingOptions | undefined },
  signal?: AbortSignal,
): Promise<LanguageFormattingResult> {
  const envelope = await fetchJson<LanguageOperationEnvelope<LanguageFormattingResult>>(
    "/api/editor/language",
    {
      method: "POST",
      body: JSON.stringify({
        operation: "formatting",
        root: input.root,
        document: languageDocument(input),
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return envelope.result;
}

export async function fetchEditorAgentSessions(): Promise<EditorAgentSessionsResponse> {
  return fetchJson("/api/editor/agent/sessions");
}

export async function requestEditorAgentSnapshot(
  input: EditorAgentSnapshotRequest,
): Promise<EditorAgentSnapshotResponse> {
  return fetchJson("/api/editor/agent/snapshot", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function postEditorAgentSessionSnapshot(
  snapshot: EditorAgentSessionSnapshot,
): Promise<EditorAgentSnapshotResponse> {
  return fetchJson("/api/editor/agent/snapshot", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      kind: "snapshot",
      snapshot,
    }),
  });
}

export async function queueEditorAgentAction(
  action: EditorAgentAction,
): Promise<EditorAgentActionQueuedResponse> {
  return fetchJson("/api/editor/agent/actions", {
    method: "POST",
    body: JSON.stringify(action),
  });
}

export async function postEditorAgentActionResult(
  result: EditorAgentActionResultRequest,
): Promise<EditorAgentActionQueuedResponse> {
  return fetchJson("/api/editor/agent/actions", {
    method: "POST",
    body: JSON.stringify(result),
  });
}

// Issue #1395 (ADR-0062) — read the bounded audit feed of recent agent editor actions for a session.
// Content-free records only (no raw source, no secrets); used by the recent-actions governance panel.
export async function fetchEditorAgentAudit(sessionId: string): Promise<EditorAgentAuditResponse> {
  return fetchJson(`/api/editor/agent/audit?sessionId=${encodeURIComponent(sessionId)}`);
}

// ---------------------------------------------------------------------------
// Issue #185 — Grounded repository Q&A
// ---------------------------------------------------------------------------
// POSTs to the BFF orchestrator which composes the #179-#183 connected-context layers,
// persists the chat round-trip as a normal user/assistant message pair, and returns the
// redacted citation projection. The CSRF header is supplied by `fetchJson` for all non-GET
// methods; the caller never sets it directly.

export async function askGrounded(
  req: GroundedAskRequest,
  signal?: AbortSignal,
): Promise<GroundedAnswer> {
  // RequestInit.signal is `AbortSignal | null`. Under exactOptionalPropertyTypes we cannot
  // pass `undefined`, so convert here.
  return fetchJson("/api/chats/messages/grounded", {
    method: "POST",
    body: JSON.stringify(req),
    signal: signal ?? null,
  });
}

// ---------------------------------------------------------------------------
// PDF citation preview
// ---------------------------------------------------------------------------

export async function fetchPdfCitationPreviewStatus(
  input: PdfCitationPreviewStatusRequest,
): Promise<PdfCitationPreviewStatusResponse> {
  return fetchJson("/api/local-knowledge/citation-preview/status", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function openPdfCitationPreviewSession(
  input: PdfCitationPreviewSelection,
): Promise<PdfCitationPreviewOpenResponse> {
  return fetchJson("/api/local-knowledge/citation-preview/open", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function closePdfCitationPreviewSession(
  sessionHandle: string,
  expectedExpiresAt?: string,
): Promise<{ ok: true }> {
  return fetchJson(
    `/api/local-knowledge/citation-preview/sessions/${encodeURIComponent(sessionHandle)}`,
    {
      method: "DELETE",
      body: JSON.stringify(expectedExpiresAt === undefined ? {} : { expectedExpiresAt }),
    },
  );
}

export function pdfCitationPreviewDocumentUrl(sessionHandle: string): string {
  return `/api/local-knowledge/citation-preview/sessions/${encodeURIComponent(sessionHandle)}/document`;
}

export async function fetchPdfCitationPreviewDocument(
  sessionHandle: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return fetchBinary(
    pdfCitationPreviewDocumentUrl(sessionHandle),
    signal === undefined ? undefined : { signal },
  );
}

// ---------------------------------------------------------------------------
// Issue #473 (Epic #470) — governed Git delivery action sheet
// ---------------------------------------------------------------------------
// POSTs the content-free repository facts a caller legitimately holds — the proposed resolved action,
// the worktree snapshot, optional provider PR/merge/branch-protection/checks state, and the active
// provider capabilities — to the BFF, which establishes policy/approval
// AUTHORITY server-side and assembles the UI-safe GitDeliveryActionSheet projection. The request
// carries NO authority fields (policy decision, providerReady, expected blockers); the server rejects
// any such key. The response carries counts/flags/names/typed codes only — never diff content, file
// paths, secrets, or command strings. The CSRF header is added by `fetchJson` for the POST.

export async function fetchGitDeliveryActionSheet(
  request: GitDeliveryActionSheetRequest,
  signal?: AbortSignal,
): Promise<GitDeliveryActionSheet> {
  return fetchJson("/api/git-delivery/action-sheet", {
    method: "POST",
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ---------------------------------------------------------------------------
// Issue #475 (Epic #470) — governed local Git flows (branch / staging / commit)
// ---------------------------------------------------------------------------
// Six POST routes that drive the governed local-mutation kernel server-side. Each request body carries
// `{ schemaVersion: "1", projectId, ... }` where `projectId` is the workspace root path. The CSRF header
// is added by `fetchJson` for the POST. Requests and responses are content-free: counts, structural area
// tokens, branch names, and typed warning / violation / finding codes only — never diff content, raw
// paths, secrets, or the commit-message body. Mutation responses report a `status`; a message-policy
// block returns `{ status: "blocked", blockReason: "message-policy", messageViolations }`.

export type GitDeliveryMutationStatus =
  "succeeded" | "blocked" | "approval-required" | "failed" | "recovery-required";

// Shared mutation response shape for branch + staging + commit execution. Optional fields appear only
// for the matching outcome (block reason, preflight codes, required approvers, execution error code).
export interface GitDeliveryMutationResponse {
  readonly schemaVersion: "1";
  readonly status: GitDeliveryMutationStatus;
  readonly actionKind: string;
  readonly phaseReached?: string;
  readonly policyOutcome?: string;
  readonly blockReason?: string;
  readonly preflightFindingCodes?: readonly string[];
  readonly requiredApprovers?: readonly string[];
  readonly executionErrorCode?: string;
  readonly messageViolations?: readonly GitCommitMessageViolationCode[];
}

export interface GitDeliveryLocalBranchCreateInput {
  readonly projectId: string;
  readonly branchName: string;
  readonly baseBranchName: string;
  readonly startPointRefHash: string;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export async function fetchGitDeliveryLocalBranchCreate(
  input: GitDeliveryLocalBranchCreateInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMutationResponse> {
  return fetchJson("/api/git-delivery/local-branch/create", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      branchName: input.branchName,
      baseBranchName: input.baseBranchName,
      startPointRefHash: input.startPointRefHash,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface GitDeliveryLocalBranchSwitchInput {
  readonly projectId: string;
  readonly branchName: string;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export async function fetchGitDeliveryLocalBranchSwitch(
  input: GitDeliveryLocalBranchSwitchInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMutationResponse> {
  return fetchJson("/api/git-delivery/local-branch/switch", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      branchName: input.branchName,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface GitDeliveryStageInput {
  readonly projectId: string;
  readonly pathspecs: readonly string[];
  readonly includeUntracked: boolean;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export async function fetchGitDeliveryStage(
  input: GitDeliveryStageInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMutationResponse> {
  return fetchJson("/api/git-delivery/staging/stage", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      pathspecs: input.pathspecs,
      includeUntracked: input.includeUntracked,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface GitDeliveryUnstageInput {
  readonly projectId: string;
  readonly pathspecs: readonly string[];
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export async function fetchGitDeliveryUnstage(
  input: GitDeliveryUnstageInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMutationResponse> {
  return fetchJson("/api/git-delivery/staging/unstage", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      pathspecs: input.pathspecs,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface GitDeliveryCommitPreviewResponse {
  readonly schemaVersion: "1";
  readonly summary: GitCommitChangeSummary;
  readonly intent: GitCommitIntentAnalysis;
  readonly messageValidation: GitCommitMessageValidation;
  readonly preflightFindingCodes: readonly string[];
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
}

export async function fetchGitDeliveryCommitPreview(
  input: { readonly projectId: string; readonly messageDraft?: string | undefined },
  signal?: AbortSignal,
): Promise<GitDeliveryCommitPreviewResponse> {
  return fetchJson("/api/git-delivery/commit/preview", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      ...(input.messageDraft === undefined ? {} : { messageDraft: input.messageDraft }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface GitDeliveryCommitExecuteInput {
  readonly projectId: string;
  readonly message: string;
  readonly allowEmpty?: boolean | undefined;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export async function fetchGitDeliveryCommitExecute(
  input: GitDeliveryCommitExecuteInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMutationResponse> {
  return fetchJson("/api/git-delivery/commit/execute", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1",
      projectId: input.projectId,
      message: input.message,
      ...(input.allowEmpty === undefined ? {} : { allowEmpty: input.allowEmpty }),
      ...(input.approval === undefined ? {} : { approval: input.approval }),
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ─── Governed remote publish (Issue #476, Epic #470) ────────────────────────────────────────────

export interface GitDeliveryPushInput {
  readonly projectId: string;
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  readonly sourceBranchName: string;
  readonly forcePush?: boolean | undefined;
  readonly setUpstreamTracking?: boolean | undefined;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export interface GitDeliveryPushPreviewResponse {
  readonly schemaVersion: "1";
  readonly remoteAlias: string;
  readonly remoteBranchName: string;
  readonly sourceBranchName: string;
  readonly riskClass: string;
  readonly wouldCreateRemoteBranch: boolean;
  readonly wouldTriggerChecks: boolean;
  readonly forceBlocked: boolean;
  readonly preflightBlockingCodes: readonly string[];
  readonly preflightAdvisoryCodes: readonly string[];
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
}

export interface GitDeliveryPushExecuteResponse extends GitDeliveryMutationResponse {
  readonly publishRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
}

function gitDeliveryPushBody(input: GitDeliveryPushInput): string {
  return JSON.stringify({
    schemaVersion: "1",
    projectId: input.projectId,
    remoteAlias: input.remoteAlias,
    remoteBranchName: input.remoteBranchName,
    sourceBranchName: input.sourceBranchName,
    ...(input.forcePush === undefined ? {} : { forcePush: input.forcePush }),
    ...(input.setUpstreamTracking === undefined
      ? {}
      : { setUpstreamTracking: input.setUpstreamTracking }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
}

export async function fetchGitDeliveryPushPreview(
  input: GitDeliveryPushInput,
  signal?: AbortSignal,
): Promise<GitDeliveryPushPreviewResponse> {
  return fetchJson("/api/git-delivery/push/preview", {
    method: "POST",
    body: gitDeliveryPushBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function fetchGitDeliveryPushExecute(
  input: GitDeliveryPushInput,
  signal?: AbortSignal,
): Promise<GitDeliveryPushExecuteResponse> {
  return fetchJson("/api/git-delivery/push/execute", {
    method: "POST",
    body: gitDeliveryPushBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ─── Fetch / pull sync (Issue #1573 API, consumed by Issue #1576 UI) ─────────────────────────

export interface GitDeliverySyncInput {
  readonly operation: GitSyncOperation;
  readonly projectId: string;
  readonly remote?: string | undefined;
}

function gitDeliverySyncBody(input: GitDeliverySyncInput): string {
  return JSON.stringify({
    schemaVersion: "1",
    projectId: input.projectId,
    ...(input.remote === undefined ? {} : { remote: input.remote }),
  });
}

function gitDeliverySyncPath(operation: GitSyncOperation, phase: "preview" | "execute"): string {
  return `/api/git-delivery/${operation}/${phase}`;
}

export async function fetchGitDeliverySyncPreview(
  input: GitDeliverySyncInput,
  signal?: AbortSignal,
): Promise<GitSyncPreview> {
  return fetchJson(
    gitDeliverySyncPath(input.operation, "preview"),
    {
      method: "POST",
      body: gitDeliverySyncBody(input),
      ...(signal === undefined ? {} : { signal }),
    },
    validateGitSyncPreview,
  );
}

export async function fetchGitDeliverySyncExecute(
  input: GitDeliverySyncInput,
  signal?: AbortSignal,
): Promise<GitSyncExecuteResponse> {
  return fetchJson(
    gitDeliverySyncPath(input.operation, "execute"),
    {
      method: "POST",
      body: gitDeliverySyncBody(input),
      ...(signal === undefined ? {} : { signal }),
    },
    validateGitSyncExecuteResponse,
  );
}

// ─── Governed GitHub pull request command center (#477, ADR-0064) ────────────────────────────────────

export type GitDeliveryPrKind = "pr-create" | "pr-update";

// The PR command-center input. Title/body are user content flowing to the provider; only their byte
// lengths reach the evidence ledger server-side.
export interface GitDeliveryPrInput {
  readonly projectId: string;
  readonly kind: GitDeliveryPrKind;
  readonly ownerAndRepo: string;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly title: string;
  readonly body: string;
  readonly isDraft?: boolean | undefined;
  readonly prExternalId?: string | undefined;
  readonly convertToDraft?: boolean | undefined;
  readonly convertFromDraft?: boolean | undefined;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

export interface GitDeliveryPrReadiness {
  readonly objectExists: boolean;
  readonly reviewReady: boolean;
  readonly blockerCodes: readonly string[];
}

export interface GitDeliveryPrPreviewResponse {
  readonly schemaVersion: "1";
  readonly actionKind: GitDeliveryPrKind;
  readonly headBranchName: string;
  readonly baseBranchName: string;
  readonly riskClass: string;
  readonly riskSeverity: number;
  readonly isDraft: boolean;
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
  readonly composedTitle: string;
  readonly composedBody: string;
  readonly riskNarrative: string;
  readonly recommendation: string;
  readonly readiness: GitDeliveryPrReadiness;
  readonly suggestedLabels: readonly string[];
  readonly suggestedIssueRefs: readonly string[];
  readonly titleByteLength: number;
  readonly bodyByteLength: number;
}

export interface GitDeliveryPrExecuteResponse extends GitDeliveryMutationResponse {
  readonly prRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
  readonly createdPrExternalId?: string;
}

function gitDeliveryPrBody(input: GitDeliveryPrInput): string {
  return JSON.stringify({
    schemaVersion: "1",
    projectId: input.projectId,
    kind: input.kind,
    ownerAndRepo: input.ownerAndRepo,
    headBranchName: input.headBranchName,
    baseBranchName: input.baseBranchName,
    title: input.title,
    body: input.body,
    ...(input.isDraft === undefined ? {} : { isDraft: input.isDraft }),
    ...(input.prExternalId === undefined ? {} : { prExternalId: input.prExternalId }),
    ...(input.convertToDraft === undefined ? {} : { convertToDraft: input.convertToDraft }),
    ...(input.convertFromDraft === undefined ? {} : { convertFromDraft: input.convertFromDraft }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
}

export async function fetchGitDeliveryPrPreview(
  input: GitDeliveryPrInput,
  signal?: AbortSignal,
): Promise<GitDeliveryPrPreviewResponse> {
  return fetchJson("/api/git-delivery/pr/preview", {
    method: "POST",
    body: gitDeliveryPrBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function fetchGitDeliveryPrExecute(
  input: GitDeliveryPrInput,
  signal?: AbortSignal,
): Promise<GitDeliveryPrExecuteResponse> {
  return fetchJson("/api/git-delivery/pr/execute", {
    method: "POST",
    body: gitDeliveryPrBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

// ─── Governed merge command center (#478, ADR-0087) ──────────────────────────────────────────────────

export type GitDeliveryMergeStrategy = "squash" | "rebase" | "merge-commit" | "provider-default";

// The governed merge input. Only the content-free merge facts (PR number, strategy, delete flag) reach
// the evidence ledger server-side; no diff content ever leaves the provider boundary.
export interface GitDeliveryMergeInput {
  readonly projectId: string;
  readonly ownerAndRepo: string;
  readonly prExternalId: string;
  readonly baseBranchName: string;
  readonly headBranchName: string;
  readonly mergeStrategy: GitDeliveryMergeStrategy;
  readonly deleteBranchAfterMerge: boolean;
  readonly expectedHeadRefHash?: string | undefined;
  readonly approval?: GitDeliveryApprovalClaim | undefined;
}

// A per-blocker readiness view carrying the precise code AND its recovery information (remediation class
// and a recovery action hint where one applies), so the UI can render recovery guidance for pre-merge
// readiness blocks — not only for provider-time rejections (AC3).
export interface GitDeliveryMergeBlocker {
  readonly code: string;
  readonly severity: string;
  readonly remediation: string;
  readonly actionHint?: string;
}

export interface GitDeliveryMergeReadiness {
  readonly mergeable: boolean;
  readonly blockers: readonly GitDeliveryMergeBlocker[];
}

export interface GitDeliveryMergePreviewResponse {
  readonly schemaVersion: "1";
  readonly actionKind: "merge";
  readonly baseBranchName: string;
  readonly headBranchName: string;
  readonly prExternalId: string;
  readonly riskClass: string;
  readonly riskSeverity: number;
  readonly requestedStrategy: GitDeliveryMergeStrategy;
  // The strategies the user may choose from (policy ∩ provider capability) — the UI must NOT hard-code a
  // default; it defaults the selection to selectedDefaultStrategy (AC2).
  readonly eligibleStrategies: readonly GitDeliveryMergeStrategy[];
  readonly selectedDefaultStrategy?: GitDeliveryMergeStrategy;
  readonly requestedStrategyEligible: boolean;
  readonly policyOutcome: string;
  readonly policyBlockReason?: string;
  readonly requiresApproval: boolean;
  readonly readiness: GitDeliveryMergeReadiness;
  readonly recommendation: string;
}

export interface GitDeliveryMergeExecuteResponse extends GitDeliveryMutationResponse {
  readonly mergeRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
  readonly mergeable?: boolean;
  readonly readinessBlockers?: readonly GitDeliveryMergeBlocker[];
  readonly merged?: boolean;
  readonly branchDeleted?: boolean;
}

function gitDeliveryMergeBody(input: GitDeliveryMergeInput): string {
  return JSON.stringify({
    schemaVersion: "1",
    projectId: input.projectId,
    kind: "merge",
    ownerAndRepo: input.ownerAndRepo,
    prExternalId: input.prExternalId,
    baseBranchName: input.baseBranchName,
    headBranchName: input.headBranchName,
    mergeStrategy: input.mergeStrategy,
    deleteBranchAfterMerge: input.deleteBranchAfterMerge,
    ...(input.expectedHeadRefHash === undefined
      ? {}
      : { expectedHeadRefHash: input.expectedHeadRefHash }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
}

export async function fetchGitDeliveryMergePreview(
  input: GitDeliveryMergeInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMergePreviewResponse> {
  return fetchJson("/api/git-delivery/merge/preview", {
    method: "POST",
    body: gitDeliveryMergeBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function fetchGitDeliveryMergeExecute(
  input: GitDeliveryMergeInput,
  signal?: AbortSignal,
): Promise<GitDeliveryMergeExecuteResponse> {
  return fetchJson("/api/git-delivery/merge/execute", {
    method: "POST",
    body: gitDeliveryMergeBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}
