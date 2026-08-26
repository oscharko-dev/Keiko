import { describe, expect, it } from "vitest";

import { errorStatus } from "./workspace-manifest-error-status.js";
import { WorkspaceManifestError } from "./workspace-manifests.js";
import type { WorkspaceManifestErrorCode } from "./workspace-manifests.js";

// KEIKO-0622: errorStatus is now an exhaustive switch over every WorkspaceManifestErrorCode with a
// never-typed default. These cases pin the deliberate per-code HTTP status. Before the fix, all
// seven previously-unhandled codes silently defaulted to 409 through an if-chain.
const EXPECTED: Record<WorkspaceManifestErrorCode, number> = {
  WORKSPACE_MANIFEST_UNAVAILABLE: 404,
  WORKSPACE_PROJECT_NOT_FOUND: 404,
  WORKSPACE_ROOT_NOT_MEMBER: 403,
  WORKSPACE_DISPATCH_INVALID: 400,
  WORKSPACE_DISPATCH_STALE: 409,
  WORKSPACE_REVISION_CONFLICT: 409,
  WORKSPACE_ROOT_IDENTITY_CHANGED: 409,
  WORKSPACE_ROOT_ALREADY_BOUND: 409,
  WORKSPACE_ROOT_LIMIT_REACHED: 422,
  WORKSPACE_LAST_ROOT: 422,
  WORKSPACE_ROOT_SET_INVALID: 422,
};

describe("errorStatus (KEIKO-0622)", () => {
  for (const [code, expectedStatus] of Object.entries(EXPECTED)) {
    it(`maps ${code} to ${String(expectedStatus)}`, () => {
      const error = new WorkspaceManifestError(code as WorkspaceManifestErrorCode, "test");
      expect(errorStatus(error)).toBe(expectedStatus);
    });
  }

  it("maps a currently-non-409 code (WORKSPACE_ROOT_LIMIT_REACHED) to a deliberate 422", () => {
    const error = new WorkspaceManifestError("WORKSPACE_ROOT_LIMIT_REACHED", "cap reached");
    expect(errorStatus(error)).toBe(422);
    expect(errorStatus(error)).not.toBe(409);
  });
});
