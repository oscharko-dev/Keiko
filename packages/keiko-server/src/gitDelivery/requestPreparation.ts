// Shared request-preparation prologue for the governed Git delivery routes that resolve a project
// workspace (publish #476, pull request #477, merge #478, and the fetch/pull sync routes). Each of
// those route groups opens BOTH its preview and execute handler with the same three steps: read +
// JSON-parse the bounded body, validate it, then authorize the project workspace — differing only in
// the typed error envelope and the per-route validator. This module is the single home for that
// prologue so the handlers never re-duplicate it.
//
// The commit, local-mutation, and agent-operations routes take a different handler shape (a spec or
// composite-dispatch parameter) and share only the lower-level readParsedGitDeliveryBody guard, not
// this scaffold.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { GitRepositoryAgentOperationKind } from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import { resolveProjectWorkspace } from "./execution.js";
import { readParsedGitDeliveryBody } from "./requestGuards.js";
import { authorizeGitDelivery } from "./runBoundAuthority.js";

// The validator each route already exposes: it maps an unknown parsed body to either a typed request
// value (carrying the projectId) or a ready-to-return error result.
export type GitDeliveryValidation<V> =
  | { readonly kind: "ok"; readonly value: V }
  | { readonly kind: "err"; readonly result: RouteResult };

// The three route-specific error envelopes the prologue can return, pre-built by the caller so this
// module stays agnostic of each route's error-code union.
export interface GitDeliveryRequestErrors {
  readonly tooLarge: RouteResult;
  readonly badRequest: RouteResult;
  readonly unknownProject: RouteResult;
}

export type PreparedGitDeliveryRequest<V> =
  | { readonly ok: true; readonly value: V; readonly workspace: WorkspaceInfo }
  | { readonly ok: false; readonly result: RouteResult };

export interface GitDeliveryAuthorityTarget {
  readonly headBranchName?: string | undefined;
  readonly baseBranchName?: string | undefined;
}

/**
 * Applies the sole delivery-write admission decision after a project workspace has been resolved.
 * This intentionally consumes only the live server-owned runtime authority; headers, browser state,
 * and deployment defaults cannot grant access here.
 */
export function gitDeliveryAuthorityDenial(
  ctx: RouteContext,
  deps: Pick<UiHandlerDeps, "gitDeliveryAuthority">,
  projectId: string,
  workspace: WorkspaceInfo,
  operation: GitRepositoryAgentOperationKind,
  target: GitDeliveryAuthorityTarget = {},
): RouteResult | undefined {
  const decision = authorizeGitDelivery(
    deps.gitDeliveryAuthority,
    { projectId, workspaceRoot: workspace.root, operation, ...target },
    new Date().toISOString(),
  );
  processServerLogSink().write({
    category: "security",
    op: decision.allowed ? "git.delivery.authority.admitted" : "git.delivery.authority.denied",
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status: decision.allowed ? 200 : 403,
    extra: {
      operation,
      ...(decision.allowed ? { runId: decision.runId } : { reason: decision.reason }),
    },
  });
  if (decision.allowed) return undefined;
  return {
    status: 403,
    body: {
      error: {
        code: "GIT_DELIVERY_AUTHORITY_DENIED",
        message: "The accepted runtime authority does not admit this Git delivery operation.",
      },
    },
  };
}

// Runs the shared read → validate → resolve-workspace prologue. Returns the validated request value
// together with its authorized workspace, or the first typed error result encountered. `V` must carry
// the `projectId` the workspace is resolved (and authorized) from.
export const prepareGitDeliveryRequest = async <V extends { readonly projectId: string }>(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  errors: GitDeliveryRequestErrors,
  validate: (parsed: unknown) => GitDeliveryValidation<V>,
): Promise<PreparedGitDeliveryRequest<V>> => {
  const read = await readParsedGitDeliveryBody(
    ctx.req,
    () => errors.tooLarge,
    () => errors.badRequest,
  );
  if (!read.ok) return { ok: false, result: read.result };
  const validation = validate(read.value);
  if (validation.kind === "err") return { ok: false, result: validation.result };
  const workspace = resolveProjectWorkspace(deps, validation.value.projectId);
  if (workspace === undefined) return { ok: false, result: errors.unknownProject };
  return { ok: true, value: validation.value, workspace };
};
