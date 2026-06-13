// BFF route dispatch (ADR-0011 D5). The route contract is wired here. The route TABLE
// (method + pattern) is static and dependency-free; each entry names a handler that receives the
// request context AND the per-server handler dependencies (resolved config, evidence store, run
// registry, redactor — see deps.ts). A handler returns a RouteResult (status + JSON body, which the
// server serializes) OR the STREAMING sentinel, meaning it has taken over the raw ServerResponse
// (the SSE events route). Non-2xx bodies use the redacted error envelope `{ error: { code, message } }`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { UiHandlerDeps } from "./deps.js";
import {
  handleConfig,
  handleModels,
  handleWorkflows,
  handleWorkspace,
  handleEvidenceList,
  handleEvidenceDetail,
} from "./read-handlers.js";
import {
  handleCreateRun,
  handleCreateChatRun,
  handleRunEvents,
  handleCancelRun,
  handleGetRun,
  handleApplyRun,
} from "./run-handlers.js";
import {
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
  handleListChats,
  handleCreateChat,
  handleUpdateChat,
  handleDeleteChat,
  handleListMessages,
  handleCreateMessage,
  handleCreateRunSummaryPair,
  handleUpdateMessage,
} from "./store-handlers.js";
import { handleCreateDesktopChat, handleSendDesktopChat } from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import {
  handleListMemories,
  handleMemoryReviewQueue,
  handleGetMemory,
  handleEditMemory,
  handlePinMemory,
  handleUnpinMemory,
  handleArchiveMemory,
  handleForgetMemory,
  handleForgetMemories,
  handleDeleteMemory,
  handleCorrectMemory,
  handleResolveMemoryConflict,
  handleAcceptMemoryProposal,
  handleRejectMemoryProposal,
} from "./memory-handlers.js";
import {
  handleMemoryRetrieveContext,
  handleMemoryCaptureFromConversation,
} from "./memory-conv-handlers.js";
import {
  handleCancelConsolidationJob,
  handleCreateConsolidationJob,
  handleGetConsolidationJob,
} from "./memory-consolidation-handlers.js";
import { handleRunMaintenance } from "./memory-maintenance-handlers.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleGroundedWorkflowHandoff } from "./grounded-handoff.js";
import { handleGatewaySetup } from "./gateway-setup.js";
import {
  handleCreateTerminalExecution,
  handleDeleteTerminalExecution,
  handleTerminalDirectories,
  handleTerminalEvents,
  handleTerminalPolicy,
} from "./terminal-routes.js";
import {
  handleFilesContent,
  handleFilesDirectories,
  handleFilesPreview,
  handleFilesTree,
} from "./files.js";
import {
  handleBrowserApplyScreenshot,
  handleBrowserContent,
  handleBrowserEvents,
  handleBrowserNavigate,
  handleBrowserScreenshot,
  handleBrowserStatus,
  handleCreateBrowserSession,
  handleDeleteBrowserSession,
} from "./browser.js";
import {
  handleCancelLocalKnowledgeCapsuleIndexing,
  handleConnectLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsule,
  handleCreateLocalKnowledgeCapsuleSet,
  handleDeleteLocalKnowledgeCapsule,
  handleDisconnectLocalKnowledgeCapsule,
  handleGetLocalKnowledgeCapsule,
  handleListLocalKnowledgeCapsules,
  handleListLocalKnowledgeCapsuleSets,
  handleReindexLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
  handleUpdateLocalKnowledgeCapsule,
} from "./local-knowledge-handlers.js";
import {
  handleRelationshipCreate,
  handleRelationshipDelete,
  handleRelationshipDependencies,
  handleRelationshipEvents,
  handleRelationshipExplain,
  handleRelationshipGet,
  handleRelationshipHealth,
  handleRelationshipImpact,
  handleRelationshipList,
  handleRelationshipPatch,
  handleRelationshipValidate,
} from "./relationship-handlers.js";
import {
  handleQiCapabilities,
  handleQiDryRunFigma,
  handleQiDryRunJira,
  handleQiSourceSelect,
  handleListQiRuns,
  handleGetQiRun,
  QI_HANDOFF_ROUTE_GROUP,
  QI_RUN_EXECUTION_ROUTE_GROUP,
  QI_REVIEW_ROUTE_GROUP,
  QI_EXPORT_ROUTE_GROUP,
  QI_EDIT_ROUTE_GROUP,
  QI_RETENTION_ROUTE_GROUP,
  QI_TRACEABILITY_ROUTE_GROUP,
  QI_RECHECK_ROUTE_GROUP,
} from "./qualityIntelligence/index.js";
import {
  handleFigmaTriggerSnapshot,
  handleFigmaLoadSnapshot,
  handleFigmaRevokeToken,
} from "./qualityIntelligence/figmaSnapshotRoutes.js";
import { handleFigmaGenerateCode } from "./qualityIntelligence/figmaCodegenRoutes.js";

export interface ApiError {
  readonly error: { readonly code: string; readonly message: string };
}

// A route handler returns the HTTP status and the JSON body to serialize, or STREAMING when it has
// written directly to the ServerResponse (SSE) and the server must not write a JSON body.
export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export const STREAMING = Symbol("streaming");
export type HandlerOutcome = RouteResult | typeof STREAMING;

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Readonly<Record<string, string>>;
  // Parsed request URL (loopback-authority base); handlers read the query without re-parsing.
  readonly url: URL;
}

export type RouteHandler = (
  ctx: RouteContext,
  deps: UiHandlerDeps,
) => HandlerOutcome | Promise<HandlerOutcome>;

export interface RouteDefinition {
  readonly method: string;
  // Path template with `:name` segments captured into `RouteContext.params`.
  readonly pattern: string;
  readonly handler: RouteHandler;
}

function health(): RouteResult {
  return { status: 200, body: { status: "ok", version: SDK_VERSION } };
}

// The full route contract: the twelve original (ADR-0011 D5), the first-run gateway setup
// endpoint, the 10 additive UI-store routes (ADR-0013 D7), three Issue #66 run-summary routes,
// two desktop chat routes, desktop terminal JSON routes, and read-only Files widget routes.
// Terminal byte I/O uses a token-scoped WebSocket upgrade path.
export const API_ROUTES: readonly RouteDefinition[] = [
  { method: "GET", pattern: "/api/health", handler: health },
  { method: "GET", pattern: "/api/config", handler: handleConfig },
  { method: "GET", pattern: "/api/models", handler: handleModels },
  { method: "POST", pattern: "/api/gateway/setup", handler: handleGatewaySetup },
  { method: "GET", pattern: "/api/workflows", handler: handleWorkflows },
  { method: "POST", pattern: "/api/runs", handler: handleCreateRun },
  { method: "GET", pattern: "/api/runs/:runId/events", handler: handleRunEvents },
  { method: "POST", pattern: "/api/runs/:runId/cancel", handler: handleCancelRun },
  { method: "GET", pattern: "/api/runs/:runId", handler: handleGetRun },
  { method: "POST", pattern: "/api/runs/:runId/apply", handler: handleApplyRun },
  { method: "GET", pattern: "/api/evidence", handler: handleEvidenceList },
  { method: "GET", pattern: "/api/evidence/:runId", handler: handleEvidenceDetail },
  { method: "GET", pattern: "/api/workspace", handler: handleWorkspace },
  // ADR-0013 D7 — UI-local persistence routes (additive).
  { method: "GET", pattern: "/api/projects", handler: handleListProjects },
  { method: "POST", pattern: "/api/projects", handler: handleCreateProject },
  { method: "PATCH", pattern: "/api/projects", handler: handleUpdateProject },
  { method: "DELETE", pattern: "/api/projects", handler: handleDeleteProject },
  { method: "GET", pattern: "/api/chats", handler: handleListChats },
  { method: "POST", pattern: "/api/chats", handler: handleCreateChat },
  // Issue #66 — composer launch path: persist chat pair and start the run as one BFF operation.
  { method: "POST", pattern: "/api/chats/runs", handler: handleCreateChatRun },
  { method: "PATCH", pattern: "/api/chats", handler: handleUpdateChat },
  { method: "DELETE", pattern: "/api/chats", handler: handleDeleteChat },
  { method: "GET", pattern: "/api/chats/messages", handler: handleListMessages },
  { method: "POST", pattern: "/api/chats/messages", handler: handleCreateMessage },
  // Issue #66 — atomic composer write: exactly one user message plus one run-summary system message.
  {
    method: "POST",
    pattern: "/api/chats/messages/run-summary-pair",
    handler: handleCreateRunSummaryPair,
  },
  // Issue #66 — PATCH a run-summary message (status/shortResult/taskType).
  { method: "PATCH", pattern: "/api/chats/messages", handler: handleUpdateMessage },
  // Issue #185 — grounded repository-aware Q&A. Composes #179-#183 behind the chat-scope binding.
  { method: "POST", pattern: "/api/chats/messages/grounded", handler: handleGroundedAsk },
  {
    method: "POST",
    pattern: "/api/chats/messages/grounded/handoff",
    handler: handleGroundedWorkflowHandoff,
  },
  // Desktop canvas V1 — real chat against the configured gateway model without new agent scope.
  { method: "POST", pattern: "/api/desktop/chats", handler: handleCreateDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat", handler: handleSendDesktopChat },
  { method: "POST", pattern: "/api/desktop/chat/stream", handler: handleSendDesktopChatStream },
  // ADR-0018 — bounded permitted-command execution. PTY routes (shells/sessions/WS upgrade) and
  // the WebSocket upgrade handler in server.ts are removed; commands run via synchronous POST.
  { method: "GET", pattern: "/api/terminal/policy", handler: handleTerminalPolicy },
  { method: "GET", pattern: "/api/terminal/directories", handler: handleTerminalDirectories },
  { method: "POST", pattern: "/api/terminal/executions", handler: handleCreateTerminalExecution },
  {
    method: "DELETE",
    pattern: "/api/terminal/executions/:executionId",
    handler: handleDeleteTerminalExecution,
  },
  { method: "GET", pattern: "/api/terminal/events", handler: handleTerminalEvents },
  // Desktop files — selected-root browser, preview, and editor control plane.
  { method: "GET", pattern: "/api/files/directories", handler: handleFilesDirectories },
  { method: "GET", pattern: "/api/files/tree", handler: handleFilesTree },
  { method: "GET", pattern: "/api/files/preview", handler: handleFilesPreview },
  { method: "GET", pattern: "/api/files/content", handler: handleFilesContent },
  { method: "PATCH", pattern: "/api/files/content", handler: handleFilesContent },
  // Issue #198 audit fix — live capsule detail/health routes for the Local Knowledge UI.
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsules",
    handler: handleListLocalKnowledgeCapsules,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules",
    handler: handleCreateLocalKnowledgeCapsule,
  },
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsule-sets",
    handler: handleListLocalKnowledgeCapsuleSets,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsule-sets",
    handler: handleCreateLocalKnowledgeCapsuleSet,
  },
  {
    method: "GET",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleGetLocalKnowledgeCapsule,
  },
  {
    method: "PATCH",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleUpdateLocalKnowledgeCapsule,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/index",
    handler: handleStartLocalKnowledgeCapsuleIndexing,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId/index",
    handler: handleCancelLocalKnowledgeCapsuleIndexing,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/connection",
    handler: handleConnectLocalKnowledgeCapsule,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId/connection",
    handler: handleDisconnectLocalKnowledgeCapsule,
  },
  {
    method: "DELETE",
    pattern: "/api/local-knowledge/capsules/:capsuleId",
    handler: handleDeleteLocalKnowledgeCapsule,
  },
  {
    method: "POST",
    pattern: "/api/local-knowledge/capsules/:capsuleId/reindex",
    handler: handleReindexLocalKnowledgeCapsule,
  },
  // Issues #209/#211 — Memory Center governance routes (Epic #204).
  { method: "GET", pattern: "/api/memory", handler: handleListMemories },
  { method: "GET", pattern: "/api/memory/review-queue", handler: handleMemoryReviewQueue },
  { method: "POST", pattern: "/api/memory/forget", handler: handleForgetMemories },
  {
    method: "POST",
    pattern: "/api/memory/conflicts/resolve",
    handler: handleResolveMemoryConflict,
  },
  { method: "GET", pattern: "/api/memory/:id", handler: handleGetMemory },
  { method: "PATCH", pattern: "/api/memory/:id", handler: handleEditMemory },
  { method: "POST", pattern: "/api/memory/:id/pin", handler: handlePinMemory },
  { method: "POST", pattern: "/api/memory/:id/unpin", handler: handleUnpinMemory },
  { method: "POST", pattern: "/api/memory/:id/archive", handler: handleArchiveMemory },
  { method: "POST", pattern: "/api/memory/:id/forget", handler: handleForgetMemory },
  { method: "DELETE", pattern: "/api/memory/:id", handler: handleDeleteMemory },
  { method: "POST", pattern: "/api/memory/:id/correct", handler: handleCorrectMemory },
  {
    method: "POST",
    pattern: "/api/memory/proposals/:id/accept",
    handler: handleAcceptMemoryProposal,
  },
  {
    method: "POST",
    pattern: "/api/memory/proposals/:id/reject",
    handler: handleRejectMemoryProposal,
  },
  // Issue #212 — Conversation Center memory wiring.
  { method: "POST", pattern: "/api/memory/context", handler: handleMemoryRetrieveContext },
  {
    method: "POST",
    pattern: "/api/memory/capture-from-conversation",
    handler: handleMemoryCaptureFromConversation,
  },
  // Issue #208 — explicit consolidation jobs for the Memory Center review surface.
  {
    method: "POST",
    pattern: "/api/memory/consolidation/jobs",
    handler: handleCreateConsolidationJob,
  },
  {
    method: "GET",
    pattern: "/api/memory/consolidation/jobs/:jobId",
    handler: handleGetConsolidationJob,
  },
  {
    method: "POST",
    pattern: "/api/memory/consolidation/jobs/:jobId/cancel",
    handler: handleCancelConsolidationJob,
  },
  // Issue #204 — bounded, user-triggerable memory maintenance (consolidate + decay + forget).
  { method: "POST", pattern: "/api/memory/maintenance", handler: handleRunMaintenance },
  // ADR-0017 — browser tool (BYO Chrome over CDP).
  { method: "GET", pattern: "/api/browser/status", handler: handleBrowserStatus },
  { method: "POST", pattern: "/api/browser/sessions", handler: handleCreateBrowserSession },
  {
    method: "DELETE",
    pattern: "/api/browser/sessions/:sessionId",
    handler: handleDeleteBrowserSession,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/navigate",
    handler: handleBrowserNavigate,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/screenshot",
    handler: handleBrowserScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/apply",
    handler: handleBrowserApplyScreenshot,
  },
  {
    method: "POST",
    pattern: "/api/browser/sessions/:sessionId/content",
    handler: handleBrowserContent,
  },
  {
    method: "GET",
    pattern: "/api/browser/sessions/:sessionId/events",
    handler: handleBrowserEvents,
  },
  // Issue #278 (Epic #270) — Quality Intelligence connector routes (additive).
  // Authorisation defaults to FALSE; only flips on explicit gateway-config flags.
  // No outbound network call; no provider SDK import.
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/select",
    handler: handleQiSourceSelect,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/dryrun-figma",
    handler: handleQiDryRunFigma,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/sources/dryrun-jira",
    handler: handleQiDryRunJira,
  },
  {
    method: "GET",
    pattern: "/api/quality-intelligence/sources/capabilities",
    handler: handleQiCapabilities,
  },
  // Issue #280 (Epic #270) — Quality Intelligence UI read routes (additive). Composed from
  // keiko-evidence UNCHANGED (ADR-0023 D8).
  { method: "GET", pattern: "/api/quality-intelligence/runs", handler: handleListQiRuns },
  { method: "GET", pattern: "/api/quality-intelligence/runs/:id", handler: handleGetQiRun },
  // Issue #273/#280 (Epic #270) — Quality Intelligence run execution: start (SSE progress stream)
  // + cancel. The model-routed test-design workflow runs through the Keiko Model Gateway and
  // persists the manifest + candidate artifact through Keiko Evidence.
  ...QI_RUN_EXECUTION_ROUTE_GROUP,
  // Issue #282/#283 (Epic #270) — Quality Intelligence review governance + export. Literal-suffix
  // POST routes (/runs/:id/review, /runs/:id/export) disambiguate against /runs/:id/cancel.
  ...QI_REVIEW_ROUTE_GROUP,
  ...QI_EXPORT_ROUTE_GROUP,
  // Issue #726 (Epic #712) — inline candidate editing. Literal-suffix POST /runs/:id/edit
  // disambiguates against /runs/:id/cancel just like /review and /export above.
  ...QI_EDIT_ROUTE_GROUP,
  // Issue #282 follow-up (Epic #270) — run-deletion control. DELETE /runs/:id is method-distinct
  // from GET /runs/:id and sweeps every server-owned companion (ADR-0023 D8).
  ...QI_RETENTION_ROUTE_GROUP,
  // Issue #740 (Epic #734) — requirement↔test traceability matrix export.
  ...QI_TRACEABILITY_ROUTE_GROUP,
  // Issue #743 (Epic #735) — drift re-check + targeted regeneration. Literal-suffix POST routes
  // (:id/re-check, :id/regenerate-stale) must be registered before any parameterised sibling.
  ...QI_RECHECK_ROUTE_GROUP,
  // Issue #539 (Epic #532) — relationship engine routes. The api-contract.md §2 ordering
  // is preserved; literal-suffix paths (validate, impact, health, events) come BEFORE the
  // `:id`-templated routes so matchRoute returns the literal handler instead of binding
  // "validate" / "impact" / "health" / "events" to the `:id` param. Internal route #11
  // (events) returns the STREAMING sentinel from `handleRelationshipEvents`.
  { method: "POST", pattern: "/api/relationships/validate", handler: handleRelationshipValidate },
  { method: "GET", pattern: "/api/relationships/impact", handler: handleRelationshipImpact },
  { method: "GET", pattern: "/api/relationships/health", handler: handleRelationshipHealth },
  { method: "GET", pattern: "/api/relationships/events", handler: handleRelationshipEvents },
  { method: "POST", pattern: "/api/relationships", handler: handleRelationshipCreate },
  { method: "GET", pattern: "/api/relationships", handler: handleRelationshipList },
  { method: "GET", pattern: "/api/relationships/:id", handler: handleRelationshipGet },
  { method: "PATCH", pattern: "/api/relationships/:id", handler: handleRelationshipPatch },
  { method: "DELETE", pattern: "/api/relationships/:id", handler: handleRelationshipDelete },
  {
    method: "GET",
    pattern: "/api/relationships/:id/dependencies",
    handler: handleRelationshipDependencies,
  },
  { method: "GET", pattern: "/api/relationships/:id/explain", handler: handleRelationshipExplain },
  // Epic #750, Issue #756 — Figma Snapshot UI routes. PAT stays server-side; UI-safe projection only.
  // POST triggers a bounded snapshot-build from a board link; GET loads the stored summary.
  // Token: resolved server-side from FIGMA_ACCESS_TOKEN env or vault; never in request or response.
  { method: "POST", pattern: "/api/figma/snapshots", handler: handleFigmaTriggerSnapshot },
  { method: "GET", pattern: "/api/figma/snapshots/:runId", handler: handleFigmaLoadSnapshot },
  // Epic #750 #758/#760 — operator revokes the stored encrypted PAT (audited key removal).
  { method: "DELETE", pattern: "/api/figma/token", handler: handleFigmaRevokeToken },
  // Epic #750 #755 — design-to-code: emit reviewable HTML/CSS from a stored snapshot.
  { method: "POST", pattern: "/api/figma/snapshots/:runId/code", handler: handleFigmaGenerateCode },
  // Issue #281 (Epic #270) — Conversation Center → QI workflow handoff route group.
  // Single POST seam; the body is a typed `QualityIntelligenceConversationCenterHandoff`
  // envelope (refs only, no chat content). Registered as a sibling group so concurrent
  // QI epic merges (e.g. #280) stay mechanically merge-safe.
  ...QI_HANDOFF_ROUTE_GROUP,
];

// Matches a concrete path against a route pattern, capturing `:name` params. Returns the captured
// params, or undefined when the segment counts differ or a literal segment mismatches.
function matchPattern(
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i] ?? "";
    const actual = pathParts[i] ?? "";
    if (p.startsWith(":")) {
      if (actual.length === 0) {
        return undefined;
      }
      params[p.slice(1)] = actual;
    } else if (p !== actual) {
      return undefined;
    }
  }
  return params;
}

export interface RouteMatch {
  readonly definition: RouteDefinition;
  readonly params: Readonly<Record<string, string>>;
}

// Resolves a method+path to a route. Returns `{ definition, params }` on a full match, the string
// `"method-not-allowed"` when the path matches a route of a different method, or undefined when no
// route path matches at all.
export function matchRoute(
  method: string,
  pathname: string,
): RouteMatch | "method-not-allowed" | undefined {
  let bestMethodMatch: RouteMatch | undefined;
  let bestMethodSpecificity = -1;
  let bestOtherMethodSpecificity = -1;
  for (const definition of API_ROUTES) {
    const params = matchPattern(definition.pattern, pathname);
    if (params === undefined) {
      continue;
    }
    const specificity = definition.pattern
      .split("/")
      .filter((part) => !part.startsWith(":")).length;
    if (definition.method === method) {
      if (specificity > bestMethodSpecificity) {
        bestMethodSpecificity = specificity;
        bestMethodMatch = { definition, params };
      }
      continue;
    }
    if (specificity > bestOtherMethodSpecificity) {
      bestOtherMethodSpecificity = specificity;
    }
  }
  if (bestMethodMatch !== undefined && bestMethodSpecificity >= bestOtherMethodSpecificity) {
    return bestMethodMatch;
  }
  return bestOtherMethodSpecificity >= 0 ? "method-not-allowed" : undefined;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export function notFoundBody(): ApiError {
  return errorBody("NOT_FOUND", "The requested resource was not found.");
}

export function methodNotAllowedBody(): ApiError {
  return errorBody("METHOD_NOT_ALLOWED", "The HTTP method is not allowed for this resource.");
}
