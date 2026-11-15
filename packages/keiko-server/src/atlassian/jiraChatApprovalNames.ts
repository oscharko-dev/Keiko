import {
  parseJiraDraft,
  readJiraFieldNames,
  readJiraTransitionIdentity,
} from "@oscharko-dev/keiko-connectors";
import {
  isJiraApprovalTransition,
  type JiraApprovalNamedId,
  type JiraApprovalTransition,
  JIRA_APPROVAL_NAMES_MAX,
  isJiraApprovalNamedIds,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type { UiHandlerDeps } from "../deps.js";
import { processServerLogSink } from "../process-log-sink.js";
import { chatDraftArguments } from "./jiraChatDraftArguments.js";
import {
  APPROVAL_READ_FAILURES,
  approvalReadScope,
  routineApprovalFailure,
  type ApprovalReadFailure,
  reportApprovalLogFault,
  windowEnded,
  type ApprovalProjectDeps,
  type ApprovalProjectOptions,
} from "./jiraChatApprovalProjects.js";

/**
 * The status change a `jira.transition` approval names, by the transition's name and the status it
 * leads to (R04 of the regression walk): a card used to show the transition id alone, a number nobody
 * can read. The server reads the issue's transition list once, through the same read the write itself
 * performs, when it builds the approval; the names are Jira's own words for this person (profile
 * language) and never come from a table of the product. A list that cannot be read leaves the
 * reference alone, which the card says in words; the gate's own fail-closed read at dispatch is
 * unchanged, and so is the action digest the approval is bound to.
 */
const ISSUE_KEY = /^[A-Za-z]\w{0,63}-\d{1,12}$/u;
const TRANSITION_ID = /^\d{1,10}$/u;

const APPROVAL_NAMES = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.approval.names",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraChatApprovalNames.recordJiraApprovalNames",
  fields: {
    kind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["transition", "fields"],
    },
    requestedCount: { type: "integer", dataClass: "count", required: true },
    resolvedCount: { type: "integer", dataClass: "count", required: true },
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
  proofIds: ["jira.approval.names.line"],
  releaseImpact: "patch",
});

function recordJiraApprovalNames(
  correlationId: string,
  kind: "transition" | "fields",
  counts: { readonly requested: number; readonly resolved: number },
  failure: ApprovalReadFailure | undefined,
  durationMs: number,
): void {
  try {
    processServerLogSink().write(
      activityLogEvent(
        APPROVAL_NAMES,
        { correlationId, level: routineApprovalFailure(failure) ? "info" : "warn" },
        {
          kind,
          requestedCount: counts.requested,
          resolvedCount: counts.resolved,
          failure: failure ?? "none",
          durationMs,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    reportApprovalLogFault(correlationId, "jira.approval.names-log-failed", error);
  }
}

/** The issue key and transition id of a proposed `jira.transition`, or undefined for any other call. */
export function jiraApprovalTransitionTarget(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): { readonly issueKey: string; readonly transitionId: string } | undefined {
  const { issueKey, transitionId } = args;
  return tool === "jira.transition" &&
    typeof issueKey === "string" &&
    ISSUE_KEY.test(issueKey) &&
    typeof transitionId === "string" &&
    TRANSITION_ID.test(transitionId)
    ? { issueKey, transitionId }
    : undefined;
}

interface TransitionRead {
  readonly shown: JiraApprovalTransition;
  readonly failure?: ApprovalReadFailure;
}

/** What a card may show of Jira's answer: names the contract accepts and the credential floor leaves unchanged. */
function shownTransition(
  ref: string,
  read: { readonly name?: string; readonly targetStatusName?: string },
  redact: ApprovalProjectDeps["redactor"],
): JiraApprovalTransition {
  const unchanged = (text: string | undefined): string | undefined =>
    text !== undefined && redact(text) === text ? text : undefined;
  const name = unchanged(read.name);
  const targetStatusName = unchanged(read.targetStatusName);
  const named = {
    ref,
    ...(name === undefined ? {} : { name }),
    ...(targetStatusName === undefined ? {} : { targetStatusName }),
  };
  return isJiraApprovalTransition(named) ? named : { ref };
}

async function readTransition(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  target: { readonly issueKey: string; readonly transitionId: string },
): Promise<TransitionRead> {
  const { transitionId: ref } = target;
  const scope = approvalReadScope(deps, options);
  if (scope === undefined) return { shown: { ref }, failure: "not-admitted" };
  const { connection, run } = scope;
  const attempt = (async (): Promise<TransitionRead> => {
    try {
      const read = await readJiraTransitionIdentity(
        connection,
        {
          invocationId: "approval-transition",
          correlationId: run.correlationId,
          signal: run.signal,
          beforeEffect: run.allowed,
        },
        target.issueKey,
        ref,
      );
      return read.ok
        ? { shown: shownTransition(ref, read, run.redactor) }
        : { shown: { ref }, failure: read.reason };
    } catch (error) {
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId: run.correlationId,
          operation: "jira.approval.names-read-failed",
          source: "jira-chat-approval-names",
          error,
          redact: () => "server-operation-failed",
        }),
      );
      return { shown: { ref }, failure: "failed" };
    }
  })();
  return Promise.race([
    attempt,
    windowEnded(run).then((failure): TransitionRead => ({ shown: { ref }, failure })),
  ]);
}

/**
 * The transition an approval covers as Jira answers now: its name and the status it leads to. A
 * lookup that fails, runs out of its window or is stopped with its turn leaves the reference alone,
 * so the card never shows a name that was not read. The closed failure is recorded body-free on
 * `jira.approval.transition`. Absent for any write that is no transition.
 */
export async function reviewedJiraTransition(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  target: { readonly issueKey: string; readonly transitionId: string } | undefined,
): Promise<JiraApprovalTransition | undefined> {
  if (target === undefined) return undefined;
  const started = Date.now();
  const outcome = await readTransition(deps, options, target);
  recordJiraApprovalNames(
    options.correlationId,
    "transition",
    {
      requested: 1,
      resolved: Number(
        outcome.shown.name !== undefined || outcome.shown.targetStatusName !== undefined,
      ),
    },
    outcome.failure,
    Date.now() - started,
  );
  return outcome.shown;
}

/** Every field id a write names: the keys of `fields`, of each draft item's `fields`, and each update's field. */
const FIELD_REFERENCE = /^[A-Za-z]\w{0,79}$/u;
function fieldKeys(fields: unknown): readonly string[] {
  return typeof fields === "object" && fields !== null && !Array.isArray(fields)
    ? Object.keys(fields)
    : [];
}
function updateFields(updates: unknown): readonly string[] {
  return Array.isArray(updates)
    ? updates.flatMap((update: unknown) => {
        const field: unknown =
          typeof update === "object" && update !== null
            ? Reflect.get(update, "fieldId")
            : undefined;
        return typeof field === "string" ? [field] : [];
      })
    : [];
}
export function jiraApprovalFieldReferences(
  deps: Pick<UiHandlerDeps, "jiraDraftStore">,
  chatId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const keys: string[] = [];
  if (tool === "jira.draft") {
    const resolved = chatDraftArguments(deps.jiraDraftStore, chatId, args);
    for (const item of resolved.ok ? (parseJiraDraft(resolved.arguments)?.items ?? []) : [])
      keys.push(...fieldKeys(item.fields));
  } else {
    keys.push(...fieldKeys(args.fields), ...updateFields(args.updates));
  }
  return [...new Set(keys.filter((key) => FIELD_REFERENCE.test(key)))].slice(
    0,
    JIRA_APPROVAL_NAMES_MAX,
  );
}

interface FieldRead {
  readonly names: readonly JiraApprovalNamedId[];
  readonly failure?: ApprovalReadFailure;
}
async function readFieldNames(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  ids: readonly string[],
): Promise<FieldRead> {
  const scope = approvalReadScope(deps, options);
  if (scope === undefined) return { names: [], failure: "not-admitted" };
  const { connection, run } = scope;
  const attempt = (async (): Promise<FieldRead> => {
    try {
      const read = await readJiraFieldNames(
        connection,
        {
          invocationId: "approval-fields",
          correlationId: run.correlationId,
          signal: run.signal,
          beforeEffect: run.allowed,
        },
        ids,
      );
      if (!read.ok) return { names: [], failure: read.reason };
      const shown = read.names.filter((entry) => run.redactor(entry.name) === entry.name);
      return { names: isJiraApprovalNamedIds(shown) ? shown : [] };
    } catch (error) {
      emitServerDiagnostic(
        undefined,
        serverDiagnosticFromError({
          correlationId: run.correlationId,
          operation: "jira.approval.names-read-failed",
          source: "jira-chat-approval-names",
          error,
          redact: () => "server-operation-failed",
        }),
      );
      return { names: [], failure: "failed" };
    }
  })();
  return Promise.race([
    attempt,
    windowEnded(run).then((failure): FieldRead => ({ names: [], failure })),
  ]);
}

/**
 * The names Jira gives this person for the fields a write carries, so a card shows "Story points" and
 * not `customfield_10112`. One bounded read of the instance's field list; a field Jira does not list
 * is absent and the card says so in words. Absent when the write names no field.
 */
export async function reviewedJiraFieldNames(
  deps: ApprovalProjectDeps,
  options: ApprovalProjectOptions,
  ids: readonly string[],
): Promise<readonly JiraApprovalNamedId[] | undefined> {
  if (ids.length === 0) return undefined;
  const started = Date.now();
  const outcome = await readFieldNames(deps, options, ids);
  recordJiraApprovalNames(
    options.correlationId,
    "fields",
    { requested: ids.length, resolved: outcome.names.length },
    outcome.failure,
    Date.now() - started,
  );
  return outcome.names.length === 0 ? undefined : outcome.names;
}
