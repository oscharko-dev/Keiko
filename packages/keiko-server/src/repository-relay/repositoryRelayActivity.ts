import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS,
  activityActionFields,
  activityStateLevel,
  type ActivityActionLine,
  type ActivityCountFields,
} from "../activity-line-fields.js";

/**
 * What the repository credential relay (#4522) records on the Activity Log: its binding, every
 * refusal and failure, and one `settled` summary per binding when its run is released. A build
 * fetches thousands of files, so a relayed request is counted in that summary and never written as
 * a line of its own. Closed values and counts only; never a URL, host, path, artifact coordinate,
 * user name or credential.
 */
export const REPOSITORY_RELAY_METHODS = ["GET", "HEAD"] as const;
export type RepositoryRelayMethod = (typeof REPOSITORY_RELAY_METHODS)[number];

const ACTIONS = ["bind", "request", "release"] as const;
const OUTCOMES = ["bound", "refused", "failed", "settled"] as const;
export type RepositoryRelayOutcome = (typeof OUTCOMES)[number];

const REASONS = [
  "origin-not-allowed",
  "capability-missing",
  "capability-invalid",
  "binding-revoked",
  "method-not-allowed",
  "query-refused",
  "path-invalid",
  "path-too-long",
  "path-unsupported",
  "budget-exhausted",
  "redirect-refused",
  "response-too-large",
  "upstream-failed",
  "upstream-rejected",
  "content-encoding-refused",
  "packument-invalid",
  "credential-in-response",
  "credential-in-response-header",
  "credential-spelling-unbounded",
  "url-unsupported",
  "url-userinfo",
  "url-own-origin",
  "secret-invalid",
  "secret-too-short",
  "bindings-exhausted",
  "run-aborted",
  "relay-unavailable",
] as const;
export type RepositoryRelayReason = (typeof REASONS)[number];

const OPTIONAL_COUNT = { type: "integer", dataClass: "count", required: false } as const;

const REPOSITORY_RELAY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.repository-relay",
  category: "security",
  owner: "keiko-server",
  emitter: "repository-relay.repositoryRelayActivity.recordRepositoryRelay",
  fields: {
    action: { type: "string", dataClass: "closed-enum", required: true, values: [...ACTIONS] },
    outcome: { type: "string", dataClass: "closed-enum", required: true, values: [...OUTCOMES] },
    reason: { type: "string", dataClass: "closed-enum", required: false, values: [...REASONS] },
    ecosystem: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["maven", "npm"],
    },
    method: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...REPOSITORY_RELAY_METHODS],
    },
    credentialKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["none", "basic", "bearer"],
    },
    upstreamStatusClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["2xx", "3xx", "4xx", "5xx"],
    },
    // The settled summary of one binding: what its run asked for and what became of it.
    requestCount: OPTIONAL_COUNT,
    relayedCount: OPTIONAL_COUNT,
    refusedCount: OPTIONAL_COUNT,
    failedCount: OPTIONAL_COUNT,
    cancelledCount: OPTIONAL_COUNT,
    upstreamClientErrorCount: OPTIONAL_COUNT,
    upstreamServerErrorCount: OPTIONAL_COUNT,
    redirectCount: OPTIONAL_COUNT,
    responseBytes: OPTIONAL_COUNT,
    durationMs: OPTIONAL_COUNT,
    ...ACTIVITY_FAILURE_DIAGNOSTIC_FIELDS,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["coding-runtime-repository-relay"],
  proofIds: ["coding-runtime.repository-relay.emitted-line"],
  releaseImpact: "patch",
});

export interface RepositoryRelayLine
  extends
    ActivityActionLine<(typeof ACTIONS)[number], RepositoryRelayOutcome, RepositoryRelayReason>,
    ActivityCountFields<
      | "requestCount"
      | "relayedCount"
      | "refusedCount"
      | "failedCount"
      | "cancelledCount"
      | "upstreamClientErrorCount"
      | "upstreamServerErrorCount"
      | "redirectCount"
      | "responseBytes"
    > {
  readonly ecosystem?: "maven" | "npm" | undefined;
  readonly method?: RepositoryRelayMethod | undefined;
  readonly credentialKind?: "none" | "basic" | "bearer" | undefined;
  readonly upstreamStatusClass?: "2xx" | "3xx" | "4xx" | "5xx" | undefined;
}

const LINE_FIELDS = [
  "reason",
  "ecosystem",
  "method",
  "credentialKind",
  "upstreamStatusClass",
  "requestCount",
  "relayedCount",
  "refusedCount",
  "failedCount",
  "cancelledCount",
  "upstreamClientErrorCount",
  "upstreamServerErrorCount",
  "redirectCount",
  "responseBytes",
  "durationMs",
] as const;

/** Counts and closed values only; never a credential, a URL, a path or a repository name. */
export function recordRepositoryRelay(
  activityLog: ServerLogSink | undefined,
  correlationId: string,
  line: RepositoryRelayLine,
): void {
  activityLog?.write(
    activityLogEvent(
      REPOSITORY_RELAY_OPERATION,
      { correlationId, ...activityStateLevel(line.outcome) },
      activityActionFields(line, LINE_FIELDS),
    ),
  );
}

export function upstreamStatusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" | undefined {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return status >= 500 && status < 600 ? "5xx" : undefined;
}
