import {
  parseJiraDraft,
  readJiraProjectIdentity,
  type JiraProjectIdentityResult,
} from "@oscharko-dev/keiko-connectors";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import {
  JIRA_APPROVAL_PROJECTS_MAX,
  isJiraApprovalProject,
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
/**
 * One bounded window for every read together: a name is a convenience, so a slow Jira must not
 * hold a person's approval card back. A normal answer takes a few tens of milliseconds.
 */
export const PROJECT_READ_TIMEOUT_MS = 2_000;

export const APPROVAL_READ_FAILURES = [
  "not-admitted",
  "failed",
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
] as const satisfies readonly (AtlassianConnectorWriteFailureReason | "not-admitted" | "failed")[];
export type ApprovalReadFailure = (typeof APPROVAL_READ_FAILURES)[number];

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
      values: [...APPROVAL_READ_FAILURES, "none"],
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

/**
 * An outcome the system expects in ordinary use (nothing was admitted to read, the project is not
 * visible to this actor, a transition no longer on offer, the turn was stopped) is routine; an unreachable or misbehaving Jira is not.
 */
export function routineApprovalFailure(failure: ApprovalReadFailure | undefined): boolean {
  return (
    failure === undefined ||
    failure === "not-admitted" ||
    failure === "not-found" ||
    failure === "invalid-transition" ||
    failure === "permission-denied" ||
    failure === "cancelled"
  );
}

function recordJiraApprovalProjects(
  correlationId: string,
  counts: { readonly requested: number; readonly resolved: number },
  failure: ApprovalReadFailure | undefined,
  durationMs: number,
): void {
  try {
    processServerLogSink().write(
      activityLogEvent(
        PROJECT_NAMES,
        { correlationId, level: routineApprovalFailure(failure) ? "info" : "warn" },
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
    reportApprovalLogFault(correlationId, "jira.approval.project-log-failed", error);
  }
}

/**
 * A line that could not be written is a lost line, counted in the loss ledger, with a body-free
 * diagnostic naming the closed operation; the approval card is never held back by it.
 */
export function reportApprovalLogFault(
  correlationId: string,
  operation: "jira.approval.project-log-failed" | "jira.approval.names-log-failed",
  error: unknown,
): void {
  recordActivityLogLoss("port-sink-failed");
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation,
      source: "jira-chat-approval-projects",
      error,
      redact: () => "server-operation-failed",
    }),
  );
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

/** The issue type ids a write carries (a create's, or each draft item's), the ones a card must name. */
export function jiraApprovalIssueTypeReferences(
  deps: Pick<UiHandlerDeps, "jiraDraftStore">,
  chatId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const ids: unknown[] = [];
  if (tool === "jira.draft") {
    const resolved = chatDraftArguments(deps.jiraDraftStore, chatId, args);
    for (const item of resolved.ok ? (parseJiraDraft(resolved.arguments)?.items ?? []) : [])
      ids.push(item.issueTypeId);
  } else {
    ids.push(args.issueTypeId);
  }
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && PROJECT_REFERENCE.test(id)),
    ),
  ];
}

interface ReadOutcome {
  readonly project: JiraApprovalProject;
  readonly failure?: ApprovalReadFailure;
}
export type ApprovalProjectDeps = JiraChatAuthorityDeps &
  Pick<UiHandlerDeps, "atlassianConnectorCredentials" | "redactor">;
export interface ApprovalProjectOptions {
  readonly chatId: string;
  readonly authorityReference: EditorAgentGovernedAuthorityReference;
  readonly signal: AbortSignal;
  readonly correlationId: string;
  /** Every source of a combined turn still admits this metadata read. */
  readonly readAllowed?: () => boolean;
  /** The one window of all reads together; tests shorten it. */
  readonly timeoutMs?: number;
}

/** A lookup that faulted is a failure of the convenience, never of the card: the reference stays. */
export function reportReadFault(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "jira.approval.project-read-failed",
      source: "jira-chat-approval-projects",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

/**
 * Key and name of each referenced project as Jira answers now. A reference Jira does not answer is
 * listed by itself, so the card never shows a name that was not read, and a lookup that throws, runs
 * out of its window or is stopped with its turn leaves the approval exactly as it would be without
 * names. The closed failure is recorded body-free on `jira.approval.project`. Absent when nothing
 * is referenced.
 */
export async function reviewedJiraProjects(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  references: readonly string[],
  issueTypeIds: readonly string[] = [],
): Promise<readonly JiraApprovalProject[] | undefined> {
  if (references.length === 0) return undefined;
  const started = Date.now();
  const { correlationId } = options;
  let outcomes: readonly ReadOutcome[];
  try {
    outcomes = await lookup(deps, options, references, new Set(issueTypeIds));
  } catch (error) {
    reportReadFault(correlationId, error);
    outcomes = references.map((ref) => ({ project: { ref }, failure: "failed" }));
  }
  recordJiraApprovalProjects(
    correlationId,
    {
      requested: references.length,
      resolved: outcomes.filter((outcome) => outcome.failure === undefined).length,
    },
    outcomes.find((outcome) => outcome.failure !== undefined)?.failure,
    Date.now() - started,
  );
  return outcomes.map((outcome) => outcome.project);
}

async function lookup(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  references: readonly string[],
  issueTypeIds: ReadonlySet<string>,
): Promise<readonly ReadOutcome[]> {
  const scope = approvalReadScope(deps, options);
  if (scope === undefined)
    return references.map((ref) => ({ project: { ref }, failure: "not-admitted" }));
  const { connection, run } = scope;
  return Promise.all(
    references.map((ref, index) => readOne(connection, run, ref, index, issueTypeIds)),
  );
}

/** What every approval-time metadata read shares: one admitted connection and one window. */
export interface ApprovalReadScope {
  readonly connection: Parameters<typeof readJiraProjectIdentity>[0];
  readonly run: ReadRun;
}

/**
 * The admitted, read-only connection and the one bounded window of an approval's metadata reads, or
 * undefined when nothing is admitted to read (no current authority, no credential, a stopped turn).
 */
export function approvalReadScope(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
): ApprovalReadScope | undefined {
  const { chatId, authorityReference, correlationId } = options;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? PROJECT_READ_TIMEOUT_MS),
  ]);
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
  if (!current.ok || credentials === undefined || !allowed()) return undefined;
  const http = credentials.httpBodyPortFactory(current.credential, correlationId, {
    beforeDispatch: (request) => request.method === "GET" && allowed(),
  });
  return {
    connection: {
      baseUrl: current.credential.baseUrl,
      deployment: current.credential.deployment,
      http,
    },
    run: { signal, turn: options.signal, allowed, correlationId, redactor: deps.redactor },
  };
}

export interface ReadRun {
  readonly signal: AbortSignal;
  readonly turn: AbortSignal;
  readonly allowed: () => boolean;
  readonly correlationId: string;
  readonly redactor: UiHandlerDeps["redactor"];
}

/** Resolves when the window ends or the turn stops, whichever comes first, so no read outlives it. */
export function windowEnded(run: ReadRun): Promise<"cancelled" | "timeout"> {
  return new Promise((resolve) => {
    const settle = (): void => {
      resolve(run.turn.aborted ? "cancelled" : "timeout");
    };
    if (run.signal.aborted) settle();
    else run.signal.addEventListener("abort", settle, { once: true });
  });
}

/**
 * What a card may show of Jira's answer: the key, and the name only when it is a name a card can
 * show and the credential floor leaves it unchanged. Anything else drops that name alone; a key
 * the contract refuses drops the project to its bare reference.
 */
function shown(
  ref: string,
  read: Extract<JiraProjectIdentityResult, { readonly ok: true }>,
  redactor: UiHandlerDeps["redactor"],
  issueTypeIds: ReadonlySet<string>,
): JiraApprovalProject {
  const redacted: unknown = read.name === undefined ? undefined : redactor(read.name);
  const issueTypes = (read.issueTypes ?? []).filter(
    (type) => issueTypeIds.has(type.id) && redactor(type.name) === type.name,
  );
  const named = {
    ref,
    key: read.key,
    ...(read.name !== undefined && redacted === read.name ? { name: read.name } : {}),
    ...(issueTypes.length === 0 ? {} : { issueTypes }),
  };
  return isJiraApprovalProject(named) ? named : { ref };
}

function readOne(
  connection: Parameters<typeof readJiraProjectIdentity>[0],
  run: ReadRun,
  ref: string,
  index: number,
  issueTypeIds: ReadonlySet<string>,
): Promise<ReadOutcome> {
  const attempt = (async (): Promise<ReadOutcome> => {
    try {
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
        ? { project: shown(ref, read, run.redactor, issueTypeIds) }
        : { project: { ref }, failure: read.reason };
    } catch (error) {
      reportReadFault(run.correlationId, error);
      return { project: { ref }, failure: "failed" };
    }
  })();
  return Promise.race([
    attempt,
    windowEnded(run).then((failure): ReadOutcome => ({ project: { ref }, failure })),
  ]);
}
