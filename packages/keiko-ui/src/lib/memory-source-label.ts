import type { OptionalWidgetTranslate } from "./optional-widget-i18n";

// Where a memory came from, as a person says it rather than the policy code (#4206). A kind a newer
// server adds reads as Keiko's own.
export function sourceKindLabel(sourceKind: string, t: OptionalWidgetTranslate): string {
  switch (sourceKind) {
    case "explicit-user-instruction":
      return t("memoria.source.explicit");
    case "accepted-correction":
      return t("memoria.source.correction");
    case "workflow-outcome":
      return t("memoria.source.workflow");
    case "consolidation":
      return t("memoria.source.consolidation");
    case "system-default":
      return t("memoria.source.learned");
    default:
      return t("memoria.source.keiko");
  }
}
