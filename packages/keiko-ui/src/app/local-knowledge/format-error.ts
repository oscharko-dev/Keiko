// Shared error formatting for Local Knowledge surfaces (uiux-fix F033, C064).
// Previously five components each duplicated a local formatError that rendered
// `${err.code}: ${err.message}` into role="alert" regions, so users saw raw
// machine strings like "LK_VALIDATION: …" or "INTERNAL: HTTP 500". The message
// now comes first; the technical code is appended in parentheses so support and
// audit can still identify the failure (same pattern as memoriaviva/format-error).

import { ApiError } from "@/lib/api";
import { translateLocalKnowledge, type I18nTranslate } from "./local-knowledge-i18n";

const fallbackTranslate: I18nTranslate = (key, values) =>
  translateLocalKnowledge("en", key, values);

export function formatError(error: unknown, t: I18nTranslate = fallbackTranslate): string {
  if (error instanceof ApiError) {
    if (error.message.trim().length > 0) return `${error.message} (${error.code})`;
    return t("localKnowledge.error.api", { code: error.code });
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return t("localKnowledge.error.unexpected");
}
