import { useCallback, useEffect, useRef, useState } from "react";
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
  /** 422: the server's own plain sentence about the typed name; it names the template and both ways out. */
  | { readonly refused: string }
  | { readonly issueType: string; readonly parentTypeCount: number };

/** 422: the typed name is not exactly one issue type of this Jira; anything else is a failure. */
function failedOutcome(error: unknown): BindOutcome {
  return error instanceof ApiError && error.status === 422 ? { refused: error.message } : "failed";
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
  const bind = useCallback(
    async (entry: JiraTemplateEntry): Promise<void> => {
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
    },
    [podId, library],
  );
  return { outcomes, bind };
}

/**
 * Binds every template whose check offers it, once per saved revision (#4354): a lead who saves a
 * template does not also have to find a button. A refusal shows the server's sentence on the row; the
 * button stays as a re-check.
 */
export function useAutomaticTemplateBinding(
  bind: (entry: JiraTemplateEntry) => Promise<void>,
  pending: readonly JiraTemplateEntry[],
): void {
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of pending) {
      const key = `${entry.id}:${String(entry.revision)}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      void bind(entry);
    }
  }, [bind, pending]);
}
