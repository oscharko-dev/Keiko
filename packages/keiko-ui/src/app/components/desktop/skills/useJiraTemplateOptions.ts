import { useEffect, useMemo, useReducer, useState } from "react";
import type {
  JiraTemplateOptions,
  JiraTemplateOptionsRequest,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { fetchJiraTemplateOptions } from "@/lib/jira-templates-api";

/**
 * A project key can come from text the person is still typing, so a read for a project waits until
 * the key has stayed the same this long; only the key that settles reaches Jira.
 */
export const JIRA_TEMPLATE_OPTIONS_SETTLE_MS = 300;

type ReadOutcome =
  | { readonly state: "idle" | "loading" | "missing" | "failed" }
  | { readonly state: "ready"; readonly options: JiraTemplateOptions };

export type JiraOptionsRead = ReadOutcome & { readonly retry: () => void };

async function read(selection: JiraTemplateOptionsRequest): Promise<ReadOutcome> {
  const correlationId = newClientCorrelationId();
  try {
    return { state: "ready", options: await fetchJiraTemplateOptions(selection, correlationId) };
  } catch (error) {
    // A project this Jira does not know is an answer, not a failure; the server records the read.
    if (error instanceof ApiError && error.status === 404) return { state: "missing" };
    reportClientDiagnostic("Jira template options could not be loaded.", {
      correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return { state: "failed" };
  }
}

function selectionFor(
  podId: string | undefined,
  projectKey: string | undefined,
  issueTypeId: string | undefined,
): JiraTemplateOptionsRequest | undefined {
  if (podId === undefined) return undefined;
  if (projectKey === undefined) return { podId };
  return issueTypeId === undefined ? { podId, projectKey } : { podId, projectKey, issueTypeId };
}

/** A result belongs to a particular Pod, selection and read attempt, even when a selection repeats. */
export function useJiraTemplateOptions(
  podId: string | undefined,
  projectKey?: string,
  issueTypeId?: string,
): JiraOptionsRead {
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const scope = useMemo(
    () => ({ selection: selectionFor(podId, projectKey, issueTypeId), attempt }),
    [podId, projectKey, issueTypeId, attempt],
  );
  const [result, setResult] = useState<{ scope: typeof scope; outcome: ReadOutcome }>();
  useEffect(() => {
    const { selection } = scope;
    if (selection === undefined) return undefined;
    let current = true;
    const start = (): void => {
      void read(selection).then((outcome) => {
        if (current) setResult({ scope, outcome });
      });
    };
    const timer =
      selection.projectKey === undefined
        ? undefined
        : setTimeout(start, JIRA_TEMPLATE_OPTIONS_SETTLE_MS);
    if (timer === undefined) start();
    return (): void => {
      current = false;
      clearTimeout(timer);
    };
  }, [scope]);
  if (scope.selection === undefined) return { state: "idle", retry };
  return result?.scope === scope ? { ...result.outcome, retry } : { state: "loading", retry };
}
