// Wire-safe entity types for the BFF (Back-For-Frontend) layer (ADR-0013 D4). These types
// travel over the HTTP wire between the BFF and the React UI. The DI port interfaces
// (UiStore, UiStoreFactoryOptions) remain in src/ui/store/types.ts to avoid a contracts→ui
// circular dependency.

// Reused on RunReport.verificationSummary — verification-summary.ts is the canonical home for
// the post-#7 audit projection used by both the audit ledger and this wire shape.
import type { VerificationAuditSummary } from "./verification-summary.js";
// ModelCapability is the credential-free capability registry shape; SafeGatewayConfig surfaces
// the optional capabilities table to the UI without crossing into the credential-bearing
// GatewayConfig in gateway.ts.
import type { ModelCapability } from "./gateway.js";
// GroundedAnswerContextPackSummary projects the connected-context pack into a counts-only,
// browser-safe shape (Issue #187 / ADR-0022). The connected-context module is a pure-data
// peer; importing it does not pull in any IO or redaction code.
import {
  CANDIDATE_OMISSION_REASONS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type ExplorationBudget,
  type ExplorationUsage,
  type RetrievalQueryKind,
  type SelectedScopeKind,
} from "./connected-context.js";
import type { CapsuleSetId, KnowledgeCapsuleId } from "./local-knowledge.js";
import type { ExpectedCheck, WorkflowKind } from "./workflow-handoff.js";

export interface Project {
  readonly path: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

// Issue #184 — the workspace-relative scope binding a Files window selection to a chat. `kind`
// mirrors SelectedScope so the binding can represent the repository root, one folder, or one or
// more file paths. The patch shape distinguishes "no change" (field absent) from "clear" (field
// set to null) using the standard JSON-patch convention; the stored entity surface carries
// `undefined` when no scope is bound. Path validation happens at the BFF boundary via
// isValidScopePath from @oscharko-dev/keiko-contracts/connected-context; this shape carries
// already-validated paths.
export interface ChatConnectedScope {
  readonly kind: SelectedScopeKind;
  readonly relativePaths: readonly string[];
  readonly connectedAtMs: number;
  // Epic #177/#532 — absolute root of the connected folder. Keiko is a workspace for everyone, not
  // only developers: a user keeps a single Keiko project but connects folders from ANYWHERE on the
  // machine (outside that project root) to the chat. When present, the grounded path resolves
  // `relativePaths` against THIS root instead of the chat's projectPath. Absent (legacy chats) →
  // the chat's projectPath is used. Always an already-validated, deny-list-cleared absolute path.
  readonly root?: string;
}

// ─── Grounding limits (operator-configurable fan-out caps) ───────────────────────
// Shape for all grounded Q&A fan-out limits. An operator may tune these via the gateway config
// `grounding` block; absent → DEFAULT_GROUNDING_LIMITS are used (behaviour identical to before).
// Every value must be a positive integer; over-ceiling values are clamped by resolveGroundingLimits.

export interface GroundingLimits {
  readonly maxConnectedSources: number; // folder sources per chat (was MAX_CONNECTED_SOURCES)
  readonly maxLocalKnowledgeSources: number; // connector sources per chat (was MAX_LOCAL_KNOWLEDGE_SOURCES)
  readonly maxPromptReferences: number; // connector refs retrieved/surfaced per connector (was MAX_PROMPT_REFERENCES)
  readonly maxExcerptChars: number; // per connector excerpt cap (was MAX_EXCERPT_CHARS)
  readonly referenceBudget: number; // connector reference budget (was DEFAULT_REFERENCE_BUDGET)
  readonly hybridMaxCandidates: number; // NEW: shared global top-K for the hybrid rerank
  readonly hybridMaxExcerptBytes: number; // NEW: shared excerpt-byte budget for the hybrid rerank
}

export const DEFAULT_GROUNDING_LIMITS: GroundingLimits = {
  maxConnectedSources: 16,
  maxLocalKnowledgeSources: 16,
  maxPromptReferences: 8,
  maxExcerptChars: 900,
  referenceBudget: 10,
  hybridMaxCandidates: 24,
  hybridMaxExcerptBytes: 131_072,
} as const;

// Hard safety ceilings: an operator config may TUNE a limit but never raise it past these
// (preserves the original DoS-bounding intent of the fan-out caps).
export const GROUNDING_LIMIT_CEILINGS: GroundingLimits = {
  maxConnectedSources: 64,
  maxLocalKnowledgeSources: 64,
  maxPromptReferences: 64,
  maxExcerptChars: 20_000,
  referenceBudget: 256,
  hybridMaxCandidates: 256,
  hybridMaxExcerptBytes: 524_288,
} as const;

// Pure resolver: fill each field from `partial` when it is a positive integer, else the default;
// then clamp to the ceiling. Invalid (non-positive / non-integer) present fields fall back to the
// default here (the gateway parse layer is responsible for REJECTING malformed config explicitly).
export function resolveGroundingLimits(partial?: Partial<GroundingLimits>): GroundingLimits {
  const pick = (key: keyof GroundingLimits): number => {
    const supplied = partial?.[key];
    const resolved =
      supplied !== undefined && Number.isInteger(supplied) && supplied >= 1
        ? supplied
        : DEFAULT_GROUNDING_LIMITS[key];
    return Math.min(resolved, GROUNDING_LIMIT_CEILINGS[key]);
  };
  return {
    maxConnectedSources: pick("maxConnectedSources"),
    maxLocalKnowledgeSources: pick("maxLocalKnowledgeSources"),
    maxPromptReferences: pick("maxPromptReferences"),
    maxExcerptChars: pick("maxExcerptChars"),
    referenceBudget: pick("referenceBudget"),
    hybridMaxCandidates: pick("hybridMaxCandidates"),
    hybridMaxExcerptBytes: pick("hybridMaxExcerptBytes"),
  };
}

// Epic #532 — a sane cap on the number of folders/files one chat may connect at once. The BFF
// rejects PATCHes whose connectedScopes list exceeds this; the store enforces the same as a
// defense-in-depth subset. Bounds retrieval fan-out cost (each source runs an independent,
// budget-split retrieval pass), so total work stays bounded regardless of N.
// Kept for back-compat; new code should read from a resolved GroundingLimits instance instead.
export const MAX_CONNECTED_SOURCES = DEFAULT_GROUNDING_LIMITS.maxConnectedSources;

// Epic #189 — sibling of MAX_CONNECTED_SOURCES for the local-knowledge (connector) source list. A
// chat may bind multiple capsules/capsule-sets at once; the BFF rejects PATCHes whose
// localKnowledgeScopes list exceeds this, and the store enforces the same as a defense-in-depth
// subset. Bounds the connector fan-out cost in the hybrid grounded path (Slice 2).
// Kept for back-compat; new code should read from a resolved GroundingLimits instance instead.
export const MAX_LOCAL_KNOWLEDGE_SOURCES = DEFAULT_GROUNDING_LIMITS.maxLocalKnowledgeSources;

export type ChatLocalKnowledgeScope =
  | {
      readonly kind: "capsule";
      readonly capsuleId: KnowledgeCapsuleId;
      readonly connectedAtMs: number;
    }
  | {
      readonly kind: "capsule-set";
      readonly capsuleSetId: CapsuleSetId;
      readonly connectedAtMs: number;
    };

export interface Chat {
  readonly id: string;
  readonly projectPath: string;
  readonly title: string;
  readonly selectedModel: string;
  readonly branchLabel: string | undefined;
  readonly status: "open" | "closed" | undefined;
  // Epic #532 — `connectedScopes` is the canonical list of connected sources (a chat may ground
  // against multiple folders/files at once). `connectedScope` is retained for backward-compat
  // (legacy single-source readers and rows). `connectedScopes` SUPERSEDES `connectedScope`:
  // readers should derive the effective list as
  //   `chat.connectedScopes ?? (chat.connectedScope ? [chat.connectedScope] : [])`.
  // When both are present, `connectedScope` equals `connectedScopes[0]`.
  readonly connectedScopes?: readonly ChatConnectedScope[];
  readonly connectedScope: ChatConnectedScope | undefined;
  // Epic #189 — `localKnowledgeScopes` is the canonical list of connector sources (a chat may
  // ground against multiple capsules/capsule-sets at once). `localKnowledgeScope` is retained for
  // backward-compat (legacy single-source readers and rows). `localKnowledgeScopes` SUPERSEDES
  // `localKnowledgeScope`: readers should derive the effective list as
  //   `chat.localKnowledgeScopes ?? (chat.localKnowledgeScope ? [chat.localKnowledgeScope] : [])`.
  // When both are present, `localKnowledgeScope` equals `localKnowledgeScopes[0]`.
  readonly localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[];
  readonly localKnowledgeScope: ChatLocalKnowledgeScope | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ChatRole = "user" | "assistant" | "system";
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface ChatMessage {
  readonly id: string;
  readonly chatId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly workflowStatus: WorkflowStatus | undefined;
  readonly shortResult: string | undefined;
  readonly taskType: string | undefined;
}

export interface CreateChatOptions {
  readonly branchLabel?: string;
}

export interface UpdateProjectPatch {
  readonly name?: string;
  readonly favorite?: boolean;
}

// Issue #184 — `connectedScope: null` explicitly clears the binding; `undefined` (field absent)
// leaves it untouched. The BFF PATCH handler is responsible for validating each scopePath via
// isValidScopePath; this shape carries the post-validation values across the wire.
export interface UpdateChatPatch {
  readonly title?: string;
  readonly selectedModel?: string;
  readonly branchLabel?: string;
  readonly status?: "open" | "closed";
  // Epic #532 — set `connectedScopes` to bind a list of sources (null clears ALL). Back-compat:
  // `connectedScope` is still accepted and is treated as a 1-element list. When a caller supplies
  // both, `connectedScopes` wins. As with the single field, `undefined` (absent) leaves the
  // binding untouched while `null` explicitly clears it.
  readonly connectedScopes?: readonly ChatConnectedScope[] | null;
  readonly connectedScope?: ChatConnectedScope | null;
  // Epic #189 — set `localKnowledgeScopes` to bind a list of connector sources (null clears ALL).
  // Back-compat: `localKnowledgeScope` is still accepted and is treated as a 1-element list. When a
  // caller supplies both, `localKnowledgeScopes` wins. As with the single field, `undefined`
  // (absent) leaves the binding untouched while `null` explicitly clears it.
  readonly localKnowledgeScopes?: readonly ChatLocalKnowledgeScope[] | null;
  readonly localKnowledgeScope?: ChatLocalKnowledgeScope | null;
}

export interface NewChatMessage {
  readonly chatId: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly timestamp: number;
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly workflowStatus: WorkflowStatus | undefined;
  readonly shortResult: string | undefined;
  readonly taskType: string | undefined;
}

// Issue #66 — partial PATCH for a run-summary system message. Every field is independently
// optional; an empty patch is an error (the route returns INVALID_REQUEST). The store re-runs
// the same redact-then-truncate pipeline as createMessage when shortResult is present.
export interface UpdateChatMessagePatch {
  readonly workflowStatus?: WorkflowStatus;
  readonly shortResult?: string;
  readonly taskType?: string;
}

// ─── Project availability projection (BFF /api/projects) ──────────────────────────
// availability is DERIVED at read time by the server (issue #62 ADR-0013); the wire
// shape carries it as a plain boolean.

export interface ProjectWithAvailability extends Project {
  readonly available: boolean;
}

// ─── Chat status (BFF wire — mirror of UiStore Chat["status"]) ───────────────────

export type ChatStatus = "open" | "closed";
export type ChatMessageRole = ChatRole;
// Chat-side workflow status (issue #66). `cancelled` matches src/ui/runs.ts RunStatus so the
// chat can faithfully record a terminal cancellation.
export type ChatWorkflowStatus = WorkflowStatus;

// PATCH body for /api/chats/messages?id=... (issue #66)
export interface PatchChatMessageBody {
  readonly workflowStatus?: ChatWorkflowStatus;
  readonly shortResult?: string;
  readonly taskType?: string;
}

export interface PatchMessageResponse {
  readonly message: ChatMessage;
}

export interface ProjectsResponse {
  readonly projects: readonly ProjectWithAvailability[];
}

export interface ProjectResponse {
  readonly project: ProjectWithAvailability;
}

export interface ChatsResponse {
  readonly chats: readonly Chat[];
}

export interface ChatResponse {
  readonly chat: Chat;
}

export interface MessagesResponse {
  readonly messages: readonly ChatMessage[];
}

export interface MessageResponse {
  readonly message: ChatMessage;
}

export interface GroundedWorkflowHandoffRequest {
  readonly assistantMessageId: string;
  readonly chatId: string;
  readonly modelId: string;
  readonly workflowKind: WorkflowKind;
  readonly input: Record<string, unknown>;
  readonly editablePaths: readonly string[];
  readonly expectedChecks?: readonly ExpectedCheck[] | undefined;
  readonly unknowns?: readonly string[] | undefined;
  readonly requestedAtMs: number;
}

export interface GroundedWorkflowHandoffResponse {
  readonly run: { readonly runId: string; readonly fingerprint: string };
  readonly messages: readonly ChatMessage[];
}

// ─── Desktop chat bootstrap (BFF /api/desktop/chat/bootstrap) ─────────────────────

export interface DesktopChatBootstrapResponse {
  readonly project: ProjectWithAvailability;
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly projects: readonly ProjectWithAvailability[];
  readonly chats: readonly Chat[];
}

// Usage metadata sent on the desktop chat send response (mirror of gateway UsageMetadata's
// stable subset — the BFF projection only keeps fields the UI consumes; kept inline here so
// callers don't need to cross into gateway.ts which carries the credential-bearing types).
export interface DesktopChatSendUsage {
  readonly requestId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

export interface ConversationMemoryScopeContextWire {
  readonly userId: string;
  readonly workspaceId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly conversationId?: string | undefined;
}

export interface ConversationMemoryRequestWire {
  readonly enabled?: boolean | undefined;
  readonly budgetTokens?: number | undefined;
  readonly context: ConversationMemoryScopeContextWire;
}

export interface ConversationMemoryContextEntryWire {
  readonly memoryId: string;
  readonly bodyExcerpt: string;
  readonly inclusionReason: string;
}

export interface ConversationMemoryContextWire {
  readonly enabled: boolean;
  readonly text: string;
  readonly memories: readonly ConversationMemoryContextEntryWire[];
  readonly budget: {
    readonly tokens: number;
    readonly used: number;
  };
}

export type ConversationMemoryActionWire =
  | {
      readonly kind: "candidate";
      readonly proposalId: string;
      readonly body: string;
      readonly scopeLabel: string;
      readonly requiresApproval: boolean;
    }
  | {
      readonly kind: "update";
      readonly memoryId: string;
      readonly bodyPatch?: string | undefined;
    }
  | {
      readonly kind: "forget";
      readonly memoryId: string;
      readonly requiresConfirmation: boolean;
    }
  | { readonly kind: "rejected"; readonly reason: string };

export interface ConversationMemoryResultWire {
  readonly context: ConversationMemoryContextWire;
  readonly actions: readonly ConversationMemoryActionWire[];
}

export interface DesktopChatSendResponse {
  readonly chat: Chat;
  readonly messages: readonly ChatMessage[];
  readonly usage?: DesktopChatSendUsage;
  readonly memory?: ConversationMemoryResultWire;
}

// Issue #148 — Safe document context extraction for conversation inputs.
// One wire entry per attached document the UI has extracted text from. The server passes the
// `text` field through into a structured prompt block — it does NOT re-extract from disk
// (the server-side modality guard is owned by issue #149). `displayName` is the file basename
// only; absolute filesystem paths NEVER cross this wire (AC #4 of issue #147).
export interface ConversationDocumentContextWire {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly extractedBytes: number;
  readonly truncated: boolean;
  readonly truncationMarker?: string | undefined;
  readonly text: string;
}

// Issue #149 — descriptor for a single image/document attachment carried on the conversation
// send path. Only kind/mime/size metadata travels here; bytes are not on this wire. The server
// validator enforces modality + mime allowlist + per-attachment size cap before any model is
// invoked.
export interface ConversationAttachmentDescriptorWire {
  readonly id: string;
  readonly kind: "image" | "document";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

// Issue #148 — wire shape for POST /api/desktop/chat. Authored here (not inside keiko-server)
// so the UI and the server share a single source of truth for the send payload. Existing
// callers that omit `documentContext` or `attachments` keep working — both fields are optional
// and additive. `attachments` was already parsed and validated by the server (PR #367 review);
// this field exposes it on the typed wire so the UI compiles against the same surface.
export interface DesktopChatSendRequestWire {
  readonly chatId: string;
  readonly projectPath: string;
  readonly content: string;
  readonly modelId?: string | undefined;
  readonly documentContext?: readonly ConversationDocumentContextWire[] | undefined;
  readonly attachments?: readonly ConversationAttachmentDescriptorWire[] | undefined;
}

// ─── Gateway safe-config projection (BFF /api/gateway/config) ─────────────────────
// Sanitised mirror of GatewayConfig with NO apiKey / NO baseUrl / NO additionalHeaders.
// Authored here (not in gateway.ts) because the credential-bearing GatewayConfig in
// gateway.ts is server-only; this wire projection is what the UI receives.

export interface SafeProviderConfig {
  readonly modelId: string;
  readonly credentialHeaderName: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface SafeCircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbes: number;
}

export interface SafeGatewayConfig {
  readonly providers: readonly SafeProviderConfig[];
  readonly circuitBreaker: SafeCircuitBreakerConfig;
  readonly capabilities?: readonly ModelCapability[];
  readonly grounding?: GroundingLimits;
}

// ─── Workflow descriptor wire shapes (BFF /api/workflows) ─────────────────────────
// The canonical WorkflowDescriptor and WorkflowInputSpec live in workflow-descriptor.ts; the BFF
// response envelope wires them up here. WorkflowInputType mirrors WorkflowInputSpec["type"] so the
// compact ExplainPlanInputSpec / VerifyInputSpec projections (which the BFF surfaces separately
// from the full descriptor list) can reuse the same literal union.

export type WorkflowInputType = "string" | "boolean" | "string[]" | "object";

// Backwards-compatible alias surfacing the canonical descriptor's modelSelectionOptions shape on
// its own so consumers can reference it independently. Structurally identical.
export interface WorkflowModelOptions {
  readonly arbitrary: boolean;
  readonly preferredCostClass: "low" | "medium" | "high";
}

export interface ExplainPlanInputSpec {
  readonly inputs: readonly {
    readonly name: string;
    readonly type: WorkflowInputType;
    readonly required: boolean;
  }[];
  readonly defaultLimits: Readonly<Record<string, unknown>>;
}

export interface VerifyInputSpec {
  readonly inputs: readonly {
    readonly name: string;
    readonly type: WorkflowInputType;
    readonly required: boolean;
  }[];
  readonly defaultLimits: Readonly<Record<string, unknown>>;
}

import type { WorkflowDescriptor } from "./workflow-descriptor.js";

export interface WorkflowsResponse {
  readonly descriptors: readonly WorkflowDescriptor[];
  readonly explainPlan: ExplainPlanInputSpec;
  readonly verify: VerifyInputSpec;
}

// ─── Agent input shapes (BFF /api/agents/* POST bodies) ───────────────────────────

export type AgentWorkflowId =
  | "verify"
  | "explain-plan"
  | "unit-test-generation"
  | "bug-investigation";

export type UnitTestTargetKind = "file" | "module" | "changedFiles";

export interface AgentVerifyInput {
  readonly targetFiles?: readonly string[];
}

export interface AgentExplainPlanInput {
  readonly filePath: string;
  readonly question?: string;
}

export interface AgentUnitTestInput {
  readonly targetKind: UnitTestTargetKind;
  readonly filePath?: string;
  readonly moduleDir?: string;
  readonly filePaths?: readonly string[];
}

export interface AgentBugInvestigationInput {
  readonly description?: string;
  readonly failingOutput?: string;
  readonly stackTrace?: string;
  readonly targetFiles?: readonly string[];
}

// ─── Grounded Q&A (BFF POST /api/chats/messages/grounded — issue #185) ───────────
// Wire shapes for the grounded repository-aware Q&A pipeline. The server composes the
// connected-context layers (#179 search, #180 structural, #181 planner, #182 ranker,
// #183 assembler) into a single response that carries both the persisted message ids
// and a redacted citation list. The citation list is the UI-safe projection of the
// underlying ConnectedContextPack — never the raw excerpts.

export interface GroundedAskRequest {
  readonly chatId: string;
  readonly content: string;
  // The browser sends the selected registry model id so grounded Q&A preserves the Conversation
  // Center model-selection guardrails instead of silently falling back to the chat's stored model.
  readonly modelId?: string | undefined;
}

export interface GroundedEvidenceCitation {
  readonly scopePath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly score: number;
  readonly stableId: string;
  // Epic #532 — a short, human-readable label of the connected source this citation came from
  // (the connected root's basename; disambiguated with a short hash when two sources share a
  // basename). Absent for legacy single-source answers, which carry no per-source attribution.
  readonly source?: string;
  // Global evidence marker in the hybrid reranked prompt ([n]); absent for non-hybrid
  // (folder-only) answers.
  readonly marker?: number;
}

export interface GroundedUncertainty {
  readonly kind: string;
  readonly claim: string;
}

// Counts-only projection of a ConnectedContextPack used to display "what was inspected" on
// every grounded answer (Issue #187 / ADR-0022). Structurally redaction-free by construction:
// no raw scope id, no scope path, no workspace root, no excerpt content, no query text. The
// sentinel `fileCount === -1` distinguishes the workspace-root scope (no enumerable file set)
// from directory/files scopes that always report `relativePaths.length` (>= 1).
export interface GroundedAnswerContextPackSummary {
  readonly schemaVersion: typeof CONNECTED_CONTEXT_SCHEMA_VERSION;
  // Deterministic display fingerprint, not the raw SelectedScope.scopeId.
  readonly scopeId: string;
  readonly scopeKind: SelectedScopeKind;
  readonly fileCount: number;
  readonly queryKind: RetrievalQueryKind;
  readonly usage: ExplorationUsage;
  readonly budget: ExplorationBudget;
  readonly citationCount: number;
  readonly omittedCount: number;
  readonly omittedCounts: Readonly<Record<CandidateOmissionReason, number>>;
  readonly uncertaintyCount: number;
  readonly elapsedMs: number;
}

export interface LocalKnowledgeGroundedAnswerContextSummary {
  readonly kind: "local-knowledge";
  readonly scopeKind: "capsule" | "capsule-set";
  readonly scopeId: string;
  readonly scopeLabel: string;
  readonly capsuleCount: number;
  readonly sourceCount: number;
  readonly citationCount: number;
  readonly referenceBudget: number;
  readonly referencesUsed: number;
}

function buildOmittedCounts(
  pack: ConnectedContextPack,
): Readonly<Record<CandidateOmissionReason, number>> {
  const counts = {} as Record<CandidateOmissionReason, number>;
  for (const reason of CANDIDATE_OMISSION_REASONS) {
    counts[reason] = 0;
  }
  for (const entry of pack.omitted) {
    counts[entry.reason] += 1;
  }
  return counts;
}

function hashString32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function displayScopeId(scopeId: string): string {
  return `scope-${hashString32(scopeId)}`;
}

// Pure builder: derives a GroundedAnswerContextPackSummary from the source pack plus the
// BFF-computed citation count and total elapsed wall time. No IO, no redaction (the only
// scope-derived string carried is a deterministic display fingerprint); allocates one fresh object.
export function buildGroundedAnswerContextPackSummary(
  pack: ConnectedContextPack,
  citationCount: number,
  elapsedMs: number,
): GroundedAnswerContextPackSummary {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: displayScopeId(pack.scope.scopeId),
    scopeKind: pack.scope.kind,
    fileCount: pack.scope.kind === "workspace-root" ? -1 : pack.scope.relativePaths.length,
    queryKind: pack.query.kind,
    usage: pack.usage,
    budget: pack.budget,
    citationCount,
    omittedCount: pack.omitted.length,
    omittedCounts: buildOmittedCounts(pack),
    uncertaintyCount: pack.uncertainty.length,
    elapsedMs,
  };
}

export interface ConnectedContextGroundedAnswer {
  readonly groundingKind: "connected-context";
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly evidenceRunId?: string | undefined;
  readonly content: string;
  readonly citations: readonly GroundedEvidenceCitation[];
  readonly uncertainty: readonly GroundedUncertainty[];
  readonly omittedCount: number;
  readonly elapsedMs: number;
  // Issue #187 AC1: every grounded answer reports which scope was inspected and how much
  // budget was spent. The summary is REQUIRED so the wire shape pins the privacy contract.
  readonly contextPack: GroundedAnswerContextPackSummary;
}

export interface LocalKnowledgeEvidenceCitation {
  readonly stableId: string;
  readonly marker: string;
  readonly label: string;
  readonly score: number;
  // Epic #189 — a short, human-readable label of the connector source this citation came from
  // (the capsule/capsule-set displayName). Absent for legacy single-connector answers, which carry
  // no per-source attribution (mirrors GroundedEvidenceCitation.source for folder evidence).
  readonly source?: string;
}

export interface LocalKnowledgeGroundedAnswer {
  readonly groundingKind: "local-knowledge";
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly evidenceRunId?: string | undefined;
  readonly content: string;
  readonly citations: readonly LocalKnowledgeEvidenceCitation[];
  readonly uncertainty: readonly GroundedUncertainty[];
  readonly omittedCount: number;
  readonly elapsedMs: number;
  readonly noEvidence: boolean;
  readonly noEvidenceReason?: string | undefined;
  readonly contextPack: LocalKnowledgeGroundedAnswerContextSummary;
}

// Epic #189 — the hybrid grounded answer merges folder evidence (#177/#532 lexical) and connector
// evidence (#189 vector) from one chat into a single model call. Defined here in Slice 1 so the
// wire shape and store/BFF layers type-check; Slice 2 populates it, Slice 3 renders it.
export interface HybridGroundedAnswerContextSummary {
  readonly kind: "hybrid";
  readonly folderSourceCount: number;
  readonly connectorSourceCount: number;
  readonly folder: GroundedAnswerContextPackSummary;
  readonly knowledge: LocalKnowledgeGroundedAnswerContextSummary;
}

export interface HybridGroundedAnswer {
  readonly groundingKind: "hybrid";
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly evidenceRunId?: string | undefined;
  readonly content: string;
  // folder evidence (source-tagged, like the multi-source connected answer)
  readonly citations: readonly GroundedEvidenceCitation[];
  // connector evidence (source-tagged)
  readonly knowledgeCitations: readonly LocalKnowledgeEvidenceCitation[];
  readonly uncertainty: readonly GroundedUncertainty[];
  readonly omittedCount: number;
  readonly elapsedMs: number;
  readonly contextPack: HybridGroundedAnswerContextSummary;
}

export type GroundedAnswer =
  | ConnectedContextGroundedAnswer
  | LocalKnowledgeGroundedAnswer
  | HybridGroundedAnswer;

// ─── BFF error envelope ───────────────────────────────────────────────────────────

export type BffErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NOT_APPLIABLE"
  | "EVIDENCE_SCHEMA"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_DENIED"
  | "WORKSPACE_PATH_ESCAPE"
  | "WORKSPACE_READ_FAILED"
  // Issue #149 (Epic #142) — Conversation Center server-side modality guardrails. The
  // browser surfaces these codes via the existing `gw-error` envelope; messages are static
  // English strings (no echoing of model ids, file names, or byte counts) so they pass
  // through the BFF redactor without leaking any caller-supplied value.
  | "CONVERSATION_UNAVAILABLE_MODEL"
  | "CONVERSATION_UNSUPPORTED_MODALITY"
  | "CONVERSATION_UNSUPPORTED_FILE_TYPE"
  | "CONVERSATION_OVERSIZED_CONTEXT"
  | "INTERNAL";

// The wire shape carries `code: string` — the BFF can emit codes outside the BffErrorCode union
// (forwarded from underlying packages). Consumers narrow against BffErrorCode when needed.
export interface BffError {
  readonly error: { readonly code: string; readonly message: string };
}

// ─── Run report (BFF GET /api/runs/:runId — projection over evidence + state) ─────

export type RunStatus =
  | "running"
  | "completed"
  | "dry-run"
  | "rejected"
  | "cancelled"
  | "failed"
  | "fix-applied"
  | "fix-proposed"
  | "investigation-only";

export interface ChangedFile {
  readonly path: string;
  readonly kind: string;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly elevatedReview: boolean;
}

// Compact verification step projection used by RunReport.results. Detached from the audit
// summary's AuditResultEntry so the wire shape stays small and stable.
export interface RunReportVerificationStep {
  readonly kind: string;
  readonly status: string;
  readonly command: string;
  readonly durationMs?: number;
}

export interface RunReportHypothesis {
  readonly rootCause?: string;
  readonly regressionTestStrategy?: string;
  readonly uncertainty?: string;
  readonly confidence?: string;
}

export interface RunReportUsage {
  readonly requestId: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
}

export interface RunReport {
  readonly status: RunStatus;
  readonly modelId?: string;
  readonly durationMs?: number;
  readonly report?: string;
  readonly overallStatus?: string;
  readonly results?: readonly RunReportVerificationStep[];
  readonly proposedDiff?: string;
  readonly dryRunPreview?: string;
  readonly changedFiles?: readonly ChangedFile[];
  readonly addedTestFiles?: readonly {
    readonly path: string;
    readonly estimatedTestCount?: number;
  }[];
  readonly coveredBehavior?: string;
  readonly knownGaps?: string;
  readonly verificationSkipReason?: string;
  readonly nextActions?: readonly string[];
  readonly failureReason?: string;
  readonly hypothesis?: RunReportHypothesis;
  readonly verificationSummary?: VerificationAuditSummary;
  readonly usage?: RunReportUsage;
  readonly applyReport?: RunReport;
  readonly appliedAt?: number;
}

// ─── Evidence list entry (BFF GET /api/evidence) ──────────────────────────────────
// The full EvidenceManifest lives in evidence.ts; this is the lightweight list-page projection.

export type EvidenceOutcome = "completed" | "cancelled" | "failed" | "limit-exceeded";

export interface EvidenceListEntry {
  readonly runId: string;
  readonly taskType: string;
  readonly outcome: EvidenceOutcome;
  // Epoch-ms timestamps from the audit layer (numbers, not Date objects).
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly modelId: string;
  readonly workspaceRoot?: string;
}

// ─── Terminal contract (ADR-0018) — bounded permitted-command execution ───────────

export interface TerminalPolicySummary {
  readonly commands: readonly string[];
  readonly limits: {
    readonly maxOutputBytes: number;
    readonly defaultTimeoutMs: number;
  };
}

export interface TerminalDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface TerminalDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface TerminalDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly TerminalDirectoryEntry[];
  readonly roots: readonly TerminalDirectoryRoot[];
}

export interface TerminalExecutionInput {
  readonly projectId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly requestId?: string;
}

export interface TerminalExecutionResult {
  readonly executionId: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export type TerminalEventKind =
  | "execution-started"
  | "execution-completed"
  | "execution-failed"
  | "execution-cancelled";

export interface TerminalEventEnvelope {
  readonly kind: TerminalEventKind;
  readonly executionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─── Files browser + editor (selected-root filesystem) ────────────────────────────

export interface FilesDirectoryRoot {
  readonly label: string;
  readonly path: string;
}

export interface FilesDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface FilesDirectoryListing {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FilesDirectoryEntry[];
  readonly roots: readonly FilesDirectoryRoot[];
}

export type FilesEntryKind = "directory" | "file" | "symlink";

export interface FilesTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FilesEntryKind;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly symlink: boolean;
  readonly readable: boolean;
}

export interface FilesTreeResponse {
  readonly root: string;
  readonly path: string;
  readonly entries: readonly FilesTreeEntry[];
  readonly truncated: boolean;
}

export interface FilesPreviewBase {
  readonly root: string;
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: number;
  readonly extension: string | null;
  readonly mime: string;
  readonly symlink: boolean;
}

export type FilesPreviewResponse =
  | (FilesPreviewBase & {
      readonly kind: "text";
      readonly content: string;
      readonly truncated: boolean;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "image";
      readonly dataUrl: string;
      readonly maxBytes: number;
    })
  | (FilesPreviewBase & {
      readonly kind: "binary";
      readonly reason: "unsupported" | "too_large";
      readonly maxBytes?: number;
    });

export interface FilesContentResponse extends FilesPreviewBase {
  readonly content: string;
  readonly maxBytes: number;
}

export interface FilesWriteRequest {
  readonly root: string;
  readonly path: string;
  readonly content: string;
  readonly expectedModifiedAt?: number;
}

// ─── Browser tool (ADR-0017) wire types ───────────────────────────────────────────

export interface BrowserViewportPx {
  readonly width: number;
  readonly height: number;
}

export interface CdpReachability {
  readonly reachable: boolean;
  readonly userAgent: string | null;
  readonly browserVersion: string | null;
  readonly webSocketDebuggerUrl: string | null;
}

export interface BrowserSessionMeta {
  readonly sessionId: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly status: "open" | "closed";
  readonly createdAt: number;
}

export interface BrowserNavigateResult {
  readonly originOnly: string;
  readonly httpStatus: number | null;
}

export type BrowserScreenshotResult =
  | {
      readonly seq: number;
      readonly viewportPx: BrowserViewportPx;
      readonly dataBase64: string;
      readonly persisted: false;
    }
  | {
      readonly seq: number;
      readonly viewportPx: BrowserViewportPx;
      readonly persisted: true;
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    };

export interface BrowserContentResult {
  readonly seq: number;
  readonly byteLength: number;
  readonly redactedHtml: string;
}

export type BrowserEventKind =
  | "session-opened"
  | "navigated"
  | "screenshot-captured"
  | "page-content-captured"
  | "session-closed"
  | "trust-warning"
  | "error";

export interface BrowserEventEnvelope {
  readonly schemaVersion?: "1";
  readonly type?: string;
  readonly runId?: string;
  readonly fingerprint?: string;
  readonly seq?: number;
  readonly ts?: number;
  readonly kind: BrowserEventKind;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
