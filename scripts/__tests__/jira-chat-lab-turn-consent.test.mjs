import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runObservedChatTurn } from "../testing/jira-chat-lab/chat-write.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const context = {
  origin: "http://127.0.0.1:1983",
  cookie: "fixture-cookie",
  projectPath: "fixture-project",
  modelId: "fixture-model",
  session: {},
};
const chat = {
  id: "chat",
  groundingScopeIdentity: "scope",
  jiraPodBinding: { podId: "pod", bindingGeneration: 2, authenticationGeneration: 3 },
};
const args = { issueKey: "KEIKO-1", body: "Synthetic fixture" };
function grant(id, state) {
  return {
    kind: "jira-chat-read",
    grantId: id,
    chatId: chat.id,
    ...chat.jiraPodBinding,
    disclosureVersion: 1,
    state,
    expiresAt: Date.now() + 60_000,
  };
}
function row(id, readGrant, withApproval = true) {
  return {
    id,
    role: "user",
    toolTranscript: {
      readGrant,
      exchanges: withApproval
        ? [
            {
              call: { name: "jira_comment", arguments: args },
              approval: {
                approvalId: `${id}-approval`,
                operation: "jira.comment",
                state: "pending",
                actionDigest: `${id}-digest`,
              },
            },
          ]
        : [],
    },
  };
}
function json(value) {
  return new globalThis.Response(JSON.stringify(value));
}
function pendingTurn(current, signal) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => resolve(json({ messages: [current] })), 100);
    signal.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(new TypeError("Fixture request aborted"));
    });
  });
}
function consentReply(id, method, state, options) {
  const owner = id === "existing-grant" ? state.previous : state.current;
  const view = owner.toolTranscript.readGrant;
  if (method === "POST") view.state = "granted";
  if (method === "GET") state.grantReads += 1;
  return json({
    approval: {
      ...view,
      ...options.grantPatch,
      ...(options.revokeBeforeWrite && state.grantReads > 1 ? { state: "revoked" } : {}),
    },
  });
}
function fixtureFetch(state, options) {
  return vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/chats/messages") {
      const admitted = options.ambiguous
        ? [state.current, row("other", grant("other-grant", "pending"))]
        : [state.current];
      return json({ messages: state.sent ? [state.previous, ...admitted] : [state.previous] });
    }
    if (path === "/api/desktop/chat") {
      state.sent = true;
      return pendingTurn(state.current, init.signal);
    }
    const id = path.split("/").at(-2);
    if (init.method === "POST") state.posts.push(id);
    if (path.endsWith("/chat-read-consent")) return consentReply(id, init.method, state, options);
    const owner = id === "previous-approval" ? state.previous : state.current;
    const approval = owner.toolTranscript.exchanges[0].approval;
    return json({
      approval: { ...approval, state: init.method === "POST" ? "approved" : "pending" },
    });
  });
}
function fixture(options = {}) {
  const reuse = options.reuse === true;
  const previous = row("previous", grant("existing-grant", reuse ? "granted" : "pending"), !reuse);
  const current = row(
    "current",
    reuse && !options.unexpectedGrant ? undefined : grant("new-grant", "pending"),
  );
  const state = { previous, current, sent: false, grantReads: 0, posts: [] };
  const fetch = fixtureFetch(state, options);
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const intent = {
    clientTurnId: "new-canonical-turn",
    mode: "governed-assist",
    transport: "buffered",
    operation: "jira.comment",
    arguments: args,
    assertUnchanged: async () => undefined,
    ...(reuse ? { expectedReadGrants: 0, reusedReadGrantId: "existing-grant" } : {}),
  };
  return { intent, posts: state.posts, fetch };
}

describe("live Chat consent follows the admitted canonical turn", () => {
  it("ignores old pending grants and approvals while observing the new user row", async () => {
    const f = fixture();
    const observed = await runObservedChatTurn(context, chat, f.intent);
    expect(f.posts).toEqual(["new-grant", "current-approval"]);
    expect(observed.decisions).toEqual({ grants: 1, approvals: 1 });
  });

  it("reuses a verified existing grant for a later concrete approval", async () => {
    const f = fixture({ reuse: true });
    const observed = await runObservedChatTurn(context, chat, f.intent);
    expect(f.posts).toEqual(["current-approval"]);
    expect(observed.decisions).toEqual({ grants: 0, approvals: 1 });
    expect(
      f.fetch.mock.calls.filter(
        ([url, init]) => url.endsWith("existing-grant/chat-read-consent") && init.method === "GET",
      ),
    ).toHaveLength(2);
  });

  it("never silently grants fresh disclosure during a consent-reuse proof", async () => {
    const f = fixture({ reuse: true, unexpectedGrant: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it("refuses concurrent new user rows before granting or approving either action", async () => {
    const f = fixture({ ambiguous: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it("rechecks reused consent before the concrete write approval", async () => {
    const f = fixture({ reuse: true, revokeBeforeWrite: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it.each([
    { state: "pending" },
    { chatId: "other-chat" },
    { podId: "other-pod" },
    { bindingGeneration: 9 },
    { authenticationGeneration: 9 },
    { expiresAt: 0 },
  ])("rejects an unusable reused grant before sending the new turn: %j", async (grantPatch) => {
    const f = fixture({ reuse: true, grantPatch });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
    expect(f.fetch.mock.calls.some(([url]) => url.endsWith("/api/desktop/chat"))).toBe(false);
  });
});
