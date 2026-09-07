// Issue-intake preview route for the Coding Workbench (#3385, Epic #3384).
//
// POST /api/coding-workbench/issue/preview { repositoryPath, issueRef }
//   200 { preview, binding }                          — an open issue in the checkout's own remote
//   4xx { failure, error: { code, message, correlationId } } — one closed failure, never a guess
//
// The caller names a repository the same way the GitHub-authorization routes accept one: the name
// is intent, registration is authority. An unregistered path is refused before anything is read,
// the canonical root is resolved here, and every identity in the response is derived from it
// server-side. The body is a reference and a path — a 1 KiB cap says so. The preview's text is
// untrusted issue content and crosses to the browser only through the live-payload redactor.

import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type {
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchIssuePreview,
  CodingWorkbenchIssuePreviewFailureWire,
  CodingWorkbenchIssuePreviewRequestWire,
  CodingWorkbenchIssuePreviewResponseWire,
} from "@oscharko-dev/keiko-contracts";
import { parseCodingWorkbenchIssuePreviewRequest } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { GitDeliveryBodyTooLargeError, readGitDeliveryBody } from "../gitDelivery/requestGuards.js";
import { processServerLogSink } from "../process-log-sink.js";
import { createRequestCancellation } from "../request-cancellation.js";
import { errorBody, type RouteContext, type RouteHandler, type RouteResult } from "../routes.js";
import {
  resolveGitHubIssue,
  type GitHubIssueResolutionReason,
  type GitHubIssueResolver,
} from "./githubIssueResolution.js";

// A repository path and one pasted reference. Anything larger is not this request. Enforced on
// the bytes actually read, behind the shared transport reader's own (wider) cap.
export const ISSUE_PREVIEW_MAX_BODY_BYTES = 1_024;

interface FailureStatus {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

// The closed failure vocabulary, each with the status and the actionable message the browser
// shows. `failure` is what a client keys on; the status is for the transport.
const FAILURE_STATUSES: Readonly<Record<CodingWorkbenchIssueBindingFailure, FailureStatus>> = {
  "invalid-reference": {
    status: 400,
    code: "CODING_WORKBENCH_ISSUE_INVALID_REFERENCE",
    message: "Paste a GitHub issue URL, owner/repo#number, or #number.",
  },
  "repository-mismatch": {
    status: 409,
    code: "CODING_WORKBENCH_ISSUE_REPOSITORY_MISMATCH",
    message: "The issue belongs to a different repository. Switch, open or clone it first.",
  },
  "auth-required": {
    status: 403,
    code: "CODING_WORKBENCH_ISSUE_AUTH_REQUIRED",
    message: "Enable GitHub issue access for this repository in Settings.",
  },
  "issue-unavailable": {
    status: 404,
    code: "CODING_WORKBENCH_ISSUE_UNAVAILABLE",
    message: "The issue is closed, transferred, a pull request, or not readable.",
  },
  "clone-failed": {
    status: 409,
    code: "CODING_WORKBENCH_ISSUE_CLONE_FAILED",
    message: "The local checkout does not record a default branch. Clone it again.",
  },
  "authority-denied": {
    status: 403,
    code: "CODING_WORKBENCH_ISSUE_AUTHORITY_DENIED",
    message: "The current authority does not permit an issue-bound run.",
  },
  cancelled: {
    status: 409,
    code: "CODING_WORKBENCH_ISSUE_CANCELLED",
    message: "The preview was cancelled.",
  },
};

// #3384 B5-13: a rate limit, a GitHub-side 5xx, or a wall-time timeout is reported as this
// distinct status/code/message instead of the fixed "issue-unavailable" diagnosis — the wire
// `failure` field stays "issue-unavailable" (the closed vocabulary has no transient member), but
// the retry-worded code and 503 status tell a client apart from a genuinely unreadable issue. See
// `codingWorkbenchIssueFailure` in the UI's coding-workbench-issue-errors.ts, which maps this
// `error.code` (a free string, not part of the closed wire vocabulary) onto its own retry-labelled
// intake state.
const TRANSIENT_READ_FAILURE_STATUS: FailureStatus = {
  status: 503,
  code: "CODING_WORKBENCH_ISSUE_READ_TRANSIENT_FAILURE",
  message: "GitHub could not be reached (rate limit or a temporary error). Try again.",
};

type BodyRead =
  | { readonly ok: true; readonly request: CodingWorkbenchIssuePreviewRequestWire }
  | { readonly ok: false; readonly result: RouteResult };

function badRequest(correlationId: string | undefined): RouteResult {
  return {
    status: 400,
    body: errorBody("BAD_REQUEST", "Invalid issue preview request.", correlationId),
  };
}

function tooLarge(correlationId: string | undefined): RouteResult {
  return {
    status: 413,
    body: errorBody("PAYLOAD_TOO_LARGE", "Request body is too large.", correlationId),
  };
}

async function readRequest(ctx: RouteContext): Promise<BodyRead> {
  let raw: string;
  try {
    raw = await readGitDeliveryBody(ctx.req);
  } catch (error) {
    return {
      ok: false,
      result:
        error instanceof GitDeliveryBodyTooLargeError
          ? tooLarge(ctx.correlationId)
          : badRequest(ctx.correlationId),
    };
  }
  if (Buffer.byteLength(raw, "utf8") > ISSUE_PREVIEW_MAX_BODY_BYTES) {
    return { ok: false, result: tooLarge(ctx.correlationId) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, result: badRequest(ctx.correlationId) };
  }
  const request = parseCodingWorkbenchIssuePreviewRequest(parsed);
  return request === undefined
    ? { ok: false, result: badRequest(ctx.correlationId) }
    : { ok: true, request };
}

// Same rule as the GitHub-authorization routes: a registered project, resolved to its canonical
// root. A registered path whose directory is gone has no root to bind to and is refused the same
// way an unregistered one is.
function registeredCanonicalRoot(deps: UiHandlerDeps, path: string): string | undefined {
  if (!deps.store.listProjects().some((project) => project.path === path)) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function unknownRepository(correlationId: string | undefined): RouteResult {
  return {
    status: 409,
    body: errorBody(
      "UNKNOWN_REPOSITORY",
      "Open the repository before previewing an issue for it.",
      correlationId,
    ),
  };
}

function redactedPreview(
  deps: UiHandlerDeps,
  preview: CodingWorkbenchIssuePreview,
): CodingWorkbenchIssuePreview {
  const redactText = (value: string): string => {
    const redacted = deps.redactor(value);
    // The redactor maps a string to a string; anything else means it did not, and untrusted text
    // that did not pass through it does not reach the browser.
    return typeof redacted === "string" ? redacted : "";
  };
  return {
    ...preview,
    title: redactText(preview.title),
    bodyExcerpt: redactText(preview.bodyExcerpt),
    ...(preview.comments === undefined ? {} : { comments: preview.comments.map(redactText) }),
  };
}

function failureResult(
  failure: CodingWorkbenchIssueBindingFailure,
  failureReason: GitHubIssueResolutionReason | undefined,
  correlationId: string | undefined,
): RouteResult {
  const mapped =
    failureReason === "read-transient-failure"
      ? TRANSIENT_READ_FAILURE_STATUS
      : FAILURE_STATUSES[failure];
  const body: CodingWorkbenchIssuePreviewFailureWire = {
    failure,
    error: errorBody(mapped.code, mapped.message, correlationId).error,
  };
  return { status: mapped.status, body };
}

function recordPreview(
  deps: UiHandlerDeps,
  correlationId: string | undefined,
  outcome: CodingWorkbenchIssueBindingFailure | "resolved",
  status: number,
  detail: { readonly issueNumber?: number | undefined; readonly repositoryId?: string | undefined },
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    level: "info",
    category: "http",
    op: "coding-workbench.issue.previewed",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    status,
    extra: {
      outcome,
      ...(detail.issueNumber === undefined ? {} : { issueNumber: detail.issueNumber }),
      ...(detail.repositoryId === undefined ? {} : { repositoryId: detail.repositoryId }),
    },
  });
}

function upstreamFailure(deps: UiHandlerDeps, ctx: RouteContext, error: unknown): RouteResult {
  const correlationId = ctx.correlationId ?? randomUUID();
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "coding-workbench.issue.preview",
      source: "coding-context.handleCodingWorkbenchIssuePreview",
      error,
      redact: (): string => "The server operation failed.",
    }),
  );
  return {
    status: 502,
    body: errorBody(
      "CODING_WORKBENCH_ISSUE_PREVIEW_FAILED",
      "Issue preview failed.",
      correlationId,
    ),
  };
}

/**
 * Build the handler around one resolver. Production mounts `handleCodingWorkbenchIssuePreview`;
 * a test binds a resolver double and asserts the route's own guards and mapping.
 */
export function createCodingWorkbenchIssuePreviewHandler(
  resolver: GitHubIssueResolver = resolveGitHubIssue,
): (ctx: RouteContext, deps: UiHandlerDeps) => Promise<RouteResult> {
  return async (ctx, deps): Promise<RouteResult> => {
    if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
      return failureResult("authority-denied", undefined, ctx.correlationId);
    }
    const read = await readRequest(ctx);
    if (!read.ok) return read.result;
    const repositoryRoot = registeredCanonicalRoot(deps, read.request.repositoryPath);
    if (repositoryRoot === undefined) return unknownRepository(ctx.correlationId);
    const cancellation = createRequestCancellation(ctx, "issue-preview-cancelled");
    let resolution;
    try {
      resolution = await resolver(deps, {
        repositoryRoot,
        issueRef: read.request.issueRef,
        correlationId: ctx.correlationId,
        signal: cancellation.signal,
      });
    } catch (error) {
      return upstreamFailure(deps, ctx, error);
    } finally {
      cancellation.dispose();
    }
    if (!resolution.ok) {
      const result = failureResult(resolution.failure, resolution.failureReason, ctx.correlationId);
      recordPreview(deps, ctx.correlationId, resolution.failure, result.status, {});
      return result;
    }
    const { binding } = resolution;
    const body: CodingWorkbenchIssuePreviewResponseWire = {
      preview: redactedPreview(deps, resolution.preview),
      binding: {
        repositoryId: binding.repositoryId,
        remoteDigest: binding.remoteDigest,
        issueNumber: binding.issueNumber,
        issueIdDigest: binding.issueIdDigest,
        defaultBaseRef: binding.defaultBaseRef,
        bindingDigest: binding.bindingDigest,
      },
    };
    recordPreview(deps, ctx.correlationId, "resolved", 200, {
      issueNumber: binding.issueNumber,
      repositoryId: binding.repositoryId,
    });
    return { status: 200, body };
  };
}

export const handleCodingWorkbenchIssuePreview: RouteHandler =
  createCodingWorkbenchIssuePreviewHandler();
