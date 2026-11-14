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
import { createJiraChatCatalogAdmission } from "../../../packages/keiko-server/dist/atlassian/jiraChatCatalogConsumer.js";
import {
  createJiraChatTurnReviewPorts,
  prepareJiraTurn,
  observeJiraChatMutation,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatToolTurn.js";
import { jiraOperationForTool } from "../../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { createCatalogToolBinder } from "../../../packages/keiko-server/dist/tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "../../../packages/keiko-server/dist/coding-runtime/codingToolInvocationRegistry.js";
import { defaultServerDiagnosticSink } from "../../../packages/keiko-server/dist/diagnostics-log.js";
import { acceptChatToolReadGrant } from "../../../packages/keiko-server/dist/chat-tool-approvals.js";
import {
  classifyQualification,
  matchesNativeIdentity,
  qualificationDigest,
} from "./api-qualification-evidence.mjs";
import { labSessionConnection } from "./lab-client.mjs";
import {
  measuredAssertionCount,
  measuredNativeReadCount,
  measuredNativeReadPaths,
  resetAssertionCount,
} from "./api-qualification-assert.mjs";
import { hasOutcome, productRefusalDetail, succeededOutcome } from "./api-qualification-cause.mjs";
import {
  DISCOVERY_QUERIES,
  discoveryDescriptor,
  proveDiscovery,
} from "./api-qualification-discovery.mjs";

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

function assertCanonicalCleanup(request, url) {
  assert.equal(request.method, "DELETE");
  assert.equal(url.pathname, "/rest/auth/1/session");
  assert.equal(url.search, "");
  assert.equal(request.bodyJson, undefined);
  assert.equal(request.upload, undefined);
  assert.equal(request.jiraHumanInput, undefined);
}
function admitWitnessEffect(owner, read, target) {
  if (read) return;
  if (!target || !owner.selected.mutation || owner.state.effects !== 0) {
    owner.state.blocked += 1;
    throw new TypeError("Qualification refused an unexpected or repeated native effect");
  }
  owner.state.effects += 1;
  owner.started += 1;
}
async function witnessRequest(owner, origin, port, request, canonicalCleanup) {
  const url = new URL(request.url);
  assert.equal(url.origin, origin);
  const target =
    owner.selected && matchesNativeIdentity(owner.selected.identity, request.method, url.pathname);
  // Only the canonical private lifetime may send this fixed cookie-session finalizer.
  if (canonicalCleanup) {
    assertCanonicalCleanup(request, url);
    return port(request);
  }
  admitWitnessEffect(owner, readRequest(request, url), target);
  const result = await port(request);
  if (target && result.kind === "response")
    owner.state.responses.push({
      status: result.status,
      path: url.pathname,
      truncated: result.truncated,
      bodyBytes: result.bodyBytes,
      responseDigest: qualificationDigest(result.bodyText),
    });
  return result;
}
/** Forward actual transport responses unchanged; never synthesize Jira outcomes. */
export function qualificationWitness(session) {
  const origin = labSessionConnection(session).httpsOrigin;
  const owner = {
    selected: undefined,
    state: { blocked: 0, responses: [], effects: 0 },
    started: 0,
  };
  return {
    arm(identity, mutation) {
      owner.selected = { identity, mutation };
      owner.state = { blocked: 0, responses: [], effects: 0 };
    },
    /** Start a case: nothing armed, and no earlier case's effects are attributed to it. */
    reset() {
      owner.selected = undefined;
      owner.state = { blocked: 0, responses: [], effects: 0 };
      owner.started = 0;
    },
    /** Native effects begun and not yet independently verified since the last reset. */
    effectsStarted: () => owner.started,
    /** An auxiliary fixture whose effect an independent readback matched leaves nothing open. */
    markVerified() {
      owner.started = 0;
    },
    snapshot: () => structuredClone(owner.state),
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      let cleanupUsed = false;
      return async (request) => {
        const cleanup = lifecycle?.canonicalPrivateFinalizer === true;
        if (cleanup) {
          assert.equal(cleanupUsed, false, "A canonical private cleanup port is single use");
          cleanupUsed = true;
        }
        return witnessRequest(owner, origin, port, request, cleanup);
      };
    },
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

function qualificationInputPorts(context, options, call, publishHumanInput) {
  return {
    requestReadConsent: async () => {
      throw new TypeError("The accepted qualifier must already hold its real read grant");
    },
    publishHumanInput: async (view) => {
      context.deps.store.updateChatToolTranscript(
        options.message.id,
        { kind: "human-input", callId: call.id, view },
        options.correlationId,
      );
      assert.equal(typeof publishHumanInput, "function", "A protected input owner is required");
      await publishHumanInput(context, view);
    },
  };
}
function qualificationReview(context, preparedTurn, options, call, actionId, publishHumanInput) {
  const { context: current, sourcePreparation, consumerPort, humanInput } = preparedTurn;
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
  return {
    sourcePreparation,
    consumerPort,
    humanInput,
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
      await humanInput.prepare(
        call,
        actionId,
        qualificationInputPorts(context, options, call, publishHumanInput),
      );
    },
  };
}

function bind(context, current, managed, review, maxToolCalls, shared) {
  const counters = shared?.counters ?? {
    iterations: 0,
    modelCalls: 0,
    toolCalls: 0,
    commandExecutions: 0,
    failureAttempts: 0,
    browserNavigations: 0,
  };
  const budget =
    shared?.budget ??
    createHarnessCatalogBudget({
      ...current,
      counters,
      now: Date.now,
      deadlineAt: Date.parse(current.deadlineAt),
      limits: { ...DEFAULT_LIMITS, maxToolCalls },
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
  accepted,
  managed,
  preparedTurn,
  specification,
  args,
) {
  const { current, turn, authority } = accepted;
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
  const review = qualificationReview(
    context,
    preparedTurn,
    options,
    call,
    actionId,
    specification.publishHumanInput,
  );
  await review.prepare();
  return { call, actionId, options, review, operation };
}

export function retainQualificationResult(context, execution, dispatch, budget) {
  if (dispatch.kind !== "settled") return;
  const { options, call, actionId, review, operation } = execution;
  budget.acceptReceipt(dispatch.receipt, operation.declaration.descriptor);
  const mutationOutcome = observeJiraChatMutation(
    options,
    call,
    actionId,
    dispatch.result,
    review.sourcePreparation.sourceDigestFor(actionId, sha256Hex(canonicalise(call.arguments))),
    review.humanInput.revisionFor(actionId, sha256Hex(canonicalise(call.arguments))),
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

function qualificationOperation(specification) {
  const operation = jiraOperationForTool(specification.tool);
  assert.equal(operation?.definition.identity, specification.identity);
  assert.equal(
    operation.definition.effects.includes("remote-write"),
    specification.mutation === true,
  );
  return operation;
}

async function dispatchHeldCall(held, specification, args) {
  const { context, accepted, managed, preparedTurn, maxToolCalls, witness } = held;
  const operation = qualificationOperation(specification);
  witness?.arm(specification.identity, specification.mutation === true);
  const execution = await prepareQualificationCall(
    context,
    accepted,
    managed,
    preparedTurn,
    specification,
    args,
  );
  const { review, actionId } = execution;
  try {
    const bound = bind(context, preparedTurn.context, managed, review, maxToolCalls, held.shared);
    held.shared = { budget: bound.budget, counters: bound.counters };
    const toolRef = operation.declaration.descriptor.toolRef;
    const offered = bound.binder.offerTool(toolRef);
    // Native reads the recipe actually made before this dispatch: the measured presence proof.
    const presenceReads = measuredNativeReadCount();
    const presenceReadPaths = measuredNativeReadPaths();
    const dispatch = await bound.binder.dispatch(
      {
        kind: "bound",
        toolRef,
        projectionDigest: offered.binding.projectionDigest,
        offerId: offered.offerId,
        arguments: args,
      },
      { actionId, idempotencyKey: actionId },
    );
    retainQualificationResult(context, execution, dispatch, bound.budget);
    assert.equal(bound.counters.modelCalls, 0);
    return {
      dispatch,
      binding: operation.binding,
      presenceReads,
      presenceReadPaths,
      mutation: operation.definition.effects.includes("remote-write"),
      journal: context.deps.store.chatToolMutations.find(actionId),
      ...(witness === undefined ? {} : { witness: witness.snapshot() }),
    };
  } finally {
    preparedTurn.humanInput.finalize(actionId);
  }
}

export async function withQualificationLifetime(preparedTurn, _witness, managed, run) {
  try {
    return await run();
  } finally {
    try {
      preparedTurn.humanInput.finish();
    } finally {
      try {
        await preparedTurn.privateLifetime.finish();
      } finally {
        await managed.close();
      }
    }
  }
}

function declaredQualificationTools(specification, discoveryProofRequested = false) {
  qualificationOperation(specification);
  const auxiliary = specification.prerequisiteTools ?? [];
  assert.ok(Array.isArray(auxiliary));
  assert.equal(new Set(auxiliary).size, auxiliary.length);
  assert.ok(!auxiliary.includes(specification.tool));
  // A discovery proof adds one discover (up to three pages) and one describe call to the turn.
  const maxToolCalls = 1 + auxiliary.length + (discoveryProofRequested ? 4 : 0);
  assert.ok(
    maxToolCalls <= DEFAULT_LIMITS.maxToolCalls,
    "The declared turn exceeds its tool budget",
  );
  const operations = auxiliary.map((tool) => {
    const operation = jiraOperationForTool(tool);
    assert.ok(operation, "Every auxiliary tool needs a real product contract");
    return operation;
  });
  if (operations.some((operation) => operation.definition.effects.includes("remote-write"))) {
    assert.equal(specification.administration, true);
    assert.equal(specification.destructiveAdministration, true);
  }
  return { auxiliary, maxToolCalls, operations };
}
async function prepareHeldQualification(context, chat, specification) {
  const { auxiliary, maxToolCalls, operations } = declaredQualificationTools(
    specification,
    context.qualifyDiscovery === true && DISCOVERY_QUERIES[specification.tool] !== undefined,
  );
  const accepted = await acceptedContext(context, chat);
  assert.ok(
    maxToolCalls <= accepted.authority.envelope.budget.maxToolCalls,
    "The declared turn exceeds its accepted Authority Envelope",
  );
  const { current, turn } = accepted;
  const managed = await context.deps.jiraChatCatalog.select([
    specification.identity,
    ...operations.map((operation) => operation.definition.identity),
  ]);
  const preparedTurn = prepareJiraTurn({
    deps: context.deps,
    message: turn.message,
    authority: accepted.authority,
    managed,
    signal: current.signal,
    correlationId: current.correlationId,
  });
  return {
    context,
    accepted,
    managed,
    preparedTurn,
    maxToolCalls,
    witness: context.qualificationWitness,
    auxiliary,
  };
}
/** The readback of an auxiliary fixture runs under the assertion meter like every case's own. */
async function measuredAuxiliaryReadback(context, entry, data) {
  resetAssertionCount();
  const readback = await entry.readback(context, data);
  return { ...readback, measuredAssertionCount: measuredAssertionCount() };
}
async function settleAuxiliary(held, entry, selected) {
  const { context } = held;
  const attempted = await dispatchHeldCall(held, selected, entry.arguments);
  const readback = await measuredAuxiliaryReadback(context, entry, attempted.dispatch.result?.data);
  const runtimeAvailability = classifyQualification({
    ...attempted,
    identity: selected.identity,
    witness: attempted.witness,
    readback,
  });
  assert.equal(
    runtimeAvailability,
    "executable",
    "A held-turn fixture needs verified native evidence",
  );
  return { attempted, readback };
}
function heldFixtureDispatcher(held, auxiliaries) {
  const { context } = held;
  const remaining = new Set(held.auxiliary);
  return async (entry) => {
    assert.ok(remaining.delete(entry.tool), "Only a declared once-only auxiliary call is allowed");
    assert.equal(typeof entry.readback, "function");
    assert.ok(held.witness, "Auxiliary calls require an independently armed native witness");
    const operation = jiraOperationForTool(entry.tool);
    const selected = {
      ...entry,
      identity: operation.definition.identity,
      mutation: operation.definition.effects.includes("remote-write"),
    };
    try {
      const { attempted, readback } = await settleAuxiliary(held, entry, selected);
      // An independently verified auxiliary leaves no native effect open for reconciliation.
      held.witness.markVerified?.();
      auxiliaries.push({ tool: entry.tool, identity: selected.identity, attempted, readback });
      return attempted.dispatch.result.data;
    } catch (error) {
      // A dependent case names the fixture that failed as the cause of its own failure.
      context.qualificationAuxiliaryFailure ??= { tool: entry.tool, identity: selected.identity };
      throw error;
    }
  };
}
/**
 * Finite declared auxiliary calls share exactly one canonical held turn and private lifetime.
 * While the turn is held, `fixtureWrite` routes every auxiliary through `heldQualificationFixture`,
 * so a private-session fixture and its case use the same single admitted turn.
 */
export async function dispatchQualification(context, chat, specification, args) {
  const held = await prepareHeldQualification(context, chat, specification);
  const { preparedTurn, managed } = held;
  const auxiliaries = [];
  const fixture = heldFixtureDispatcher(held, auxiliaries);
  return withQualificationLifetime(preparedTurn, held.witness, managed, async () => {
    context.heldQualificationFixture = fixture;
    try {
      return await runHeldCase(held, specification, args, auxiliaries);
    } finally {
      delete context.heldQualificationFixture;
    }
  });
}
/**
 * The recipe's own verification of the native effect. A settled outcome that is not a success is not
 * verified: it is reported as the product's refusal instead of being thrown as a failed dispatch.
 */
async function verifiedInvocation(held, specification, attempted) {
  const { context } = held;
  const settled = attempted.dispatch.result?.data;
  // Without an explicit outcome there is nothing to verify and nothing to call a refusal.
  if (!hasOutcome(settled)) return {};
  if (!succeededOutcome(settled.outcome)) return { verifyRefused: productRefusalDetail(settled) };
  resetAssertionCount();
  const readback = await specification.verifyInvocation(
    context,
    context.qualificationFixtureState,
    settled,
  );
  return { readback, measuredAssertionCount: measuredAssertionCount() };
}
/** One discovery tool dispatched like the held call itself; returns the settled result's data. */
async function dispatchDiscoveryTool(held, name, args) {
  const { context, accepted, managed, preparedTurn, maxToolCalls } = held;
  const descriptor = await discoveryDescriptor(name);
  const execution = await prepareQualificationCall(
    context,
    accepted,
    managed,
    preparedTurn,
    { tool: name, mutation: false },
    args,
  );
  const { review, actionId } = execution;
  try {
    const bound = bind(context, preparedTurn.context, managed, review, maxToolCalls, held.shared);
    held.shared = { budget: bound.budget, counters: bound.counters };
    const offered = bound.binder.offerTool(descriptor.toolRef);
    const dispatch = await bound.binder.dispatch(
      {
        kind: "bound",
        toolRef: descriptor.toolRef,
        projectionDigest: offered.binding.projectionDigest,
        offerId: offered.offerId,
        arguments: args,
      },
      { actionId, idempotencyKey: actionId },
    );
    retainQualificationResult(
      context,
      { ...execution, operation: { declaration: { descriptor } } },
      dispatch,
      bound.budget,
    );
    assert.equal(dispatch.kind, "settled", `${name} did not settle`);
    return dispatch.result?.data ?? {};
  } finally {
    preparedTurn.humanInput.finalize(actionId);
  }
}

/** The proof of the discovery path for an operation the proof lists, kept on the run's context. */
async function discoveryProofFor(held, specification) {
  const { context } = held;
  if (!context.qualifyDiscovery || DISCOVERY_QUERIES[specification.tool] === undefined) return;
  const proof = await proveDiscovery(specification, (name, args) =>
    dispatchDiscoveryTool(held, name, args),
  );
  (context.discoveryProofs ??= []).push(proof);
}

async function runHeldCase(held, specification, args, auxiliaries) {
  const { context, accepted } = held;
  await specification.prepareInvocation?.(context, context.qualificationFixtureState);
  await discoveryProofFor(held, specification);
  // A preparation may replace source-derived arguments, e.g. the current temporary crop.
  const actualArgs = typeof args === "function" ? args() : args;
  const attempted = await dispatchHeldCall(held, specification, actualArgs);
  const verified =
    specification.verifyInvocation === undefined
      ? {}
      : await verifiedInvocation(held, specification, attempted);
  completeQualificationTurn(context, accepted.turn);
  return { ...attempted, auxiliaries, ...verified };
}
