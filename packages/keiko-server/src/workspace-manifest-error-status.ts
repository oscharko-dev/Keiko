// KEIKO-0622: HTTP status mapping for WorkspaceManifestErrorCode, extracted into its own
// module so unit tests can import it without dragging the route-group circular import in
// workspace-manifest-routes.ts through routes.ts.

import { WorkspaceManifestError, type WorkspaceManifestErrorCode } from "./workspace-manifests.js";

/**
 * Maps every WorkspaceManifestErrorCode to a deliberate HTTP status, grouped by status so the
 * codes that share a response class (the 409s, the 422s, ...) read together. A `Record` keyed by
 * the full union is exhaustive at the type level: TypeScript requires every member of
 * WorkspaceManifestErrorCode to have an entry, so a new union member fails `npm run typecheck` if
 * this mapping is not updated in the same change (KEIKO-0622) -- the switch statement this
 * replaced used a never-typed default for the same guarantee. Previously an if-chain silently
 * defaulted seven codes to 409.
 */
const WORKSPACE_MANIFEST_ERROR_STATUS: Record<WorkspaceManifestErrorCode, number> = {
  // 404 Not Found
  WORKSPACE_MANIFEST_UNAVAILABLE: 404,
  WORKSPACE_PROJECT_NOT_FOUND: 404,
  // 403 Forbidden
  WORKSPACE_ROOT_NOT_MEMBER: 403,
  // 400 Bad Request
  WORKSPACE_DISPATCH_INVALID: 400,
  // 409 Conflict
  WORKSPACE_DISPATCH_STALE: 409,
  WORKSPACE_REVISION_CONFLICT: 409,
  WORKSPACE_ROOT_IDENTITY_CHANGED: 409,
  WORKSPACE_ROOT_ALREADY_BOUND: 409,
  // 422 Unprocessable Entity
  WORKSPACE_ROOT_LIMIT_REACHED: 422,
  WORKSPACE_LAST_ROOT: 422,
  WORKSPACE_ROOT_SET_INVALID: 422,
};

export function errorStatus(error: WorkspaceManifestError): number {
  return WORKSPACE_MANIFEST_ERROR_STATUS[error.code];
}
