import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import { atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeAtlassianWriteRequest } from "./atlassian-write-http.js";

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
  readonly getRecord: (path: string) => Promise<JiraReportRecordRead>;
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

export function createJiraReportHttp(deps: JiraReportHttpDeps): JiraReportHttp {
  const endpoints = atlassianApiEndpointsFor(deps.baseUrl, "/rest/api/2/");
  const transport = {
    signal: deps.signal,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    http: (request: Parameters<AtlassianHttpBodyPort>[0]): ReturnType<AtlassianHttpBodyPort> =>
      deps.signal.aborted || !deps.beforeEffect()
        ? Promise.resolve({ kind: "network-error" })
        : deps.http(request),
  };
  return {
    getRecord: async (path): Promise<JiraReportRecordRead> => {
      const outcome = await executeAtlassianWriteRequest(transport, {
        method: "GET",
        url: atlassianApiUrl(endpoints, path),
        expect: "json",
      });
      return outcome.ok && outcome.body !== undefined
        ? { ok: true, body: outcome.body }
        : { ok: false, reason: outcome.ok ? "malformed-payload" : outcome.reason };
    },
    getArray: async (path): Promise<JiraReportArrayRead> => {
      const outcome = await executeAtlassianWriteRequest(transport, {
        method: "GET",
        url: atlassianApiUrl(endpoints, path),
        expect: "json-array",
      });
      return outcome.ok && outcome.items !== undefined
        ? { ok: true, items: outcome.items }
        : { ok: false, reason: outcome.ok ? "malformed-payload" : outcome.reason };
    },
  };
}
