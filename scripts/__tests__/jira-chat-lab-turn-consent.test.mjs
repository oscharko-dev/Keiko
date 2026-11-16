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
const WRITE_APPROVAL_ROUTE = "/api/atlassian-connectors/chat-write-approval/";
const READ_CONSENT_SUFFIX = "/chat-read-consent";
/** The approval id from the canonical write-approval template; any other route fails closed. */
function approvalIdOf(path) {
  const segments = path.split("/");
  if (path.startsWith(WRITE_APPROVAL_ROUTE) && segments.length === 5) {
    return decodeURIComponent(segments[4]);
  }
  // The retired read-consent route named the approval before its suffix.
  if (path.endsWith(READ_CONSENT_SUFFIX)) return segments.at(-2);
  throw new TypeError("Unexpected fixture approval route");
}
function fixtureFetch(state, options) {
  return vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/chats/messages") {
      const admitted = options.ambiguous
        ? [state.current, row("other", grant("other-grant", "granted"))]
        : [state.current];
      return json({ messages: state.sent ? [state.previous, ...admitted] : [state.previous] });
    }
    if (path === "/api/desktop/chat") {
      state.sent = true;
      return pendingTurn(state.current, init.signal);
    }
    const id = approvalIdOf(path);
    if (init.method === "POST") state.posts.push(id);
    // The read-consent route is retired: no call may ever reach it.
    if (path.endsWith("/chat-read-consent")) {
      state.consentCalls.push(id);
      return new globalThis.Response("{}", { status: 404 });
    }
    const owner = id === "previous-approval" ? state.previous : state.current;
    const approval = owner.toolTranscript.exchanges[0].approval;
    return json({
      approval: { ...approval, state: init.method === "POST" ? "approved" : "pending" },
    });
  });
}
function fixture(options = {}) {
  const reuse = options.reuse === true;
  const previous = row("previous", grant("existing-grant", "granted"), !reuse);
  const current = row(
    "current",
    (reuse && !options.unexpectedGrant) || options.noGrant
      ? undefined
      : grant("new-grant", options.pendingGrant ? "pending" : "granted"),
  );
  const state = { previous, current, sent: false, consentCalls: [], posts: [] };
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
    ...(reuse
      ? {
          expectedReadGrants: 0,
          reusedReadGrant: { ...previous.toolTranscript.readGrant, ...options.grantPatch },
        }
      : {}),
  };
  return { intent, posts: state.posts, consentCalls: state.consentCalls, fetch };
}

describe("live Chat reads on a server-established grant and approves only the write", () => {
  it("ignores old approvals while observing the new user row and never decides a read", async () => {
    const f = fixture();
    const observed = await runObservedChatTurn(context, chat, f.intent);
    expect(f.posts).toEqual(["current-approval"]);
    expect(f.consentCalls).toEqual([]);
    expect(observed.decisions).toEqual({ grants: 1, approvals: 1 });
  });

  it("reuses the verified existing grant for a later concrete approval", async () => {
    const f = fixture({ reuse: true });
    const observed = await runObservedChatTurn(context, chat, f.intent);
    expect(f.posts).toEqual(["current-approval"]);
    expect(f.consentCalls).toEqual([]);
    expect(observed.decisions).toEqual({ grants: 0, approvals: 1 });
  });

  it("requires a fresh disclosure to leave a server-established grant on the transcript", async () => {
    const f = fixture({ noGrant: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.consentCalls).toEqual([]);
  });

  it("refuses a grant-reuse proof that names no exact grant", async () => {
    const f = fixture({ reuse: true });
    delete f.intent.reusedReadGrant;
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it("refuses a read grant that still waits for a person and never calls the retired route", async () => {
    const f = fixture({ pendingGrant: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
    expect(f.consentCalls).toEqual([]);
  });

  it("never silently accepts a fresh disclosure during a grant-reuse proof", async () => {
    const f = fixture({ reuse: true, unexpectedGrant: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it("refuses concurrent new user rows before approving either action", async () => {
    const f = fixture({ ambiguous: true });
    await expect(runObservedChatTurn(context, chat, f.intent)).rejects.toThrow();
    expect(f.posts).toEqual([]);
  });

  it("rechecks the reused grant's lifetime before the concrete write approval", async () => {
    const f = fixture({ reuse: true });
    const lifetimes = [Date.now() + 60_000, 0];
    const reused = { ...f.intent.reusedReadGrant };
    Object.defineProperty(reused, "expiresAt", {
      get: () => lifetimes.shift() ?? 0,
      enumerable: true,
    });
    f.intent.reusedReadGrant = reused;
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
