import { describe, expect, it } from "vitest";
import { workspaceErrorMessage } from "./workspace-error-messages";

describe("workspaceErrorMessage", () => {
  it("maps known workspace error codes to path-safe UI copy", () => {
    expect(workspaceErrorMessage("WORKSPACE_NOT_FOUND")).toBe(
      "The project directory could not be found.",
    );
    expect(workspaceErrorMessage("WORKSPACE_PATH_DENIED")).toBe(
      "Access to this directory is not permitted.",
    );
    expect(workspaceErrorMessage("WORKSPACE_PATH_ESCAPE")).toBe(
      "The requested path is outside the permitted workspace.",
    );
    expect(workspaceErrorMessage("WORKSPACE_READ_FAILED")).toBe(
      "Could not read the workspace. Check that the path exists and is accessible.",
    );
    expect(workspaceErrorMessage("WORKSPACE_FILE_TOO_LARGE")).toBe(
      "A file in this workspace is too large to index.",
    );
    expect(workspaceErrorMessage("BAD_REQUEST")).toBe("The workspace request was invalid.");
    expect(workspaceErrorMessage("INTERNAL")).toBe(
      "An internal error occurred while loading the workspace.",
    );
  });

  it("uses a generic fallback for unknown codes instead of exposing backend details", () => {
    expect(workspaceErrorMessage("SOME_PATH_HEAVY_BACKEND_ERROR")).toBe(
      "An unexpected workspace error occurred.",
    );
  });
});
