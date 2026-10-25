import { collectEditorSessionIdError, isNonEmptyString } from "./coding-context.js";
import { isLanguageDocumentOverlay, isLanguagePosition } from "./language-service.js";

export function collectEditorDocumentRequestErrors(
  value: Record<string, unknown>,
  errors: string[],
): void {
  if (!isNonEmptyString(value.root)) {
    errors.push("root must be a non-empty string");
  }
  collectEditorSessionIdError(value.editorSessionId, errors);
  if (!isLanguageDocumentOverlay(value.document)) {
    errors.push("document must be { path, languageId, text }");
  }
  if (!isLanguagePosition(value.position)) {
    errors.push("position must be { line, character }");
  }
}
