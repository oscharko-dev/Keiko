import { useState } from "react";
import { ApiError } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { bindJiraTemplate, type JiraTemplateEntry } from "@/lib/jira-templates-api";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";

/** The outcome of one bind request, shown on the template's row until the library reloads. */
export type BindOutcome =
  | "working"
  | "failed"
  | "refused"
  | { readonly issueType: string; readonly parentTypeCount: number };

/** 422: the typed name is not exactly one issue type of this Jira; anything else is a failure. */
function failedOutcome(error: unknown): BindOutcome {
  return error instanceof ApiError && error.status === 422 ? "refused" : "failed";
}

/**
 * Binds a stored template to the issue types of the chosen Jira (#4354): the server writes the ids
 * into the template as a new revision, and the library reloads so the check runs on that revision.
 */
export function useJiraTemplateBinding(
  podId: string | undefined,
  library: MarkdownSkillLibrary,
): {
  readonly outcomes: ReadonlyMap<string, BindOutcome>;
  readonly bind: (entry: JiraTemplateEntry) => Promise<void>;
} {
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, BindOutcome>>(new Map());
  const bind = async (entry: JiraTemplateEntry): Promise<void> => {
    if (podId === undefined) return;
    const correlationId = newClientCorrelationId();
    const settle = (outcome: BindOutcome): void =>
      setOutcomes((current) => new Map(current).set(entry.id, outcome));
    settle("working");
    try {
      const bound = await bindJiraTemplate(podId, entry.id, entry.revision, correlationId);
      settle({ issueType: bound.issueType, parentTypeCount: bound.parentTypeCount ?? 0 });
      await library.refresh();
    } catch (error) {
      settle(failedOutcome(error));
      reportClientDiagnostic("Jira template binding failed.", {
        correlationId,
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
    }
  };
  return { outcomes, bind };
}
