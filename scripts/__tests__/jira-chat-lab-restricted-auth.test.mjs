import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  restrictedAuthenticationObserver,
  verifyAuthenticationInvalidation,
} from "../testing/jira-chat-lab/restricted-auth.mjs";
import { restrictedReadExpectation } from "../testing/jira-chat-lab/restricted-catalog-cases.mjs";

function fixture(transport = "buffered") {
  return {
    intent: {
      transport,
      operation: "jira.assignable-users",
      chatId: "chat",
      arguments: { issueKey: "ISOLATED-1", query: "synthetic" },
    },
    originalCredential: {
      authRef: "ref",
      generation: 1,
      livePod: { podId: "pod", authenticationGeneration: 1 },
    },
    currentCredential: {
      authRef: "ref",
      generation: 2,
      livePod: { podId: "pod", authenticationGeneration: 2, verificationStatus: "auth-failed" },
    },
    currentChat: { id: "chat", jiraPodBinding: { podId: "pod", authenticationGeneration: 2 } },
    messages: [
      {
        id: "user",
        role: "user",
        turnState: "cancelled",
        toolTranscript: {
          exchanges: [
            {
              call: {
                id: "call",
                name: "jira_assignable_users",
                arguments: { issueKey: "ISOLATED-1", query: "synthetic" },
              },
              result: { invocationId: "invocation", status: "cancelled", data: null },
            },
          ],
        },
      },
    ],
    witness: {
      nativeStatuses: [401],
      grants: 1,
      approvals: 0,
      responses: [transport === "stream" ? 200 : 499],
      cancelledFrames: transport === "stream" ? 1 : 0,
    },
    dispatch: { attempts: 0, forwarded: 0, status: 0 },
  };
}

describe("native restricted Jira authentication refusal", () => {
  it("preserves the observed401 only for the specific endpoint and keeps other authentication failures unqualified", () => {
    expect(restrictedReadExpectation("jira.assignable-users", "name", { status: 401 })).toEqual({
      outcome: "cancelled",
      referenceStatus: 401,
      credentialInvalidationExpected: true,
    });
    expect(() => restrictedReadExpectation("jira.issue", "key", { status: 401 })).toThrow();
  });

  it.each(["buffered", "stream"])(
    "requires the full custody and cancellation chain through%s",
    (transport) => {
      expect(verifyAuthenticationInvalidation(fixture(transport))).toMatchObject({
        outcome: "cancelled",
        reason: "auth-failed",
        nativeStatus: 401,
        userId: "user",
        invocationId: "invocation",
      });
    },
  );

  it("keeps the known pre-dispatch assignment rejection separate from cancelled delivery", () => {
    const f = fixture();
    f.intent.operation = "jira.assign";
    f.intent.expectedMutationOutcome = "rejected";
    f.intent.arguments = { issueKey: "ISOLATED-1", assigneeName: "synthetic" };
    const exchange = f.messages[0].toolTranscript.exchanges[0];
    exchange.call = { ...exchange.call, name: "jira_assign", arguments: f.intent.arguments };
    exchange.mutationOutcome = "rejected";
    f.witness.approvals = 1;
    expect(verifyAuthenticationInvalidation(f)).toMatchObject({ mutationOutcome: "rejected" });
    exchange.mutationOutcome = "unknown";
    expect(() => verifyAuthenticationInvalidation(f)).toThrow();
  });

  it.each([
    [
      "permission substitution",
      (f) => {
        f.witness.nativeStatuses = [403];
      },
    ],
    [
      "repeated request",
      (f) => {
        f.witness.nativeStatuses.push(401);
      },
    ],
    [
      "missing consent",
      (f) => {
        f.witness.grants = 0;
      },
    ],
    [
      "normal successful response",
      (f) => {
        f.witness.responses = [200];
      },
    ],
    [
      "stale credential",
      (f) => {
        f.currentCredential.generation = 1;
      },
    ],
    [
      "still-ready Pod",
      (f) => {
        f.currentCredential.livePod.verificationStatus = "ok";
      },
    ],
    [
      "stale binding",
      (f) => {
        f.currentChat.jiraPodBinding.authenticationGeneration = 1;
      },
    ],
    [
      "different Chat",
      (f) => {
        f.currentChat.id = "other-chat";
      },
    ],
    [
      "different Pod",
      (f) => {
        f.currentChat.jiraPodBinding.podId = "other-pod";
      },
    ],
    [
      "mutation attempt",
      (f) => {
        f.dispatch.attempts = 1;
      },
    ],
    [
      "completed turn",
      (f) => {
        f.messages[0].turnState = "completed";
      },
    ],
    [
      "model data after cancellation",
      (f) => {
        f.messages[0].toolTranscript.exchanges[0].result.data = { outcome: "failed" };
      },
    ],
  ])("rejects an incomplete or misleading qualification: %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => verifyAuthenticationInvalidation(f)).toThrow();
  });

  it.each([true, false, undefined])(
    "preserves the exact custody ACK callback result:%s",
    (returned) => {
      const observer = restrictedAuthenticationObserver();
      observer.arm(true);
      const lifecycle = { beforeDispatch: vi.fn(), onResponse: vi.fn(() => returned) };
      const factory = vi.fn((_metadata, _correlation, options) => options);
      const port = observer.decorate(factory)({ authRef: "ref" }, "correlation", lifecycle);
      const request = {
        method: "GET",
        url: "https://synthetic.invalid/rest/api/2/user/assignable/search",
      };
      expect(port.onResponse(request, 401)).toBe(returned);
      expect(port.beforeDispatch).toBe(lifecycle.beforeDispatch);
      expect(lifecycle.onResponse).toHaveBeenCalledWith(request, 401);
      expect(observer.snapshot().nativeStatuses).toEqual([401]);
    },
  );

  it("observes public cancellation and consent without changing emitted frames", () => {
    const observer = restrictedAuthenticationObserver();
    const server = new EventEmitter();
    observer.configureServer({ server });
    observer.arm(true);
    const consent = Object.assign(new EventEmitter(), { statusCode: 200 });
    server.emit(
      "request",
      { method: "POST", url: "/api/atlassian-connectors/action-approvals/grant/chat-read-consent" },
      consent,
    );
    consent.emit("finish");
    const write = vi.fn(() => true);
    const stream = Object.assign(new EventEmitter(), { statusCode: 200, write });
    server.emit("request", { method: "POST", url: "/api/desktop/chat/stream" }, stream);
    const frame = Buffer.from("event: cancelled\ndata: {}\n\n");
    expect(stream.write(frame)).toBe(true);
    stream.emit("finish");
    expect(write).toHaveBeenCalledWith(frame);
    expect(observer.snapshot()).toEqual({
      nativeStatuses: [],
      responses: [200],
      cancelledFrames: 1,
      grants: 1,
      approvals: 0,
    });
  });
});
