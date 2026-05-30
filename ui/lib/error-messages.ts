/**
 * Maps BFF ApiError.code values from the projects endpoint to human-readable UI labels.
 * Falls back to the verbatim ApiError.message for unknown codes.
 * No stack trace exposure — ApiError already strips traces.
 */

const PROJECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
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
