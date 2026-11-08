// Select and dispatch the real application-owned catalog, including accepted-turn authority.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { createHarnessCatalogBudget, DEFAULT_LIMITS } from "@oscharko-dev/keiko-harness";
import {
  mintAcceptedJiraChatAuthority,
  requestJiraChatReadGrant,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
} from "../../../packages/keiko-server/dist/atlassian/jiraChatCatalogConsumer.js";
import { jiraOperationForTool } from "../../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { createCatalogToolBinder } from "../../../packages/keiko-server/dist/tool-catalog/catalogToolDispatch.js";
import { createCodingToolInvocationRegistry } from "../../../packages/keiko-server/dist/coding-runtime/codingToolInvocationRegistry.js";
import { defaultServerDiagnosticSink } from "../../../packages/keiko-server/dist/diagnostics-log.js";
import { acceptChatToolReadGrant } from "../../../packages/keiko-server/dist/chat-tool-approvals.js";
import { matchesNativeIdentity, qualificationDigest } from "./api-qualification-evidence.mjs";
import { labSessionConnection } from "./lab-client.mjs";

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

/** Forward actual transport responses unchanged; never synthesize Jira outcomes. */
export function qualificationWitness(session) {
  const origin = labSessionConnection(session).httpsOrigin;
  let selected;
  let state = { blocked: 0, responses: [], effects: 0 };
  return {
    arm(identity, mutation) {
      selected = { identity, mutation };
      state = { blocked: 0, responses: [], effects: 0 };
    },
    snapshot: () => structuredClone(state),
    decorate: (factory) => (metadata, correlation, lifecycle) => {
      const port = factory(metadata, correlation, lifecycle);
      return async (request) => {
        const url = new URL(request.url);
        assert.equal(url.origin, origin);
        const target =
          selected && matchesNativeIdentity(selected.identity, request.method, url.pathname);
        const read = readRequest(request, url);
        if (!read && (!target || !selected.mutation || state.effects !== 0)) {
          state.blocked += 1;
          throw new TypeError("Qualification refused an unexpected or repeated native effect");
        }
        if (!read) state.effects += 1;
        const result = await port(request);
        if (target && result.kind === "response")
          state.responses.push({
            status: result.status,
            truncated: result.truncated,
            bodyBytes: result.bodyBytes,
            responseDigest: qualificationDigest(result.bodyText),
          });
        return result;
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
  return { current, turn };
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

function bind(context, current, managed) {
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
  });
  const binder = createCatalogToolBinder(
    {
      ...admission,
      consumerPort: jiraChatCatalogConsumerPort,
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

export async function dispatchQualification(context, chat, specification, args) {
  const operation = jiraOperationForTool(specification.tool);
  assert.equal(operation?.definition.identity, specification.identity);
  assert.equal(
    operation.definition.effects.includes("remote-write"),
    specification.mutation === true,
  );
  const { current, turn } = await acceptedContext(context, chat);
  const managed = await context.deps.jiraChatCatalog.select([specification.identity]);
  try {
    const { binder, budget, counters } = bind(context, current, managed);
    const toolRef = operation.declaration.descriptor.toolRef;
    const offered = binder.offerTool(toolRef);
    const actionId = randomUUID();
    const dispatch = await binder.dispatch(
      {
        kind: "bound",
        toolRef,
        projectionDigest: offered.binding.projectionDigest,
        offerId: offered.offerId,
        arguments: args,
      },
      { actionId, idempotencyKey: randomUUID() },
    );
    if (dispatch.kind === "settled")
      budget.acceptReceipt(dispatch.receipt, operation.declaration.descriptor);
    assert.equal(counters.modelCalls, 0);
    completeQualificationTurn(context, turn);
    return {
      dispatch,
      binding: operation.binding,
      mutation: operation.definition.effects.includes("remote-write"),
      journal: context.deps.store.chatToolMutations.find(actionId),
    };
  } finally {
    await managed.close();
  }
}
