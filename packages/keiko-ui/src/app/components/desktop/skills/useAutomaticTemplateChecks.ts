import { useEffect, useState } from "react";
import {
  validateJiraTemplate,
  type JiraTemplateEntry,
  type JiraTemplateValidation,
} from "@/lib/jira-templates-api";
import { readMarkdownSkill } from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { bffRequestErrorKind } from "@/lib/http";

export function templateKey(entry: Pick<JiraTemplateEntry, "id" | "revision">): string {
  return `${entry.id}:${String(entry.revision)}`;
}

async function checkStoredTemplate(
  podId: string,
  entry: JiraTemplateEntry,
  isCurrent: () => boolean,
): Promise<JiraTemplateValidation | undefined> {
  const correlationId = newClientCorrelationId();
  reportClientDiagnostic("Jira template validation started.", { correlationId });
  try {
    const skill = await readMarkdownSkill(
      { id: entry.id, revision: entry.revision, digest: "" },
      correlationId,
    );
    // A superseded check sends nothing more to Jira: its body may already be a stale revision.
    if (!isCurrent()) {
      reportClientDiagnostic("Jira template validation superseded.", { correlationId });
      return undefined;
    }
    const result = await validateJiraTemplate(podId, skill.body, correlationId);
    reportClientDiagnostic("Jira template validation completed.", { correlationId });
    return result;
  } catch (error) {
    reportClientDiagnostic("Jira template request failed.", {
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return undefined;
  }
}

/** The outcome of one automatic check: Jira's answer, or that the check itself could not run. */
export type AutomaticTemplateCheck = JiraTemplateValidation | "failed";

const EMPTY_CHECKS: ReadonlyMap<string, AutomaticTemplateCheck> = new Map();

interface Checks {
  readonly key: string;
  readonly results: ReadonlyMap<string, AutomaticTemplateCheck>;
}

/**
 * A project lead learns at once when a stored template names a project, issue type or field the
 * selected Jira does not have (#4173 AC1): such a template never governs a write, and before this
 * nothing said so unless someone pressed "Validate" on each row.
 */
export function useAutomaticTemplateChecks(
  podId: string | undefined,
  templates: readonly JiraTemplateEntry[],
): ReadonlyMap<string, AutomaticTemplateCheck> {
  const [checks, setChecks] = useState<Checks>();
  const valid = templates.filter((entry) => entry.valid);
  const key = `${podId ?? ""}|${valid.map(templateKey).join(",")}`;
  useEffect(() => {
    if (podId === undefined || valid.length === 0) return undefined;
    let current = true;
    const results = new Map<string, AutomaticTemplateCheck>();
    const run = async (): Promise<void> => {
      for (const entry of valid) {
        const result = await checkStoredTemplate(podId, entry, () => current); // NOSONAR typescript:S9382 -- one Jira read at a time
        if (!current) return;
        results.set(templateKey(entry), result ?? "failed");
        setChecks({ key, results: new Map(results) });
      }
    };
    void run();
    return (): void => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the Pod and every listed revision
  }, [key]);
  return checks?.key === key ? checks.results : EMPTY_CHECKS;
}
