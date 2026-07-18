// Shared request-preparation prologue for the governed remote Git delivery routes that resolve a
// project workspace (publish #476, pull request #477, merge #478). Each of those route groups opened
// BOTH its preview and execute handler with the same three steps: read + JSON-parse the bounded body,
// validate it, then authorize the project workspace — differing only in the typed error envelope and
// the per-route validator. This module is the single home for that prologue so the handlers never
// re-duplicate it.
//
// The sync (#479), commit, and local-mutation routes take a different handler shape (a mode / spec
// parameter) and share only the lower-level readParsedGitDeliveryBody guard, not this scaffold.

import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { resolveProjectWorkspace } from "./execution.js";
import { readParsedGitDeliveryBody } from "./requestGuards.js";

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
