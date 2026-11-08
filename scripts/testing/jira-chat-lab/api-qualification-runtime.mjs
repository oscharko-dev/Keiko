// Select and dispatch the real application-owned catalog, including accepted-turn authority.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { createHarnessCatalogBudget, DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  mintAcceptedJiraChatAuthority,
  requestJiraChatReadGrant,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  createJiraChatCatalogConsumerPort,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatCatalogConsumer.js";
import {
  createJiraChatTurnReviewPorts,
  jiraSourcePreparationForTurn,
  observeJiraChatMutation,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatToolTurn.js";
import { jiraOperationForTool } from "../../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { createJiraChatHumanInput } from "../../../packages/keiko-server/dist/atlassian/jiraChatHumanInput.js";
import { createJiraPrivateLifetime } from "../../../packages/keiko-server/dist/atlassian/httpPrivateIdentity.js";
import { createCatalogToolBinder } from "../../../packages/keiko-server/dist/tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "../../../packages/keiko-server/dist/coding-runtime/codingToolInvocationRegistry.js";
import { defaultServerDiagnosticSink } from "../../../packages/keiko-server/dist/diagnostics-log.js";
import { acceptChatToolReadGrant } from "../../../packages/keiko-server/dist/chat-tool-approvals.js";
import { matchesNativeIdentity, qualificationDigest } from "./api-qualification-evidence.mjs";
import { labSessionConnection } from "./lab-client.mjs";
import { request as productRequest } from "./chat-read.mjs";

function readRequest(request, url) {
  return (
    request.method === "GET" ||
    (request.method === "POST" &&
      new Set([
        "/rest/api/2/search",
        "/rest/api/2/worklog/list",
        "/rest/api/2/password/policy/createUser",
        "/rest/api/2/password/policy/updateUser",
        "/rest/api/2/licenseValidator",
      ]).has(url.pathname))
  );
}

// The product's own session bookkeeping (login, logout, websudo release) is not a data effect.
const SESSION_MANAGEMENT_PATHS = new Set(["/rest/auth/1/session", "/rest/auth/1/websudo"]);

function witnessCore() {
  let selected;
  let state = { blocked: 0, responses: [], effects: 0 };
  let started = 0;
  const targeted = (request, url) =>
    selected !== undefined &&
    matchesNativeIdentity(selected.identity, request.method, url.pathname);
  // One decision for both transports: only the armed identity may write, and only once.
  const admit = (request, url, sessionPaths) => {
    if (readRequest(request, url)) return true;
    if (!targeted(request, url) && sessionPaths?.has(url.pathname)) return true;
    if (!targeted(request, url) || !selected.mutation || state.effects !== 0) {
      state.blocked += 1;
      return false;
    }
    state.effects += 1;
    started += 1;
    return true;
  };
  return {
    targeted,
    admit,
    record: (entry) => state.responses.push(entry),
    arm(identity, mutation) {
      selected = { identity, mutation };
      state = { blocked: 0, responses: [], effects: 0 };
    },
    /** Start a case: nothing armed, and no earlier case's effects are attributed to it. */
    reset() {
      selected = undefined;
      state = { blocked: 0, responses: [], effects: 0 };
      started = 0;
    },
    /** Native effects begun and not yet independently verified since the last reset. */
    effectsStarted: () => started,
    /** An auxiliary fixture whose effect an independent readback matched leaves nothing open. */
    markVerified() {
      started = 0;
    },
    snapshot: () => structuredClone(state),
  };
}
const observedBody = (result) => ({
  status: result.status,
  truncated: result.truncated,
  bodyBytes: result.bodyBytes,
  responseDigest: qualificationDigest(result.bodyText),
});
function privateObserver(core, origin) {
  return (lifecycle = {}) => ({
    ...lifecycle,
    beforeDispatch: (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin || !core.admit(request, url, SESSION_MANAGEMENT_PATHS))
        return false;
      return lifecycle.beforeDispatch === undefined || lifecycle.beforeDispatch(request) === true;
    },
    onResponse: (request, status) => {
      const url = new URL(request.url);
      if (url.origin === origin && core.targeted(request, url))
        core.record({ status, statusOnly: true });
      return lifecycle.onResponse === undefined || lifecycle.onResponse(request, status) === true;
    },
  });
}

/** Forward actual transport responses unchanged; never synthesize Jira outcomes. */
export function qualificationWitness(session) {
  const origin = labSessionConnection(session).httpsOrigin;
  const core = witnessCore();
  return {
    arm: core.arm,
    reset: core.reset,
    effectsStarted: core.effectsStarted,
    markVerified: core.markVerified,
    snapshot: core.snapshot,
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      return async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, origin);
        if (!core.admit(request, url))
          throw new TypeError("Qualification refused an unexpected or repeated native effect");
        const result = await port(request);
        if (core.targeted(request, url) && result.kind === "response")
          core.record(observedBody(result));
        return result;
      };
    },
    /**
     * The private session and avatar transport is not the ordinary body port. It exposes only the
     * product's own lifecycle hooks, so its responses are status-only observations under the same
     * single-effect admission. Responses are never altered.
     */
    privateLifecycle: privateObserver(core, origin),
  };
}

const TASK = "Run the selected synthetic Jira qualification case.";
function admitQualificationTurn(context, chat, now) {
  const clientTurnId = randomUUID();
  const turn = context.deps.store.admitChatTurn(clientTurnId, {
    chatId: chat.id,
    role: "user",
    content: TASK,
    timestamp: now,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  assert.equal(turn.kind, "admitted");
  return { message: turn.userMessage, clientTurnId };
}
async function acceptReadGrant(context, chat, authority, turn, correlationId, now) {
  const grant = requestJiraChatReadGrant(
    context.deps,
    chat.id,
    authority.reference,
    new Date(now).toISOString(),
    correlationId,
  );
  assert.notEqual(grant.kind, "denied");
  if (grant.kind === "review-required")
    await acceptChatToolReadGrant(
      {
        deps: context.deps,
        message: turn.message,
        correlationId,
        publish: async () => undefined,
      },
      grant.grant,
    );
}
async function acceptedContext(context, chat) {
  const now = Date.now();
  const correlationId = randomUUID();
  const turn = admitQualificationTurn(context, chat, now);
  const authority = mintAcceptedJiraChatAuthority(context.deps, {
    chatId: chat.id,
    userMessageId: turn.message.id,
    startedAtMs: now,
    nowMs: now,
    correlationId,
  });
  assert.equal(authority.ok, true);
  await acceptReadGrant(context, chat, authority, turn, correlationId, now);
  const current = {
    chatId: chat.id,
    userMessageId: turn.message.id,
    correlationId,
    runId: authority.envelope.runId,
    authority: authority.reference.envelopeDigest,
    authorityReference: authority.reference,
    authorityExpiresAt: authority.envelope.expiresAt,
    deadlineAt: authority.envelope.expiresAt,
    signal: globalThis.AbortSignal.timeout(
      Math.max(1, Date.parse(authority.envelope.expiresAt) - Date.now()),
    ),
  };
  return { current, turn, authority };
}
function completeQualificationTurn(context, turn) {
  const assistant = context.deps.store.createTurnAssistant(turn.message.id, {
    chatId: turn.message.chatId,
    role: "assistant",
    content: "The qualification call settled.",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const completed = context.deps.store.completeChatTurn(
    turn.message.chatId,
    turn.clientTurnId,
    TASK,
    assistant.id,
  );
  assert.equal(completed.kind, "completed");
}

/**
 * One accepted Chat turn with the product's own protected-input owner and private-session lifetime,
 * composed exactly as the held Chat turn composes them. Nothing here stores a secret value.
 */
export async function openQualificationTurn(context, chat) {
  const accepted = await acceptedContext(context, chat);
  const { current, turn, authority } = accepted;
  const lifetime = createJiraPrivateLifetime(current.signal, current.correlationId);
  const humanInput = createJiraChatHumanInput(
    {
      deps: context.deps,
      message: turn.message,
      authority,
      signal: current.signal,
      correlationId: current.correlationId,
    },
    current,
  );
  Object.assign(current, {
    privateLifetime: lifetime,
    humanInputFor: (operation, digest) => humanInput.selectionFor(operation, digest),
    activeHumanInput: () => humanInput.currentSelection(),
  });
  return { ...accepted, lifetime, humanInput };
}
/** Releases unclaimed input and ends every private session, then settles the turn. */
export async function closeQualificationTurn(context, held) {
  held.humanInput.finish();
  try {
    await held.lifetime.finish();
  } finally {
    completeQualificationTurn(context, held.turn);
  }
}

/**
 * The scripted human submission goes through the product's own authenticated route, so custody
 * binds, revision-checks and consumes it exactly as for a person. Values never leave this call.
 */
function humanInputPorts(context, held, call, provideValues) {
  const { turn, current } = held;
  return {
    requestReadConsent: (grant) =>
      acceptChatToolReadGrant(
        {
          deps: context.deps,
          message: turn.message,
          correlationId: current.correlationId,
          publish: async () => undefined,
        },
        grant,
      ),
    publishHumanInput: async (view) => {
      context.deps.store.updateChatToolTranscript(
        turn.message.id,
        { kind: "human-input", callId: call.id, view },
        current.correlationId,
      );
      if (view.state !== "awaiting-input") return;
      const response = await productRequest(
        context.origin,
        context.cookie,
        "qualification-human-input",
        `/api/atlassian-connectors/human-inputs/${encodeURIComponent(view.requestId)}`,
        { expectedRevision: view.revision, values: await provideValues() },
      );
      await response.body?.cancel();
    },
  };
}

function qualificationReview(context, held, options, call, actionId) {
  const { current, humanInput } = held;
  const writeExchange = (id) =>
    context.deps.store
      .findMessageById(options.message.id)
      ?.toolTranscript?.exchanges.find(
        (exchange) =>
          sha256Hex(canonicalise({ messageId: options.message.id, callId: exchange.call.id })) ===
          id,
      );
  const reviewableWrite = (action) => {
    const exchange = writeExchange(action.actionId);
    return (
      exchange !== undefined &&
      sha256Hex(canonicalise(exchange.call.arguments)) === action.argumentsDigest
    );
  };
  const sourcePreparation = jiraSourcePreparationForTurn(options, current);
  return {
    sourcePreparation,
    consumerPort: createJiraChatCatalogConsumerPort(
      sourcePreparation.sourceDigestFor,
      (id, digest) => humanInput.revisionFor(id, digest),
    ),
    admission: {
      reviewableWrite,
      sourcePreparation,
      ...createJiraChatTurnReviewPorts(options, {
        writeExchange,
        reviewableWrite,
        readAllowed: () => !current.signal.aborted,
      }),
    },
    prepare: async () => {
      const prepared = await sourcePreparation.prepareInvocation(call, actionId);
      if (prepared?.sourceDigest !== undefined)
        context.deps.store.updateChatToolTranscript(
          options.message.id,
          {
            kind: "write-prepared",
            callId: call.id,
            sourceDigest: prepared.sourceDigest,
          },
          current.correlationId,
        );
    },
  };
}

function bind(context, current, managed, review) {
  const counters = {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandExecutions: 0,
    failureAttempts: 0,
    browserNavigations: 0,
  };
  const budget = createHarnessCatalogBudget({
    ...current,
    counters,
    now: Date.now,
    deadlineAt: Date.parse(current.deadlineAt),
    limits: { ...DEFAULT_LIMITS, maxToolCalls: 1 },
  });
  const admission = createJiraChatCatalogAdmission({
    deps: context.deps,
    context: () => current,
    now: Date.now,
    ...review.admission,
  });
  const binder = createCatalogToolBinder(
    {
      ...admission,
      consumerPort: review.consumerPort,
      projection: managed.projection,
      handlerBindings: managed.handlerBindings,
      budgetPort: budget.port,
      logPort: { primary: context.deps.activityLog, diagnostics: defaultServerDiagnosticSink },
    },
    {
      catalog: managed.catalog,
      context: () => current,
      now: Date.now,
      mintId: randomUUID,
      invocationRegistry: createCodingToolInvocationRegistry({ now: Date.now }),
    },
  );
  return { binder, budget, counters };
}

async function prepareQualificationCall(
  context,
  held,
  managed,
  specification,
  args,
  provideValues,
) {
  const { current, turn, authority } = held;
  const operation = jiraOperationForTool(specification.tool);
  const call = {
    id: randomUUID(),
    name: specification.tool.replace(/[.-]/gu, "_"),
    arguments: args,
  };
  const actionId = sha256Hex(canonicalise({ messageId: turn.message.id, callId: call.id }));
  context.deps.store.updateChatToolTranscript(
    turn.message.id,
    {
      kind: "started",
      call,
      ...(specification.mutation ? { operationBinding: operation.binding } : {}),
    },
    current.correlationId,
  );
  const options = {
    deps: context.deps,
    message: turn.message,
    authority,
    managed,
    signal: current.signal,
    correlationId: current.correlationId,
  };
  const review = qualificationReview(context, held, options, call, actionId);
  await review.prepare();
  if (provideValues !== undefined)
    await held.humanInput.prepare(
      call,
      actionId,
      humanInputPorts(context, held, call, provideValues),
    );
  return { call, actionId, options, review, operation };
}

function retainQualificationResult(context, execution, dispatch, budget, humanInput) {
  if (dispatch.kind !== "settled") return;
  const { options, call, actionId, review, operation } = execution;
  budget.acceptReceipt(dispatch.receipt, operation.declaration.descriptor);
  const mutationOutcome = observeJiraChatMutation(
    options,
    call,
    actionId,
    dispatch.result,
    review.sourcePreparation.sourceDigestFor(actionId, sha256Hex(canonicalise(call.arguments))),
    humanInput.revisionFor(actionId, sha256Hex(canonicalise(call.arguments))),
  );
  context.deps.store.updateChatToolTranscript(
    options.message.id,
    {
      kind: "settled",
      callId: call.id,
      result: dispatch.result,
      binding: {
        descriptor: operation.declaration.descriptor,
        projectionDigest: options.managed.projection.projectionDigest,
      },
      ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
    },
    options.correlationId,
  );
}

async function dispatchOnTurn(context, held, specification, args, provideValues) {
  const operation = jiraOperationForTool(specification.tool);
  const managed = await context.deps.jiraChatCatalog.select([specification.identity]);
  let actionId;
  try {
    const execution = await prepareQualificationCall(
      context,
      held,
      managed,
      specification,
      args,
      provideValues,
    );
    actionId = execution.actionId;
    const { binder, budget, counters } = bind(context, held.current, managed, execution.review);
    const toolRef = operation.declaration.descriptor.toolRef;
    const offered = binder.offerTool(toolRef);
    const dispatch = await binder.dispatch(
      {
        kind: "bound",
        toolRef,
        projectionDigest: offered.binding.projectionDigest,
        offerId: offered.offerId,
        arguments: args,
      },
      { actionId, idempotencyKey: actionId },
    );
    retainQualificationResult(context, execution, dispatch, budget, held.humanInput);
    assert.equal(counters.modelCalls, 0);
    return {
      dispatch,
      binding: operation.binding,
      mutation: operation.definition.effects.includes("remote-write"),
      journal: context.deps.store.chatToolMutations.find(actionId),
    };
  } finally {
    if (actionId !== undefined) held.humanInput.finalize(actionId);
    await managed.close();
  }
}

/**
 * Dispatches one operation. A case that holds a private session across several dispatches passes
 * its own turn (`context.heldQualificationTurn`); otherwise the call owns a turn of its own.
 * `provideValues` supplies the scripted protected-input submission; absent, none is ever supplied.
 */
export async function dispatchQualification(context, chat, specification, args, provideValues) {
  const operation = jiraOperationForTool(specification.tool);
  assert.equal(operation?.definition.identity, specification.identity);
  assert.equal(
    operation.definition.effects.includes("remote-write"),
    specification.mutation === true,
  );
  const held = context.heldQualificationTurn;
  if (held !== undefined) return dispatchOnTurn(context, held, specification, args, provideValues);
  const own = await openQualificationTurn(context, chat);
  let failed = true;
  try {
    const result = await dispatchOnTurn(context, own, specification, args, provideValues);
    failed = false;
    return result;
  } finally {
    // A refused or failed call must still free the Chat for the next case; never mask its error.
    await closeQualificationTurn(context, own).catch((error) => {
      if (!failed) throw error;
    });
  }
}
