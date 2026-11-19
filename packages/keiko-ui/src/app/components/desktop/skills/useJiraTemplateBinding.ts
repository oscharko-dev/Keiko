import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { bindJiraTemplate, type JiraTemplateEntry } from "@/lib/jira-templates-api";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import type { SkillWorkspace } from "./useSkillWorkspace";

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
/**
 * An outcome belongs to one Jira Pod, one skill and one revision: a result for another selection is
 * never shown on this one (a late answer of a superseded Pod settles under its own key).
 */
export function bindOutcomeKey(
  podId: string | undefined,
  entry: Pick<JiraTemplateEntry, "id" | "revision">,
): string {
  return `${podId ?? ""}:${entry.id}:${String(entry.revision)}`;
}

export function useJiraTemplateBinding(
  podId: string | undefined,
  library: MarkdownSkillLibrary,
  adoptBinding?: SkillWorkspace["adoptBinding"],
): {
  /** Keyed by `bindOutcomeKey`. */
  readonly outcomes: ReadonlyMap<string, BindOutcome>;
  /** `migrate` is the person's explicit choice to replace a binding another Jira owns. */
  readonly bind: (entry: JiraTemplateEntry, migrate?: boolean) => Promise<void>;
} {
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, BindOutcome>>(new Map());
  const bind = useCallback(
    async (entry: JiraTemplateEntry, migrate?: boolean): Promise<void> => {
      if (podId === undefined) return;
      const correlationId = newClientCorrelationId();
      const settle = (outcome: BindOutcome): void =>
        setOutcomes((current) => new Map(current).set(bindOutcomeKey(podId, entry), outcome));
      settle("working");
      try {
        const bound =
          migrate === true
            ? await bindJiraTemplate(podId, entry.id, entry.revision, correlationId, true)
            : await bindJiraTemplate(podId, entry.id, entry.revision, correlationId);
        settle({ issueType: bound.issueType, parentTypeCount: bound.parentTypeCount ?? 0 });
        if (bound.skill !== undefined) adoptBinding?.(entry.revision, bound.skill);
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
    [podId, library, adoptBinding],
  );
  return { outcomes, bind };
}

/**
 * Binds every template whose check offers it, once per saved revision and Pod (#4354): a lead who saves a
 * template does not also have to find a button. A refusal shows the server's sentence on the row; the
 * button stays as a re-check.
 */
export function useAutomaticTemplateBinding(
  bind: (entry: JiraTemplateEntry) => Promise<void>,
  pending: readonly JiraTemplateEntry[],
  podId: string | undefined,
): void {
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    // Without a ready Pod nothing is attempted and nothing is marked: the revision is bound when one appears.
    if (podId === undefined) return;
    for (const entry of pending) {
      const key = `${podId}:${entry.id}:${String(entry.revision)}`;
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      void bind(entry);
    }
  }, [bind, pending, podId]);
}
