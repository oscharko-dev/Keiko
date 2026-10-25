import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { CodingRuntimeQuestionAnswerRejectedError } from "./codingRuntimeQuestionPort.js";
import type { OpenCodeQuestionRequest } from "./opencodeHttpClient.js";
import type { OpenCodeNativeSessionRelation } from "./opencodeNativePolicy.js";
import { admitNativeChildren, type NativeSessionTreeRun } from "./opencodeNativeSessionTree.js";
import { answerOpenCodeV2Form, projectOpenCodeV2Form, v2FormId } from "./opencodeV2Questions.js";
import type { OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

/**
 * The human's side of a native run's questions (#3897 review, PR #4064). A native question belongs
 * to the session that asked it: the run's primary session, or a child session (a subagent) the
 * original runtime opened under it. The runtime lists every pending form of its process; the run
 * owns the forms whose session its session tree proves (`opencodeNativeSessionTree.ts`), and an
 * answer or a rejection goes to the session that asked, whichever of the run's sessions that is.
 * A form of any other session, a stale form id and a form outside the run's workspace are refused,
 * never routed. Run authority and revision checks stay with the callers above this port.
 */

// The human's side of the question lane. `list` is written when the pending forms the run owns
// change, `answer` and `reject` once per attempt; a form the run does not own is refused and
// counted, never routed. `dismiss` is written once for an owned form the lane cannot show (#3897
// review): it is cancelled through the session that asked. Counts and closed words only.
const NATIVE_QUESTION_ROUTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-question.routed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeQuestions.recordNativeQuestionRouted",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["answer", "dismiss", "list", "reject"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["answered", "dismissed", "listed", "refused", "rejected"],
    },
    sessionRelation: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["child", "primary"],
    },
    refusal: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["foreign-session", "form-missing", "form-unrepresentable", "run-closed"],
    },
    formCount: { type: "integer", dataClass: "count", required: true },
    childFormCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-session-continuity"],
  proofIds: ["coding-runtime.native-question.routed.emitted-line"],
  releaseImpact: "patch",
});

type V2Form = Readonly<Record<string, unknown>>;

/** A pending form of the run's native session tree, with the session that asked it. */
interface RoutedForm {
  readonly form: V2Form;
  readonly formId: string;
  readonly sessionId: string;
  readonly relation: OpenCodeNativeSessionRelation;
}

/** What the runtime lists, the part of it that belongs to the run, and the ids of the rest. */
interface FormRouting {
  readonly listedCount: number;
  readonly routed: readonly RoutedForm[];
  readonly foreignFormIds: ReadonlySet<string>;
}

type QuestionRefusal = "foreign-session" | "form-missing" | "form-unrepresentable" | "run-closed";
type RoutedFormLookup = { readonly form: RoutedForm } | { readonly refusal: QuestionRefusal };

export interface NativeQuestionPortDeps {
  readonly runId: string;
  readonly client: Pick<OpenCodeV2HttpClient, "cancelForm" | "forms" | "replyForm" | "sessions">;
  readonly tree: NativeSessionTreeRun;
  /** False once the run closed: an answer or rejection finished after that is not acknowledged. */
  readonly open: () => boolean;
  readonly activityLog: ServerLogSink | undefined;
  /** Called with the error of a failed read or reply before it is rethrown. */
  readonly onFailure: (error: unknown) => void;
  /** What the last written list line counted, kept by the run across calls (a line per change). */
  readonly listed: { signature?: string | undefined };
}

export interface NativeQuestionPort {
  readonly list: () => Promise<readonly OpenCodeQuestionRequest[]>;
  readonly answer: (requestId: string, answers: readonly (readonly string[])[]) => Promise<boolean>;
  readonly reject: (requestId: string) => Promise<boolean>;
}

export function createNativeQuestionPort(deps: NativeQuestionPortDeps): NativeQuestionPort {
  return {
    list: () => listQuestions(deps),
    answer: (requestId, answers) => answerQuestion(deps, requestId, answers),
    reject: (requestId) => rejectQuestion(deps, requestId),
  };
}

/**
 * The pending forms the runtime lists that belong to the run. The session list is read only when a
 * form of a session not yet proven turns up; a failed read throws, so no form is routed unproven.
 */
async function routeForms(deps: NativeQuestionPortDeps): Promise<FormRouting> {
  const { client, tree } = deps;
  const byId = new Map<string, V2Form>();
  for (const directory of new Set([tree.workspaceRoot, ...(tree.locations ?? [])])) {
    for (const form of await client.forms(directory))
      if (typeof form.id === "string") byId.set(form.id, form);
  }
  const listed = [...byId.values()];
  const asking = [...new Set(listed.flatMap(formSession))].filter((id) => id !== tree.sessionId);
  const children = new Set(await admitNativeChildren(client, tree, asking, undefined));
  const routed = listed.flatMap((form): readonly RoutedForm[] => {
    const [sessionId] = formSession(form);
    const formId = form.id;
    if (sessionId === undefined || typeof formId !== "string") return [];
    if (sessionId === tree.sessionId) return [{ form, formId, sessionId, relation: "primary" }];
    return children.has(sessionId) ? [{ form, formId, sessionId, relation: "child" }] : [];
  });
  const owned = new Set(routed.map(({ formId }) => formId));
  const foreignFormIds = new Set(
    listed.flatMap(({ id }) => (typeof id === "string" && !owned.has(id) ? [id] : [])),
  );
  return { listedCount: listed.length, routed, foreignFormIds };
}

function formSession(form: V2Form): readonly string[] {
  return typeof form.sessionID === "string" ? [form.sessionID] : [];
}

function findRoutedForm(routing: FormRouting, formId: string | undefined): RoutedFormLookup {
  const form = routing.routed.find((candidate) => candidate.formId === formId);
  if (form !== undefined) return { form };
  return {
    refusal:
      formId !== undefined && routing.foreignFormIds.has(formId)
        ? "foreign-session"
        : "form-missing",
  };
}

async function listQuestions(
  deps: NativeQuestionPortDeps,
): Promise<readonly OpenCodeQuestionRequest[]> {
  try {
    const routing = await routeForms(deps);
    noteListed(deps, routing);
    // One form at a time: the Activity Log records each refused form's dismissal right after its
    // refusal, so the evidence of every form stays together.
    const represent = async (
      index: number,
      requests: readonly OpenCodeQuestionRequest[],
    ): Promise<readonly OpenCodeQuestionRequest[]> => {
      const routed = routing.routed[index];
      if (routed === undefined) return requests;
      const request = representedForm(deps, routing, routed);
      if (request === undefined) await dismissForm(deps, routing, routed);
      return represent(index + 1, request === undefined ? requests : [...requests, request]);
    };
    return await represent(0, []);
  } catch (error) {
    deps.onFailure(error);
    throw error;
  }
}

/**
 * The form as the Workbench shows it, or undefined when the question lane cannot represent it (more
 * than 32 options, say, or a field type it has no control for). The validation bound stays: the
 * original runtime would otherwise wait for an answer nobody can give.
 */
function representedForm(
  deps: NativeQuestionPortDeps,
  routing: FormRouting,
  routed: RoutedForm,
): OpenCodeQuestionRequest | undefined {
  try {
    return projectOpenCodeV2Form(routed.form);
  } catch {
    // The closed reason is the evidence; the projection's own message names only a shape bound.
    recordRouted(deps, {
      action: "dismiss",
      outcome: "refused",
      sessionRelation: routed.relation,
      refusal: "form-unrepresentable",
      routing,
    });
    return undefined;
  }
}

/**
 * Settles an owned form the lane cannot show through the session that asked, as a human refusal
 * would: the asking session receives the runtime's own dismissal, so a child's parent continues and
 * a primary turn ends as cancelled instead of waiting invisibly. Valid sibling forms stay listed.
 */
async function dismissForm(
  deps: NativeQuestionPortDeps,
  routing: FormRouting,
  routed: RoutedForm,
): Promise<void> {
  await deps.client.cancelForm(routed.sessionId, routed.formId);
  recordRouted(deps, {
    action: "dismiss",
    outcome: "dismissed",
    sessionRelation: routed.relation,
    refusal: "form-unrepresentable",
    routing,
  });
}

async function answerQuestion(
  deps: NativeQuestionPortDeps,
  requestId: string,
  answers: readonly (readonly string[])[],
): Promise<boolean> {
  try {
    const routing = await routeForms(deps);
    const target = findRoutedForm(routing, v2FormId(requestId));
    if ("refusal" in target || !deps.open()) {
      recordRefusal(deps, "answer", routing, target);
      return false;
    }
    const { form, formId, sessionId, relation } = target.form;
    if (!answersMatchQuestions(projectOpenCodeV2Form(form), answers))
      throw new CodingRuntimeQuestionAnswerRejectedError();
    // The answer goes to the session that asked, whichever of the run's sessions it is.
    await deps.client.replyForm(sessionId, formId, answerOpenCodeV2Form(form, answers));
    recordRouted(deps, {
      action: "answer",
      outcome: "answered",
      sessionRelation: relation,
      routing,
    });
    return deps.open();
  } catch (error) {
    if (error instanceof CodingRuntimeQuestionAnswerRejectedError) throw error;
    deps.onFailure(error);
    throw error;
  }
}

async function rejectQuestion(deps: NativeQuestionPortDeps, requestId: string): Promise<boolean> {
  try {
    const routing = await routeForms(deps);
    const target = findRoutedForm(routing, v2FormId(requestId));
    if ("refusal" in target) {
      recordRefusal(deps, "reject", routing, target);
      return false;
    }
    await deps.client.cancelForm(target.form.sessionId, target.form.formId);
    recordRouted(deps, {
      action: "reject",
      outcome: "rejected",
      sessionRelation: target.form.relation,
      routing,
    });
    return deps.open();
  } catch (error) {
    deps.onFailure(error);
    throw error;
  }
}

/** The answers fit the questions: one answer per question, a single choice unless it is multiple. */
function answersMatchQuestions(
  request: OpenCodeQuestionRequest,
  answers: readonly (readonly string[])[],
): boolean {
  if (answers.length !== request.questions.length) return false;
  return answers.every((answer, index) => {
    const question = request.questions[index];
    if (question === undefined || (question.multiple !== true && answer.length > 1)) return false;
    const labels = new Set(question.options.map((option) => option.label));
    return answer.every((selection) => question.custom === true || labels.has(selection));
  });
}

interface NativeQuestionRoutedFacts {
  readonly action: "answer" | "dismiss" | "list" | "reject";
  readonly outcome: "answered" | "dismissed" | "listed" | "refused" | "rejected";
  readonly sessionRelation?: OpenCodeNativeSessionRelation | undefined;
  readonly refusal?: QuestionRefusal | undefined;
  readonly routing: FormRouting;
}

function recordRouted(deps: NativeQuestionPortDeps, facts: NativeQuestionRoutedFacts): void {
  recordNativeQuestionRouted(deps.activityLog, deps.runId, facts);
}

export function recordNativeQuestionRouted(
  activityLog: ServerLogSink | undefined,
  runId: string,
  facts: NativeQuestionRoutedFacts,
): void {
  activityLog?.write(
    activityLogEvent(
      NATIVE_QUESTION_ROUTED_OPERATION,
      {
        correlationId: runId,
        ...(facts.outcome === "refused" || facts.outcome === "dismissed"
          ? { level: "warn" as const }
          : {}),
      },
      {
        action: facts.action,
        outcome: facts.outcome,
        ...(facts.sessionRelation === undefined ? {} : { sessionRelation: facts.sessionRelation }),
        ...(facts.refusal === undefined ? {} : { refusal: facts.refusal }),
        formCount: facts.routing.listedCount,
        childFormCount: facts.routing.routed.filter(({ relation }) => relation === "child").length,
      },
    ),
  );
}

// A refused answer or rejection: the form is not the run's (a stale id, or another session's form),
// or the run closed while the form list was read.
function recordRefusal(
  deps: NativeQuestionPortDeps,
  action: "answer" | "reject",
  routing: FormRouting,
  target: RoutedFormLookup,
): void {
  recordRouted(deps, {
    action,
    outcome: "refused",
    refusal: "refusal" in target ? target.refusal : "run-closed",
    routing,
  });
}

// The UI polls the list; a line is written when the forms the run owns change, not per poll.
function noteListed(deps: NativeQuestionPortDeps, routing: FormRouting): void {
  const childFormCount = routing.routed.filter(({ relation }) => relation === "child").length;
  const signature = `${String(routing.listedCount)}:${String(routing.routed.length)}:${String(childFormCount)}`;
  const previous = deps.listed.signature ?? "0:0:0";
  deps.listed.signature = signature;
  if (signature !== previous) recordRouted(deps, { action: "list", outcome: "listed", routing });
}
