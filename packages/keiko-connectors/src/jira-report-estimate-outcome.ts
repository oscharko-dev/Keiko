import type { JiraReportAlternateEstimate } from "./jira-report-estimate.js";
import type { JiraReportIssue, JiraReportScope } from "./jira-report-types.js";

const FALLBACK_FIELD_SOURCES = {
  seconds: "time-tracking-fallback",
  "custom-field": "field-fallback",
} as const;

function sumOf(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6;
}

/**
 * What the estimate figures are once every issue is read (#4356). The configured field stays the
 * figure whenever one issue holds a value in it. A report never states zero for a field while
 * another estimate field in use holds values without saying so: when the configured field holds
 * none and the alternate does, the alternate is the figure and the configured field is named as
 * unused; when both hold values the alternate is named beside the figure. An explicit field the
 * caller chose is never replaced, only accompanied.
 */
export function jiraReportEstimateOutcome(
  issues: readonly JiraReportIssue[],
  scope: JiraReportScope,
  alternate: JiraReportAlternateEstimate | undefined,
): { readonly issues: readonly JiraReportIssue[]; readonly scope: JiraReportScope } {
  const held = issues.flatMap((issue) =>
    issue.alternateEstimate === undefined ? [] : [issue.alternateEstimate],
  );
  if (alternate === undefined || held.length === 0 || scope.estimateUnit === "unavailable")
    return { issues, scope };
  const configured = {
    fieldId: scope.estimateFieldId ?? "",
    fieldName: scope.estimateFieldName ?? scope.estimateFieldId ?? "",
    unit: scope.estimateUnit,
  };
  const primaryHolds = issues.some((issue) => issue.estimate !== undefined);
  if (primaryHolds || scope.estimateSource === "explicit-field")
    return {
      issues,
      scope: {
        ...scope,
        estimateAlso: {
          fieldId: alternate.id,
          fieldName: alternate.name,
          unit: alternate.unit,
          issues: held.length,
          total: sumOf(held),
        },
      },
    };
  return {
    issues: issues.map(({ estimateNotCarried: _carried, alternateEstimate, ...issue }) => ({
      ...issue,
      estimate: alternateEstimate,
    })),
    scope: {
      ...scope,
      estimateFieldId: alternate.id,
      estimateFieldName: alternate.name,
      estimateUnit: alternate.unit,
      estimateSource: FALLBACK_FIELD_SOURCES[alternate.unit],
      estimateConfigured: configured,
    },
  };
}
