import { readJiraProjectIdentity, parseJiraDraft } from "@oscharko-dev/keiko-connectors";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import {
  JIRA_APPROVAL_PROJECTS_MAX,
  type AtlassianConnectorWriteFailureReason,
  type JiraApprovalProject,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { UiHandlerDeps } from "../deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import { chatDraftArguments } from "./jiraChatDraftArguments.js";
import {
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";

/**
 * The projects a write approval names, by key and name (F09 of the real-browser walk). A card used
 * to learn a project's name only from a `jira_projects` read of the same Chat, so the first create
 * of a fresh Chat showed the bare numeric id. The server reads each project once, through the same
 * `project/{idOrKey}` read the write itself performs, when it builds the approval, and the card only
 * displays what the approval carries.
 */
const PROJECT_REFERENCE = /^\w{1,32}$/u;
/** One bounded read: a slow Jira must not hold a person's approval card back. */
const PROJECT_READ_TIMEOUT_MS = 5_000;

const FAILURES = [
  "not-admitted",
  "malformed-payload",
  "auth-failed",
  "auth-unverified",
  "permission-denied",
  "effect-denied",
  "cancelled",
  "not-found",
  "rate-limited",
  "timeout",
  "unavailable",
  "bounds-exceeded",
  "conflict",
  "invalid-transition",
  "field-validation",
] as const satisfies readonly (AtlassianConnectorWriteFailureReason | "not-admitted")[];
type Failure = (typeof FAILURES)[number];

const PROJECT_NAMES = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.approval.project",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraChatApprovalProjects.recordJiraApprovalProjects",
  fields: {
    projectCount: { type: "integer", dataClass: "count", required: true },
    resolvedCount: { type: "integer", dataClass: "count", required: true },
    unresolvedCount: { type: "integer", dataClass: "count", required: true },
    failure: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...FAILURES, "none"],
    },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.approval.project.line"],
  releaseImpact: "patch",
});

function recordJiraApprovalProjects(
  correlationId: string,
  counts: { readonly requested: number; readonly resolved: number },
  failure: Failure | undefined,
  durationMs: number,
): void {
  try {
    processServerLogSink().write(
      activityLogEvent(
        PROJECT_NAMES,
        { correlationId, level: failure === undefined ? "info" : "warn" },
        {
          projectCount: counts.requested,
          resolvedCount: counts.resolved,
          unresolvedCount: counts.requested - counts.resolved,
          failure: failure ?? "none",
          durationMs,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    recordActivityLogLoss("port-sink-failed");
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId,
        operation: "jira.approval.project-log-failed",
        source: "jira-chat-approval-projects",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}

function addReference(refs: string[], value: unknown): void {
  if (typeof value === "string" && PROJECT_REFERENCE.test(value) && !refs.includes(value))
    refs.push(value);
}

/**
 * The project references an action targets, in the order the call states them: the items of a
 * draft (inline or staged) each name their own project, every other write may carry one `projectId`.
 */
export function jiraApprovalProjectReferences(
  deps: Pick<UiHandlerDeps, "jiraDraftStore">,
  chatId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const refs: string[] = [];
  if (tool === "jira.draft") {
    const resolved = chatDraftArguments(deps.jiraDraftStore, chatId, args);
    for (const item of resolved.ok ? (parseJiraDraft(resolved.arguments)?.items ?? []) : [])
      addReference(refs, item.projectId);
  } else {
    addReference(refs, args.projectId);
  }
  return refs.slice(0, JIRA_APPROVAL_PROJECTS_MAX);
}

interface ReadOutcome {
  readonly project: JiraApprovalProject;
  readonly failure?: Failure;
}

/**
 * Key and name of each referenced project as Jira answers now. A reference Jira does not answer
 * is listed by itself, so the card never shows a name that was not read; the closed failure is
 * recorded body-free on `jira.approval.project`. Absent when nothing is referenced.
 */
export async function reviewedJiraProjects(
  deps: JiraChatAuthorityDeps & Pick<UiHandlerDeps, "atlassianConnectorCredentials">,
  options: {
    readonly chatId: string;
    readonly authorityReference: EditorAgentGovernedAuthorityReference;
    readonly signal: AbortSignal;
    readonly correlationId: string;
    /** Every source of a combined turn still admits this metadata read. */
    readonly readAllowed?: () => boolean;
  },
  references: readonly string[],
): Promise<readonly JiraApprovalProject[] | undefined> {
  if (references.length === 0) return undefined;
  const started = Date.now();
  const { chatId, authorityReference, correlationId } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(PROJECT_READ_TIMEOUT_MS)]);
  const allowed = (): boolean => {
    if (signal.aborted) return false;
    const admitted: unknown = options.readAllowed?.() ?? true;
    return admitted === true;
  };
  const current = resolveCurrentJiraChatAuthority(
    deps,
    chatId,
    authorityReference,
    new Date().toISOString(),
    correlationId,
  );
  const credentials = deps.atlassianConnectorCredentials;
  const outcomes: readonly ReadOutcome[] =
    !current.ok || credentials === undefined || !allowed()
      ? references.map((ref) => ({ project: { ref }, failure: "not-admitted" }))
      : await readAll(current, credentials, references, { signal, allowed, correlationId });
  const failure = outcomes.find((outcome) => outcome.failure !== undefined)?.failure;
  recordJiraApprovalProjects(
    correlationId,
    {
      requested: references.length,
      resolved: outcomes.filter((outcome) => outcome.failure === undefined).length,
    },
    failure,
    Date.now() - started,
  );
  return outcomes.map((outcome) => outcome.project);
}

async function readAll(
  current: Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>,
  credentials: NonNullable<UiHandlerDeps["atlassianConnectorCredentials"]>,
  references: readonly string[],
  run: {
    readonly signal: AbortSignal;
    readonly allowed: () => boolean;
    readonly correlationId: string;
  },
): Promise<readonly ReadOutcome[]> {
  const http = credentials.httpBodyPortFactory(current.credential, run.correlationId, {
    beforeDispatch: (request) => request.method === "GET" && run.allowed(),
  });
  const connection = {
    baseUrl: current.credential.baseUrl,
    deployment: current.credential.deployment,
    http,
  };
  return Promise.all(
    references.map(async (ref, index): Promise<ReadOutcome> => {
      const read = await readJiraProjectIdentity(
        connection,
        {
          invocationId: `approval-project-${String(index)}`,
          correlationId: run.correlationId,
          signal: run.signal,
          beforeEffect: run.allowed,
        },
        ref,
      );
      return read.ok
        ? { project: { ref, key: read.key, name: read.name } }
        : { project: { ref }, failure: read.reason };
    }),
  );
}
