import assert from "node:assert/strict";
import { URL } from "node:url";
import { Buffer } from "node:buffer";

function eventFromChunk(chunk) {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (text.length > 2_000_000) return undefined;
  const frame = /^event: ([\w-]+)\ndata: (.*)\n\n$/u.exec(text);
  return frame ? { event: frame[1], data: JSON.parse(frame[2]) } : undefined;
}

function verifyCommitted(store, payload, messageId, chatId) {
  assert.equal(payload.chat.id, chatId);
  const user = store.findMessageById(messageId);
  assert.equal(user?.chatId, chatId);
  assert.equal(user?.turnState, "completed");
  assert.ok(payload.messages.some((message) => message.id === messageId));
  const emitted = payload.messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(emitted);
  const assistant = store.findMessageById(emitted.id);
  assert.equal(assistant?.chatId, chatId);
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.content, emitted.content);
  assert.ok(assistant.content.trim().length > 0);
  return { messages: [user, assistant] };
}

function isTargetCompletion(frame, messageId, chatId) {
  return frame?.event === "done" && messageId !== undefined && frame.data.chat.id === chatId;
}

function installResponseObserver(server, store, observe, state) {
  server.prependListener("request", (request, response) => {
    if (request.method !== "POST") return;
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/api/desktop/chat") state.bufferedRequests += 1;
    if (path !== "/api/desktop/chat/stream") return;
    state.streamRequests += 1;
    const write = response.write.bind(response);
    response.write = (chunk, ...args) => {
      try {
        if (!observe(eventFromChunk(chunk), store)) return write(chunk, ...args);
      } catch {
        state.witnessFailures += 1;
      }
      response.destroy();
      return false;
    };
  });
}

/** Test-only socket fault after the production store has completed the exact approved turn. */
export function dropCommittedBrowserCompletion(targetChatId, onCommitted) {
  const state = {
    streamRequests: 0,
    bufferedRequests: 0,
    grants: 0,
    approvals: 0,
    readStateFrames: 0,
    approvalStateFrames: 0,
    drops: 0,
    witnessFailures: 0,
  };
  let messageId;
  function observe(frame, store) {
    if (frame?.event === "tool-read-consent" && frame.data.grant.chatId === targetChatId()) {
      messageId = frame.data.messageId;
      state.readStateFrames += 1;
      state.grants += Number(frame.data.grant.state === "pending");
    }
    if (frame?.event === "tool-write-approval" && frame.data.messageId === messageId) {
      state.approvalStateFrames += 1;
      state.approvals += Number(frame.data.approval.state === "pending");
    }
    if (!isTargetCompletion(frame, messageId, targetChatId()) || state.drops !== 0) return false;
    assert.equal(state.grants, 1);
    assert.equal(state.approvals, 1);
    const canonical = verifyCommitted(store, frame.data, messageId, targetChatId());
    onCommitted(canonical);
    state.drops += 1;
    return true;
  }
  function configureServer({ server, store }) {
    installResponseObserver(server, store, observe, state);
  }
  function assertDropped() {
    assert.equal(state.witnessFailures, 0);
    assert.equal(state.drops, 1);
    assert.equal(state.grants, 1);
    assert.equal(state.approvals, 1);
  }
  return { configureServer, assertDropped, snapshot: () => ({ ...state }) };
}

/** Read browser-retained request metadata; no new request or automatic replay is issued here. */
export async function verifyBrowserStreamFailure(page, clientTurnId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const requests = await page.requests();
    const stream = requests.find(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/desktop/chat/stream" &&
        request.postDataJSON().clientTurnId === clientTurnId,
    );
    if (stream?.failure() !== null && stream?.failure() !== undefined) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new TypeError("Browser did not observe the targeted stream interruption");
}
