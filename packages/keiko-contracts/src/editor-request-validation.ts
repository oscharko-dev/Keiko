import {
  buildContextSelectors,
  collectEditorSessionIdError,
  isBoundedEditorSessionId,
  isNonEmptyString,
  isRecord,
} from "./coding-context.js";
import { isLanguageDocumentOverlay, isLanguagePosition } from "./language-service.js";

export interface CapturedEditorRequestCore {
  readonly root: unknown;
  readonly contextBudgetBytes: unknown;
  readonly editorSessionId?: unknown;
  readonly context?: ReturnType<typeof buildContextSelectors>;
}

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

export function captureEditorRequestIdentity(value: Record<string, unknown>): {
  readonly root: unknown;
  readonly editorSessionId?: unknown;
} {
  return {
    root: value.root,
    ...(isBoundedEditorSessionId(value.editorSessionId)
      ? { editorSessionId: value.editorSessionId }
      : {}),
  };
}

export function admitEditorRequestForCapture(
  value: unknown,
  collectRequestErrors: (value: Record<string, unknown>) => string[],
):
  | { readonly ok: false; readonly errors: readonly string[] }
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
      readonly context: ReturnType<typeof buildContextSelectors> | undefined;
    } {
  if (!isRecord(value)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = collectRequestErrors(value);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const context = isRecord(value.context) ? buildContextSelectors(value.context) : undefined;
  return { ok: true, value, context };
}

function copyCapturedEditorRequestFields(
  value: CapturedEditorRequestCore,
): Record<string, unknown> {
  return { ...value };
}

export function finalizeCapturedEditorRequest<
  Captured extends CapturedEditorRequestCore,
  Validated extends Captured,
>(
  request: Captured,
  isComplete: (value: Captured) => value is Validated,
  collectRequestErrors: (value: Record<string, unknown>) => string[],
):
  | { readonly ok: true; readonly value: Validated }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (!isComplete(request)) {
    return { ok: false, errors: collectRequestErrors(copyCapturedEditorRequestFields(request)) };
  }
  return { ok: true, value: request };
}
