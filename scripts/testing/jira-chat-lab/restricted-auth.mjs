import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { jsonRequest } from "./chat-read.mjs";
import { chatToolRequest, privateJson, runObservedChatTurn } from "./chat-write.mjs";
import { credential, currentChat } from "./consent-lifecycle.mjs";
import { restrictedRemoteState } from "./restricted-cases.mjs";

const CHAT_PATHS = new Set(["/api/desktop/chat", "/api/desktop/chat/stream"]);
const AUTHENTICATION_CASES = new Set(["jira.assignable-users", "jira.assign"]);

function observeChatResponse(response, state) {
  response.once("finish", () => state.responses.push(response.statusCode));
  const write = response.write.bind(response);
  response.write = (chunk, ...args) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.startsWith("event: cancelled\n")) state.cancelledFrames += 1;
    return write(chunk, ...args);
  };
}

/** Observe the native refusal and public cancellation without altering transport behavior. */
export function restrictedAuthenticationObserver() {
  let active;
  return {
    arm(enabled) {
      active = enabled
        ? { nativeStatuses: [], responses: [], cancelledFrames: 0, grants: 0, approvals: 0 }
        : undefined;
    },
    snapshot: () => structuredClone(active),
    configureServer({ server }) {
      server.prependListener("request", (request, response) => {
        const state = active;
        if (!state || request.method !== "POST") return;
        const path = new URL(request.url, "http://127.0.0.1").pathname;
        if (CHAT_PATHS.has(path)) observeChatResponse(response, state);
        else if (path.endsWith("/chat-read-consent") || path.endsWith("/chat-write-approval"))
          response.once("finish", () => {
            if (response.statusCode !== 200) return;
            if (path.endsWith("/chat-read-consent")) state.grants += 1;
            else state.approvals += 1;
          });
      });
    },
    decorate:
      (factory) =>
      (metadata, correlation, lifecycle = {}) =>
        factory(metadata, correlation, {
          ...lifecycle,
          onResponse: (request, status) => {
            if (
              active &&
              request.method === "GET" &&
              new URL(request.url).pathname.endsWith("/user/assignable/search")
            )
              active.nativeStatuses.push(status);
            return lifecycle.onResponse === undefined
              ? true
              : lifecycle.onResponse(request, status);
          },
        }),
  };
}

function verifyInvalidatedCredential(intent, originalCredential, currentCredential, currentChat) {
  assert.equal(currentCredential.authRef, originalCredential.authRef);
  assert.equal(currentCredential.generation, originalCredential.generation + 1);
  assert.equal(currentCredential.livePod.verificationStatus, "auth-failed");
  assert.equal(currentCredential.livePod.podId, originalCredential.livePod.podId);
  assert.equal(currentChat.id, intent.chatId);
  assert.equal(currentChat.jiraPodBinding.podId, originalCredential.livePod.podId);
  assert.equal(
    currentCredential.livePod.authenticationGeneration,
    originalCredential.livePod.authenticationGeneration + 1,
  );
  assert.equal(
    currentChat.jiraPodBinding.authenticationGeneration,
    currentCredential.livePod.authenticationGeneration,
  );
}

export function verifyAuthenticationInvalidation({
  intent,
  originalCredential,
  currentCredential,
  currentChat,
  messages,
  witness,
  dispatch,
}) {
  assert.ok(AUTHENTICATION_CASES.has(intent.operation));
  const mutation = intent.operation === "jira.assign";
  assert.deepEqual(witness.nativeStatuses, [401]);
  assert.equal(witness.grants, 1);
  assert.equal(witness.approvals, mutation ? 1 : 0);
  assert.deepEqual(witness.responses, [intent.transport === "stream" ? 200 : 499]);
  assert.equal(witness.cancelledFrames, intent.transport === "stream" ? 1 : 0);
  assert.deepEqual(dispatch, { attempts: 0, forwarded: 0, status: 0 });
  verifyInvalidatedCredential(intent, originalCredential, currentCredential, currentChat);
  const users = messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  const user = users[0];
  assert.equal(user.turnState, "cancelled");
  assert.equal(user.toolTranscript.exchanges.length, 1);
  const exchange = user.toolTranscript.exchanges[0];
  assert.equal(exchange.call.name, intent.operation.replace(/[.-]/gu, "_"));
  assert.deepEqual(exchange.call.arguments, intent.arguments);
  assert.equal(exchange.result.status, "cancelled");
  assert.equal(exchange.result.data, null);
  assert.equal(exchange.mutationOutcome, mutation ? "rejected" : undefined);
  return {
    userId: user.id,
    invocationId: exchange.result.invocationId,
    callId: exchange.call.id,
    outcome: "cancelled",
    reason: "auth-failed",
    nativeStatus: 401,
    ...(mutation ? { mutationOutcome: exchange.mutationOutcome } : {}),
  };
}

function messages(context, chat) {
  return jsonRequest(
    context.origin,
    context.cookie,
    "restricted-auth-history",
    `/api/chats/messages?chatId=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
  );
}

async function cancelledHistory(context, chat, intent) {
  const deadline = Date.now() + 5000;
  do {
    const observed = await messages(context, chat);
    const user = observed.messages.find((message) => message.role === "user");
    const exchange = user?.toolTranscript?.exchanges[0];
    if (
      user?.turnState === "cancelled" &&
      exchange?.result &&
      exchange.mutationOutcome === intent.expectedMutationOutcome
    )
      return observed.messages;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new TypeError("Expected the native authentication refusal to cancel the persisted turn");
}

export async function verifyCancelledReplay(context, chat, intent, receipt, authentication) {
  const before = authentication.snapshot();
  const response = await globalThis.fetch(`${context.origin}/api/desktop/chat`, {
    method: "POST",
    headers: {
      Origin: context.origin,
      Cookie: context.cookie,
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(intent.request),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "GROUNDING_SCOPE_CHANGED");
  const after = await messages(context, chat);
  const users = after.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].id, receipt.userId);
  const exchanges = users[0].toolTranscript.exchanges;
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].call.id, receipt.callId);
  assert.equal(exchanges[0].result.invocationId, receipt.invocationId);
  assert.equal(exchanges[0].result.status, "cancelled");
  assert.deepEqual(authentication.snapshot(), { ...before, responses: [...before.responses, 409] });
}

export async function runRestrictedAuthenticationCase(
  context,
  chat,
  group,
  observer,
  authentication,
) {
  const intent = group.current;
  const originalCredential = await credential(context, chat.jiraPodBinding.podId);
  intent.request = chatToolRequest(context, chat, intent);
  privateJson(group.pendingPath, group);
  let cancelled = false;
  try {
    await runObservedChatTurn(context, chat, {
      ...intent,
      assertUnchanged: async () => {
        const state = await restrictedRemoteState(context.session);
        assert.equal(state.count, intent.before.count);
        assert.equal(state.digest, intent.before.digest);
      },
    });
  } catch {
    cancelled = true;
  }
  intent.observedAuthentication = authentication.snapshot();
  intent.observedDispatch = observer.snapshot();
  privateJson(group.pendingPath, group);
  assert.equal(cancelled, true);
  const history = await cancelledHistory(context, chat, intent);
  const receipt = verifyAuthenticationInvalidation({
    intent,
    originalCredential,
    currentCredential: await credential(context, chat.jiraPodBinding.podId),
    currentChat: await currentChat(context, chat.id),
    messages: history,
    witness: authentication.snapshot(),
    dispatch: observer.snapshot(),
  });
  await verifyCancelledReplay(context, chat, intent, receipt, authentication);
  return {
    ...receipt,
    canonicalReplayPreserved: true,
    decisions: { grants: 1, approvals: authentication.snapshot().approvals },
    dispatch: observer.snapshot(),
  };
}
