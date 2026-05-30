/**
 * Maps BFF ApiError.code values from the workspace endpoint to human-readable UI labels.
 * Falls back to a generic message for unknown codes — the BFF's verbatim message can
 * contain filesystem paths or byte sizes from WorkspaceError constructors, which the UI
 * deliberately does not surface.
 */

const WORKSPACE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  WORKSPACE_NOT_FOUND: "The project directory could not be found.",
  WORKSPACE_PATH_DENIED: "Access to this directory is not permitted.",
  WORKSPACE_PATH_ESCAPE: "The requested path is outside the permitted workspace.",
  WORKSPACE_READ_FAILED: "Could not read the workspace. Check that the path exists and is accessible.",
  WORKSPACE_FILE_TOO_LARGE: "A file in this workspace is too large to index.",
  BAD_REQUEST: "The workspace request was invalid.",
  INTERNAL: "An internal error occurred while loading the workspace.",
};

const GENERIC_WORKSPACE_ERROR = "An unexpected workspace error occurred.";

export function workspaceErrorMessage(code: string): string {
  return WORKSPACE_ERROR_MESSAGES[code] ?? GENERIC_WORKSPACE_ERROR;
}
