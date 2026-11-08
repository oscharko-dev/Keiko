import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeAdmittedJiraRequest } from "./jira-request-admission.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

interface JiraReportFailure {
  readonly ok: false;
  readonly reason: AtlassianConnectorWriteFailureReason;
}
export type JiraReportRecordRead =
  { readonly ok: true; readonly body: Record<string, unknown> } | JiraReportFailure;
export type JiraReportArrayRead =
  { readonly ok: true; readonly items: readonly unknown[] } | JiraReportFailure;

/** GET-only access to the Data Center REST API under the invocation's cancellation and effect guard. */
export interface JiraReportHttp {
  /** Adapter for existing native evidence binders; rejects every non-GET request. */
  readonly request: JiraMutationRequest;
  readonly getRecord: (path: string) => Promise<JiraReportRecordRead>;
  readonly getAgileRecord: (path: string) => Promise<JiraReportRecordRead>;
  readonly getArray: (path: string) => Promise<JiraReportArrayRead>;
}

export interface JiraReportHttpDeps {
  readonly baseUrl: string;
  readonly http: AtlassianHttpBodyPort;
  readonly signal: AbortSignal;
  readonly beforeEffect: () => boolean;
  /** Backoff pause between read retries; the real timer unless a test injects one. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

function recordReader(deps: JiraReportHttpDeps, apiRoot: string): JiraReportHttp["getRecord"] {
  const endpoints = atlassianApiEndpointsFor(deps.baseUrl, apiRoot);
  return async (path): Promise<JiraReportRecordRead> => {
    const outcome = await executeAdmittedJiraRequest(
      deps,
      deps,
      deps.signal,
      {
        method: "GET",
        url: atlassianApiUrl(endpoints, path),
        expect: "json",
      },
      { sleep: deps.sleep },
    );
    return outcome.ok && outcome.body !== undefined
      ? { ok: true, body: outcome.body }
      : { ok: false, reason: outcome.ok ? "malformed-payload" : outcome.reason };
  };
}

export function createJiraReportHttp(
  deps: JiraReportHttpDeps,
  evidenceAdmission: Pick<JiraReportHttpDeps, "signal" | "beforeEffect"> = deps,
): JiraReportHttp {
  const endpoints = atlassianApiEndpointsFor(deps.baseUrl, "/rest/api/2/");
  const request: JiraMutationRequest = (path, method, body, expect, upload) => {
    if (
      (method !== undefined && method !== "GET") ||
      body !== undefined ||
      upload !== undefined ||
      (expect !== undefined && expect !== "json")
    )
      return Promise.resolve({ ok: false, reason: "effect-denied" });
    return executeAdmittedJiraRequest(
      deps,
      evidenceAdmission,
      evidenceAdmission.signal,
      {
        method: "GET",
        url: atlassianApiUrl(endpoints, path),
        expect: "json",
      },
      { sleep: deps.sleep },
    );
  };
  return {
    request,
    getRecord: recordReader(deps, "/rest/api/2/"),
    getAgileRecord: recordReader(deps, "/rest/agile/1.0/"),
    getArray: async (path): Promise<JiraReportArrayRead> => {
      const outcome = await executeAdmittedJiraRequest(
        deps,
        deps,
        deps.signal,
        {
          method: "GET",
          url: atlassianApiUrl(endpoints, path),
          expect: "json-array",
        },
        { sleep: deps.sleep },
      );
      return outcome.ok && outcome.items !== undefined
        ? { ok: true, items: outcome.items }
        : { ok: false, reason: outcome.ok ? "malformed-payload" : outcome.reason };
    },
  };
}
