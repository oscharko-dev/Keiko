/**
 * Lazy contract validators + BFF fetchers for Coding Workbench route groups: GitHub issue
 * preview (#3385), governed draft-delivery journey refresh (#3389), and governed PR-description
 * application (#3399, ADR-0086), and governed Git fetch/pull (#1573).
 *
 * Ordinary Git reads and Chat comparison connections share this boundary and validation port.
 *
 * `./api.ts` is first-load-reachable from the desktop shell (imported synchronously for unrelated
 * routes such as `fetchConfig`/`fetchModels`), so a top-level import of these routes' contract
 * validators there ships their weight on every page load. Their validators together pull in
 * `coding-workbench-runtime`, `git-journey-validation` (+ `git-journey-outcome`), `pr-description`,
 * and `pr-description-application` — real, load-bearing contract modules the desktop shell never
 * needs (epic #3384 final-audit F18: ~11 KiB gzip landed in the first-load chunk this way). The owning
 * widgets load their routes on demand; ordinary Git reads and Chat connections also use this
 * boundary only when requested. `api.ts` loads this module through `await import("./coding-workbench-lazy-fetchers")` at call time instead — the same
 * technique this file's neighbour `managed-lsp-response-validators.ts` already uses for the managed
 * LSP settings routes. `api.ts` keeps its exported function names, signatures and behaviour exactly
 * as before, so no caller (in or out of the Coding Workbench tree) needs to change.
 *
 * `fetchJson` is injected by the caller (matching `managed-lsp-response-validators.ts`) rather than
 * duplicated here: `api.ts` owns the one fetch scaffold (deadline handling, CSRF header,
 * correlation-id-on-failure) and this module's job is only the request bodies and contract-shaped
 * response validators that route through it.
 */

import {
  CHAT_GIT_CHANGE_DESCRIPTION_STATUSES,
  GIT_CHANGE_BLOCKED_REASONS,
  isGroundingScopeIdentity,
  type ChatGitChangeScope,
  type ChatGitChangeDescriptionStatus,
  type GitChangeConnectResponse,
  type GitChangeRefreshResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  GitHistoryResponse,
  GitDiffScope,
  GitRepositoryDiffResponse,
  GitRepositoryStatusResponse,
  GitRepositorySummary,
  GitRemotesResponse,
  GitSyncOperation,
  GitSyncPreview,
  GitSyncExecuteResponse,
  GitRepositoryValidation,
} from "@oscharko-dev/keiko-contracts";
import { validateGitHistoryResponse } from "@oscharko-dev/keiko-contracts/runtime/git-history";
import {
  validateGitSyncPreview,
  validateGitSyncExecuteResponse,
} from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import {
  validateGitRemotesResponse,
  validateGitRepositorySummary,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository-summary";
import {
  isSafeGitRefName,
  validateGitRepositoryDiffResponse,
  validateGitRepositoryStatusResponse,
} from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import {
  CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS,
  CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS,
  GITHUB_ISSUE_NUMBER_MAX,
  isGitHubOwnerAndRepo,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import {
  isPrDescriptionApplicationStatus,
  PR_DESCRIPTION_APPLICATION_REASON_STATES,
} from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
// Runtime values come from the shared leaf module, never from `./api` directly: `api.ts` reaches
// this module through `await import("./coding-workbench-lazy-fetchers")` (see the file banner
// above), so a static value import back into `./api` here would make that dynamic import
// load-order-sensitive on this module's own top-level evaluation of `./api` (review finding, epic
// #3384 final-audit F18). `./api.ts` imports the exact same names from this same leaf.
import {
  ApiError,
  GITHUB_ISSUE_BINDING_ID_MAX_CHARS,
  isBoundedText,
  isRecordValue,
  SHA256_HEX,
} from "./api-shared-primitives";
import type {
  ConnectGitChangeInput,
  GitDeliverySyncInput,
  GitDeliverySyncApproveResponse,
  CodingWorkbenchIssuePreviewRequest,
  CodingWorkbenchJourneyRefreshResult,
  GitDeliveryPrDescriptionApproveResponse,
  GitDeliveryPrDescriptionPreviewInput,
  GitDeliveryPrDescriptionProposalInput,
  GitDeliveryPrDescriptionTarget,
  GitHubIssuePreviewResponseWire,
  PrDescriptionApplicationResultWire,
  PrDescriptionPreviewWire,
} from "./api";

// Matches `api.ts`'s own private `fetchJson<T>` exactly: the shared fetch scaffold (deadline
// handling for reads, CSRF + correlation headers, `{ error: { code, message } }` envelope parsing)
// stays owned there, injected here rather than duplicated.
export type ApiFetchJson = <T>(
  path: string,
  init?: RequestInit,
  validator?: (value: unknown) => GitRepositoryValidation,
  correlationId?: string,
) => Promise<T>;

// ---------------------------------------------------------------------------
// GitHub issue preview (#3385)
// ---------------------------------------------------------------------------

function isIssueNumber(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= GITHUB_ISSUE_NUMBER_MAX
  );
}

function issuePreviewProvenanceReasons(value: unknown): readonly string[] {
  if (!isRecordValue(value)) return ["preview.provenance must be an object"];
  const reasons: string[] = [];
  if (!isBoundedText(value.ownerAndRepo, 256) || !isGitHubOwnerAndRepo(value.ownerAndRepo)) {
    reasons.push("preview.provenance.ownerAndRepo must be owner/repo");
  }
  if (!isIssueNumber(value.issueNumber)) {
    reasons.push("preview.provenance.issueNumber must be a bounded positive integer");
  }
  if (!isBoundedText(value.url, 2_048) || !value.url.startsWith("https://")) {
    reasons.push("preview.provenance.url must be a bounded https URL");
  }
  return reasons;
}

function issueCommentReasons(value: Record<string, unknown>): readonly string[] {
  const comments = value.comments;
  const reasons: string[] = [];
  if (
    comments !== undefined &&
    (!Array.isArray(comments) ||
      comments.length > 8 ||
      !comments.every((comment: unknown) => isBoundedText(comment, 1024, true)))
  )
    reasons.push("preview.comments must be bounded text excerpts");
  if (value.commentsTruncated !== undefined && typeof value.commentsTruncated !== "boolean")
    reasons.push("preview.commentsTruncated must be boolean");
  if (typeof value.bodyExcerptTruncated !== "boolean")
    reasons.push("preview.bodyExcerptTruncated must be boolean");
  return reasons;
}

function issuePreviewReasons(value: unknown): readonly string[] {
  if (!isRecordValue(value)) return ["preview must be an object"];
  const reasons: string[] = [];
  if (!isBoundedText(value.title, CODING_WORKBENCH_ISSUE_PREVIEW_TITLE_MAX_CHARS)) {
    reasons.push("preview.title must be bounded text");
  }
  if (!isBoundedText(value.bodyExcerpt, CODING_WORKBENCH_ISSUE_PREVIEW_EXCERPT_MAX_CHARS, true)) {
    reasons.push("preview.bodyExcerpt must be bounded text");
  }
  if (!Number.isSafeInteger(value.commentCount) || Number(value.commentCount) < 0) {
    reasons.push("preview.commentCount must be a non-negative integer");
  }
  if (value.state !== "open" && value.state !== "closed")
    reasons.push("preview.state must be open or closed");
  if (value.untrusted !== true) reasons.push("preview.untrusted must be true");
  reasons.push(...issuePreviewProvenanceReasons(value.provenance), ...issueCommentReasons(value));
  return reasons;
}

const ISSUE_BINDING_DIGEST_FIELDS = ["remoteDigest", "issueIdDigest", "bindingDigest"] as const;

function issueBindingDigestReasons(value: Record<string, unknown>): readonly string[] {
  const reasons: string[] = [];
  for (const field of ISSUE_BINDING_DIGEST_FIELDS) {
    const digest = value[field];
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
      reasons.push(`binding.${field} must be a sha256 digest`);
    }
  }
  return reasons;
}

function issueBindingIdentityReasons(value: Record<string, unknown>): readonly string[] {
  const reasons: string[] = [];
  if (!isBoundedText(value.repositoryId, GITHUB_ISSUE_BINDING_ID_MAX_CHARS)) {
    reasons.push("binding.repositoryId must be a bounded id");
  }
  if (!isIssueNumber(value.issueNumber)) {
    reasons.push("binding.issueNumber must be a bounded positive integer");
  }
  if (typeof value.defaultBaseRef !== "string" || !isSafeGitRefName(value.defaultBaseRef)) {
    reasons.push("binding.defaultBaseRef must be a safe git ref");
  }
  return reasons;
}

const ISSUE_BINDING_KEYS: ReadonlySet<string> = new Set([
  "repositoryId",
  "remoteDigest",
  "issueNumber",
  "issueIdDigest",
  "defaultBaseRef",
  "bindingDigest",
]);

// Exact keys: a binding that carries anything beyond its content-free fields — a title, a body —
// is refused, so issue text can never ride along inside the value the UI echoes back.
function issueBindingReasons(value: unknown): readonly string[] {
  if (!isRecordValue(value)) return ["binding must be an object"];
  const extra = Object.keys(value)
    .filter((key) => !ISSUE_BINDING_KEYS.has(key))
    .map((key) => `binding.${key} is not a binding field`);
  return [...extra, ...issueBindingIdentityReasons(value), ...issueBindingDigestReasons(value)];
}

// The preview and the binding describe the same issue: a response whose two halves name different
// numbers would let the renderer show one issue while the run binds another.
function issuePreviewCoherenceReasons(value: Record<string, unknown>): readonly string[] {
  const preview = value.preview;
  const binding = value.binding;
  if (!isRecordValue(preview) || !isRecordValue(binding)) return [];
  const provenance = preview.provenance;
  if (!isRecordValue(provenance)) return [];
  return provenance.issueNumber === binding.issueNumber
    ? []
    : ["binding.issueNumber must equal preview.provenance.issueNumber"];
}

function validateGitHubIssuePreviewResponse(value: unknown): GitRepositoryValidation {
  if (!isRecordValue(value)) return { ok: false, reasons: ["issue preview must be an object"] };
  const reasons = [
    ...issuePreviewReasons(value.preview),
    ...issueBindingReasons(value.binding),
    ...issuePreviewCoherenceReasons(value),
  ];
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Resolve and preview a GitHub issue for the repository at `input.repositoryPath` (#3385). The
 * server parses the reference, checks the per-checkout grant, reads the issue through the `gh`
 * boundary and answers with the bounded preview plus the content-free binding, or a 4xx whose
 * `error.code` is a `CodingWorkbenchIssueBindingFailure` member.
 */
export async function previewCodingWorkbenchIssue(
  fetchJson: ApiFetchJson,
  input: CodingWorkbenchIssuePreviewRequest,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<GitHubIssuePreviewResponseWire> {
  return fetchJson<GitHubIssuePreviewResponseWire>(
    "/api/coding-workbench/issue/preview",
    {
      method: "POST",
      body: JSON.stringify({ repositoryPath: input.repositoryPath, issueRef: input.issueRef }),
      ...(signal === undefined ? {} : { signal }),
    },
    validateGitHubIssuePreviewResponse,
    correlationId,
  );
}

// ---------------------------------------------------------------------------
// Draft-delivery journey observation/refresh (#3389)
// ---------------------------------------------------------------------------

const RUN_ID_MAX_CHARS = 128;

/**
 * The outcome itself is fully validated against the shared contract (`isJourneyOutcome`): its
 * state, reason and binding vocabularies are never restated here. The "unavailable" envelope has
 * no contracts-level type of its own (it is this route's own closed reason set, journeyRoutes.ts
 * `JourneyObservationResult`), so this checks only its structural shape — a non-empty reason
 * string — rather than duplicating that server-owned enum on the client.
 */
function validateCodingWorkbenchJourneyRefreshResponse(value: unknown): GitRepositoryValidation {
  if (!isRecordValue(value)) {
    return { ok: false, reasons: ["journey refresh response must be an object"] };
  }
  if (value.status === "observed") {
    return isJourneyOutcome(value.outcome)
      ? { ok: true }
      : { ok: false, reasons: ["journey refresh response.outcome must be a valid JourneyOutcome"] };
  }
  if (value.status === "unavailable") {
    return isBoundedText(value.reason, 64)
      ? { ok: true }
      : {
          ok: false,
          reasons: ["journey refresh response.reason must be a bounded, non-empty string"],
        };
  }
  return {
    ok: false,
    reasons: ["journey refresh response.status must be observed or unavailable"],
  };
}

/** Reads/refreshes the bounded journey observation for one accepted draft-delivery run (#3389). */
export async function fetchCodingWorkbenchJourneyRefresh(
  fetchJson: ApiFetchJson,
  input: { readonly runId: string },
  signal?: AbortSignal,
): Promise<CodingWorkbenchJourneyRefreshResult> {
  if (!isBoundedText(input.runId, RUN_ID_MAX_CHARS)) {
    throw new ApiError(
      "CONTRACT_VALIDATION_FAILED",
      "runId must be a bounded, non-empty string",
      400,
    );
  }
  return fetchJson<CodingWorkbenchJourneyRefreshResult>(
    "/api/git-delivery/journey/refresh",
    {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1", runId: input.runId }),
      ...(signal === undefined ? {} : { signal }),
    },
    validateCodingWorkbenchJourneyRefreshResponse,
  );
}

// ---------------------------------------------------------------------------
// Governed PR-description application (#3399, epic #3384 correction 4, ADR-0086)
// ---------------------------------------------------------------------------

function isPrDescriptionPreviewWire(value: unknown): value is PrDescriptionPreviewWire {
  if (!isRecordValue(value)) return false;
  return (
    isBoundedText(value.proposalId, 128) &&
    typeof value.expiresAt === "string" &&
    isPrDescriptionApplicationStatus(value.status) &&
    typeof value.finalBody === "string" &&
    typeof value.managedRegion === "string" &&
    typeof value.concurrencyLimitation === "string"
  );
}

/**
 * Rejects any wire body the shared contract does not sanction — a malformed status, an unknown
 * blocked reason, or a preview envelope missing the server-rendered final body — before it ever
 * reaches a component (client-side enforcement of the same closed vocabulary prDescriptionRoutes.ts
 * validates server-side).
 */
export function validatePrDescriptionApplicationResultWire(
  value: unknown,
): GitRepositoryValidation {
  if (!isRecordValue(value)) {
    return { ok: false, reasons: ["pr-description response must be an object"] };
  }
  if (value.outcome === "preview") {
    return isPrDescriptionPreviewWire(value.preview)
      ? { ok: true }
      : { ok: false, reasons: ["pr-description preview envelope failed contract validation"] };
  }
  if (value.outcome === "observed") {
    return isPrDescriptionApplicationStatus(value.status)
      ? { ok: true }
      : { ok: false, reasons: ["pr-description observed status failed contract validation"] };
  }
  if (value.outcome === "blocked") {
    return typeof value.reason === "string" &&
      Object.hasOwn(PR_DESCRIPTION_APPLICATION_REASON_STATES, value.reason)
      ? { ok: true }
      : { ok: false, reasons: ["pr-description blocked reason is not in the closed vocabulary"] };
  }
  return {
    ok: false,
    reasons: ["pr-description response.outcome must be preview, observed, or blocked"],
  };
}

export function validateGitChangeApplyDescriptionResponse(value: unknown): GitRepositoryValidation {
  const validation = validatePrDescriptionApplicationResultWire(value);
  if (!validation.ok) return validation;
  return isRecordValue(value) && value.outcome !== "preview"
    ? { ok: true }
    : { ok: false, reasons: ["response.outcome must be observed or blocked"] };
}

function gitDeliveryPrDescriptionTargetBody(
  input: GitDeliveryPrDescriptionTarget,
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId: input.projectId,
    ownerAndRepo: input.ownerAndRepo,
    prNumber: input.prNumber,
    ...(input.snapshotDigest === undefined ? {} : { snapshotDigest: input.snapshotDigest }),
  };
}

export async function fetchGitDeliveryPrDescriptionPreview(
  fetchJson: ApiFetchJson,
  input: GitDeliveryPrDescriptionPreviewInput,
  signal?: AbortSignal,
): Promise<PrDescriptionApplicationResultWire> {
  return fetchJson<PrDescriptionApplicationResultWire>(
    "/api/git-delivery/pr-description/preview",
    {
      method: "POST",
      body: JSON.stringify({
        ...gitDeliveryPrDescriptionTargetBody(input),
        language: input.language,
        ...(input.refinement === undefined ? {} : { refinement: input.refinement }),
      }),
      ...(signal === undefined ? {} : { signal }),
    },
    validatePrDescriptionApplicationResultWire,
  );
}

export async function fetchGitDeliveryPrDescriptionReview(
  fetchJson: ApiFetchJson,
  input: GitDeliveryPrDescriptionProposalInput,
  signal?: AbortSignal,
): Promise<PrDescriptionApplicationResultWire> {
  return fetchJson<PrDescriptionApplicationResultWire>(
    "/api/git-delivery/pr-description/review",
    {
      method: "POST",
      body: JSON.stringify({
        ...gitDeliveryPrDescriptionTargetBody(input),
        proposalId: input.proposalId,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
    validatePrDescriptionApplicationResultWire,
  );
}

export async function fetchGitDeliveryPrDescriptionApprove(
  fetchJson: ApiFetchJson,
  input: GitDeliveryPrDescriptionProposalInput,
  signal?: AbortSignal,
): Promise<GitDeliveryPrDescriptionApproveResponse> {
  return fetchJson<GitDeliveryPrDescriptionApproveResponse>(
    "/api/git-delivery/pr-description/approve",
    {
      method: "POST",
      body: JSON.stringify({
        ...gitDeliveryPrDescriptionTargetBody(input),
        proposalId: input.proposalId,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
}

export async function fetchGitDeliveryPrDescriptionApply(
  fetchJson: ApiFetchJson,
  input: GitDeliveryPrDescriptionProposalInput,
  signal?: AbortSignal,
): Promise<PrDescriptionApplicationResultWire> {
  return fetchJson<PrDescriptionApplicationResultWire>(
    "/api/git-delivery/pr-description/apply",
    {
      method: "POST",
      body: JSON.stringify({
        ...gitDeliveryPrDescriptionTargetBody(input),
        proposalId: input.proposalId,
      }),
      ...(signal === undefined ? {} : { signal }),
    },
    validatePrDescriptionApplicationResultWire,
  );
}

export async function fetchGitDeliveryPrDescriptionStatus(
  fetchJson: ApiFetchJson,
  input: GitDeliveryPrDescriptionTarget,
  signal?: AbortSignal,
): Promise<PrDescriptionApplicationResultWire> {
  return fetchJson<PrDescriptionApplicationResultWire>(
    "/api/git-delivery/pr-description/status",
    {
      method: "POST",
      body: JSON.stringify(gitDeliveryPrDescriptionTargetBody(input)),
      ...(signal === undefined ? {} : { signal }),
    },
    validatePrDescriptionApplicationResultWire,
  );
}

// Governed Git fetch/pull keeps request construction and validation behind the same lazy boundary.

function gitDeliverySyncBody(input: GitDeliverySyncInput): string {
  return JSON.stringify({
    schemaVersion: "1",
    projectId: input.projectId,
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
    ...(input.userInitiated === true ? { userInitiated: true } : {}),
  });
}

function gitDeliverySyncPath(
  operation: GitSyncOperation,
  phase: "preview" | "approve" | "execute",
): string {
  return `/api/git-delivery/${operation}/${phase}`;
}

export async function fetchGitSyncPreview(
  fetchJson: ApiFetchJson,
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

export async function fetchGitSyncExecute(
  fetchJson: ApiFetchJson,
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

export async function fetchGitSyncApprove(
  fetchJson: ApiFetchJson,
  input: Omit<GitDeliverySyncInput, "approval" | "userInitiated">,
  signal?: AbortSignal,
): Promise<GitDeliverySyncApproveResponse> {
  return fetchJson(gitDeliverySyncPath(input.operation, "approve"), {
    method: "POST",
    body: gitDeliverySyncBody(input),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function fetchGitHistory(
  fetchJson: ApiFetchJson,
  input: Parameters<typeof import("./api").fetchGitHistory>[0],
): Promise<GitHistoryResponse> {
  const params = new URLSearchParams();
  params.set("root", input.root);
  if (input.limit !== undefined) params.set("limit", input.limit.toString());
  if (input.skip !== undefined) params.set("skip", input.skip.toString());
  return fetchJson(`/api/git/history?${params.toString()}`, undefined, validateGitHistoryResponse);
}

export async function fetchGitStatus(
  fetchJson: ApiFetchJson,
  root: string,
  options?: Parameters<typeof import("./api").fetchGitStatus>[1],
): Promise<GitRepositoryStatusResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  if (options?.includeIgnored === true) params.set("includeIgnored", "true");
  return fetchJson(
    `/api/git/status?${params.toString()}`,
    undefined,
    validateGitRepositoryStatusResponse,
    options?.correlationId,
  );
}

export async function fetchGitSummary(
  fetchJson: ApiFetchJson,
  root: string,
  options?: Parameters<typeof import("./api").fetchGitSummary>[1],
): Promise<GitRepositorySummary> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(
    `/api/git/summary?${params.toString()}`,
    undefined,
    validateGitRepositorySummary,
    options?.correlationId,
  );
}

export async function fetchGitRemotes(
  fetchJson: ApiFetchJson,
  root: string,
): Promise<GitRemotesResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  return fetchJson(`/api/git/remotes?${params.toString()}`, undefined, validateGitRemotesResponse);
}

export async function fetchGitDiff(
  fetchJson: ApiFetchJson,
  input: {
    readonly root: string;
    readonly path?: string;
    readonly scope?: GitDiffScope;
  },
): Promise<GitRepositoryDiffResponse> {
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

// Git-to-Chat comparison connections use the same deferred, validated request boundary.

// The 11-member closed reason set is owned once by keiko-contracts (bff-wire.ts) and imported
// here rather than restated — the server route (gitChangeRoutes.ts) imports the same constant
// (F30 in the epic #3384 final audit).
const GIT_CHANGE_BLOCKED_REASON_SET: ReadonlySet<string> = new Set(GIT_CHANGE_BLOCKED_REASONS);

// Owner audit b1-12 — the closed `descriptionStatus` vocabulary is owned once by keiko-contracts
// (bff-wire.ts) and imported here rather than restated, mirroring the blocked-reason set above.
const CHAT_GIT_CHANGE_DESCRIPTION_STATUS_SET: ReadonlySet<string> = new Set(
  CHAT_GIT_CHANGE_DESCRIPTION_STATUSES,
);

const GIT_COMMIT_SHA_HEX = /^[0-9a-f]{40}$/u;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isGitCommitShaHex(value: unknown): value is string {
  return typeof value === "string" && GIT_COMMIT_SHA_HEX.test(value);
}

// Owner audit b1-12 — the sibling `blocked` reason is checked against the closed set below; this
// mirrors it for `descriptionStatus` instead of accepting any bounded string, so an unrecognised
// value is rejected here rather than reaching the pill's status-badge lookup and throwing.
function isChatGitChangeDescriptionStatus(value: unknown): value is ChatGitChangeDescriptionStatus {
  return typeof value === "string" && CHAT_GIT_CHANGE_DESCRIPTION_STATUS_SET.has(value);
}

function hasChatGitChangeScopeTextFields(value: Record<string, unknown>): boolean {
  return (
    isBoundedText(value.relationshipId, 256) &&
    isSha256Hex(value.remoteDigest) &&
    isBoundedText(value.comparisonLabel, 240) &&
    isBoundedText(value.baseRef, 512) &&
    isBoundedText(value.headRef, 512) &&
    isGitCommitShaHex(value.baseSha) &&
    isGitCommitShaHex(value.headSha) &&
    isGitCommitShaHex(value.mergeBaseSha) &&
    isSha256Hex(value.snapshotDigest) &&
    isChatGitChangeDescriptionStatus(value.descriptionStatus)
  );
}

function hasChatGitChangeScopeCountFields(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.fileCount) &&
    Number.isSafeInteger(value.totalFiles) &&
    Number.isSafeInteger(value.omittedFiles) &&
    Number.isSafeInteger(value.truncatedFiles) &&
    Number.isSafeInteger(value.connectedAtMs)
  );
}

function isChatGitChangeScope(value: unknown): value is ChatGitChangeScope {
  if (!isRecordValue(value) || value.kind !== "git-change") return false;
  return hasChatGitChangeScopeTextFields(value) && hasChatGitChangeScopeCountFields(value);
}

function hasCanonicalGitChatFields(value: Record<string, unknown>, chatId: string): boolean {
  return (
    value.id === chatId &&
    typeof value.projectPath === "string" &&
    typeof value.title === "string" &&
    typeof value.selectedModel === "string" &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.updatedAt) &&
    value.status === "open" &&
    isGroundingScopeIdentity(value.groundingScopeIdentity)
  );
}

function hasCoherentGitChat(value: unknown, scope: ChatGitChangeScope, chatId: string): boolean {
  if (value === undefined) return true;
  if (!isRecordValue(value) || !hasCanonicalGitChatFields(value, chatId)) return false;
  if (!Array.isArray(value.gitChangeScopes) || !value.gitChangeScopes.every(isChatGitChangeScope)) {
    return false;
  }
  return value.gitChangeScopes.some(
    (candidate: ChatGitChangeScope) =>
      candidate.relationshipId === scope.relationshipId &&
      candidate.remoteDigest === scope.remoteDigest &&
      candidate.snapshotDigest === scope.snapshotDigest,
  );
}

function validateGitChangeResponse(
  value: unknown,
  chatId: string,
  statuses: ReadonlySet<string>,
): GitRepositoryValidation {
  if (!isRecordValue(value)) return { ok: false, reasons: ["response must be an object"] };
  if (value.status === "blocked") {
    return GIT_CHANGE_BLOCKED_REASON_SET.has(value.reason as string)
      ? { ok: true }
      : { ok: false, reasons: ["response.reason is not a known blocked reason"] };
  }
  if (
    typeof value.status === "string" &&
    statuses.has(value.status) &&
    isChatGitChangeScope(value.scope) &&
    hasCoherentGitChat(value.chat, value.scope, chatId)
  )
    return { ok: true };
  return { ok: false, reasons: ["response does not match the committed Git change"] };
}

const GIT_CONNECT_STATUSES: ReadonlySet<string> = new Set(["connected"]);
const GIT_REFRESH_STATUSES: ReadonlySet<string> = new Set(["current", "stale"]);

export async function connectGitChangeToChat(
  fetchJson: ApiFetchJson,
  input: ConnectGitChangeInput,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<GitChangeConnectResponse> {
  return fetchJson(
    "/api/git-change/connect",
    {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1", ...input }),
      ...(signal === undefined ? {} : { signal }),
    },
    (value) => validateGitChangeResponse(value, input.chatId, GIT_CONNECT_STATUSES),
    correlationId,
  );
}

/**
 * Re-checks a connected git-change scope against the live repository. `reads-context` is
 * immutable and non-reconnectable, so a drifted comparison archives the existing relationship and
 * creates a new one server-side; the chat's scope list is updated in the same call.
 */
export async function refreshGitChangeScope(
  fetchJson: ApiFetchJson,
  chatId: string,
  relationshipId: string,
  signal?: AbortSignal,
  correlationId?: string,
): Promise<GitChangeRefreshResponse> {
  return fetchJson(
    "/api/git-change/refresh",
    {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1", chatId, relationshipId }),
      ...(signal === undefined ? {} : { signal }),
    },
    (value) => validateGitChangeResponse(value, chatId, GIT_REFRESH_STATUSES),
    correlationId,
  );
}
