/**
 * Maps BFF ApiError.code values from the projects endpoint to human-readable UI labels.
 * Falls back to the verbatim ApiError.message for unknown codes.
 * No stack trace exposure — ApiError already strips traces.
 *
 * GEN-DUP-SEMANTIC-018 — the BFF store error codes were normalized to the dominant
 * SCREAMING_SNAKE_CASE wire convention. This table is intentionally DUAL-KEYED: it accepts
 * BOTH the new SCREAMING codes and the legacy snake_case codes so a server/UI deploy in
 * either order (or a cached/older server) still resolves the friendly label. Both spellings
 * map to the identical message, so behavior is unchanged for every real code.
 */

const PROJECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // New SCREAMING_SNAKE_CASE wire codes (current server).
  INVALID_PATH: "Path is not a valid absolute local directory.",
  PATH_NOT_DIRECTORY: "That path exists but is not a directory.",
  PATH_NOT_FOUND: "No directory exists at that path.",
  PROJECT_EXISTS: "This project is already in your sidebar.",
  INVALID_REQUEST: "Could not validate that request.",
  PAYLOAD_TOO_LARGE: "Path is too long.",
  // Legacy snake_case codes (older server / deploy-order safety). Same messages.
  invalid_path: "Path is not a valid absolute local directory.",
  path_not_directory: "That path exists but is not a directory.",
  path_not_found: "No directory exists at that path.",
  project_exists: "This project is already in your sidebar.",
  invalid_request: "Could not validate that request.",
  payload_too_large: "Path is too long.",
};

export function projectErrorMessage(code: string, fallbackMessage: string): string {
  return PROJECT_ERROR_MESSAGES[code] ?? fallbackMessage;
}
