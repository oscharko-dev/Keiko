/**
 * Lazy contract validators + BFF fetchers for three Coding Workbench route groups: GitHub issue
 * preview (#3385), governed draft-delivery journey refresh (#3389), and governed PR-description
 * application (#3399, ADR-0086).
 *
 * `./api.ts` is first-load-reachable from the desktop shell (imported synchronously for unrelated
 * routes such as `fetchConfig`/`fetchModels`), so a top-level import of these routes' contract
 * validators there ships their weight on every page load. Their validators together pull in
 * `coding-workbench-runtime`, `git-journey-validation` (+ `git-journey-outcome`), `pr-description`,
 * and `pr-description-application` — real, load-bearing contract modules the desktop shell never
 * needs (epic #3384 final-audit F18: ~11 KiB gzip landed in the first-load chunk this way). Every
 * production caller of these three route groups is already behind a `next/dynamic({ ssr: false })`
 * boundary (CodingWorkbenchWindow, GovernedPullRequestCard, GitClientWindow), so `api.ts` loads this
 * module through `await import("./coding-workbench-lazy-fetchers")` at call time instead — the same
 * technique this file's neighbour `managed-lsp-response-validators.ts` already uses for the managed
 * LSP settings routes. `api.ts` keeps its exported function names, signatures and behaviour exactly
 * as before, so no caller (in or out of the Coding Workbench tree) needs to change.
 *
 * `fetchJson` is injected by the caller (matching `managed-lsp-response-validators.ts`) rather than
 * duplicated here: `api.ts` owns the one fetch scaffold (deadline handling, CSRF header,
 * correlation-id-on-failure) and this module's job is only the request bodies and contract-shaped
 * response validators that route through it.
 */

import type { GitRepositoryValidation } from "@oscharko-dev/keiko-contracts";
import { isSafeGitRefName } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
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
import {
  ApiError,
  GITHUB_ISSUE_BINDING_ID_MAX_CHARS,
  isBoundedText,
  isRecordValue,
  SHA256_HEX,
  type CodingWorkbenchIssuePreviewRequest,
  type CodingWorkbenchJourneyRefreshResult,
  type GitDeliveryPrDescriptionApproveResponse,
  type GitDeliveryPrDescriptionPreviewInput,
  type GitDeliveryPrDescriptionProposalInput,
  type GitDeliveryPrDescriptionTarget,
  type GitHubIssuePreviewResponseWire,
  type PrDescriptionApplicationResultWire,
  type PrDescriptionPreviewWire,
} from "./api";

// Matches `api.ts`'s own private `fetchJson<T>` exactly: the shared fetch scaffold (deadline
// handling for reads, CSRF + correlation headers, `{ error: { code, message } }` envelope parsing)
// stays owned there, injected here rather than duplicated.
export type ApiFetchJson = <T>(
  path: string,
  init?: RequestInit,
  validator?: (value: unknown) => GitRepositoryValidation,
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
  if (
    !isBoundedText(value.ownerAndRepo, 256) ||
    !isGitHubOwnerAndRepo(value.ownerAndRepo)
  ) {
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
): Promise<GitHubIssuePreviewResponseWire> {
  return fetchJson<GitHubIssuePreviewResponseWire>(
    "/api/coding-workbench/issue/preview",
    {
      method: "POST",
      body: JSON.stringify({ repositoryPath: input.repositoryPath, issueRef: input.issueRef }),
      ...(signal === undefined ? {} : { signal }),
    },
    validateGitHubIssuePreviewResponse,
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
function validatePrDescriptionApplicationResultWire(value: unknown): GitRepositoryValidation {
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
