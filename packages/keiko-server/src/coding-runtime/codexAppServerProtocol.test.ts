import { describe, expect, it } from "vitest";

import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";

import {
  CODEX_APP_SERVER_CLIENT_METHODS,
  CODEX_APP_SERVER_SCHEMA,
  createCodexAppServerJsonlDecoder,
  parseCodexAppServerJsonl,
  projectCodexAppServerMessage,
  projectCodexAppServerResponse,
  validateCodexAppServerClientRequest,
} from "./codexAppServerProtocol.js";

describe("Codex app-server 0.144.1 protocol boundary", () => {
  it("pins the reviewed schema identity and closed client allowlist", () => {
    expect(CODEX_APP_SERVER_SCHEMA).toEqual({
      version: "0.144.1",
      digest: "05463d8615d2a277cf3be6ee15a84398c5e2ce2307b93415602499dc3e07880a",
      algorithm: "keiko-codex-schema-bundle-v1",
    });
    expect(CODEX_APP_SERVER_CLIENT_METHODS).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/login/start",
      "account/login/cancel",
      "account/logout",
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ]);
  });

  it("accepts generated-compatible, closed, server-owned request subsets", () => {
    for (const [method, params] of [
      ["initialize", initializeParams()],
      ["account/read", {}],
      ["account/login/start", { type: "chatgpt" }],
      ["account/login/start", { type: "chatgptDeviceCode" }],
      ["account/login/cancel", { loginId: "l1" }],
      ["account/logout", null],
      ["thread/start", {}],
      ["turn/start", { threadId: "t1", input: [{ type: "text", text: "fix it" }] }],
      ["turn/interrupt", { threadId: "t1", turnId: "u1" }],
    ] as const)
      expect(validateCodexAppServerClientRequest(method, params)).toEqual({
        ok: true,
        value: undefined,
      });
    for (const [method, params] of [
      ["initialize", { clientInfo: { name: "keiko", version: "1" } }],
      ["account/read", { refreshToken: true }],
      ["account/login/cancel", null],
      ["thread/start", { cwd: "/private", modelProvider: "override" }],
      ["turn/start", { threadId: "t1", input: [], approvalPolicy: "never" }],
      ["account/login/start", { type: "apiKey" }],
      ["account/login/start", { type: "chatgptAuthTokens" }],
      ["account/token/refresh", {}],
      ["exec/run", {}],
      ["file/write", {}],
      ["config/set", {}],
      ["fs/read", {}],
      ["plugin/install", {}],
      ["mcp/server/add", {}],
      ["approval/set", {}],
    ] as const)
      expect(validateCodexAppServerClientRequest(method, params)).toEqual({
        ok: false,
        reason: "method-denied",
      });
  });

  it("decodes fragmented/multiple/CRLF frames and rejects malformed, duplicate, deep, and oversized JSON", () => {
    const decoder = createCodexAppServerJsonlDecoder();
    expect(decoder.push('{"id":1,"result":')).toEqual({ ok: true, value: [] });
    expect(decoder.push('{}}\r\n{"id":2,"result":{}}\r\n')).toMatchObject({
      ok: true,
      value: [{ id: 1 }, { id: 2 }],
    });
    for (const input of [
      "not-json\n",
      '{"id":1,"id":2,"result":{}}\n',
      `${"[".repeat(65)}${"]".repeat(65)}\n`,
    ])
      expect(parseCodexAppServerJsonl(input)).toEqual({ ok: false, reason: "frame-invalid" });
    expect(parseCodexAppServerJsonl(`${"x".repeat(64 * 1024)}\n`)).toEqual({
      ok: false,
      reason: "frame-oversized",
    });
  });

  it("bounds JSONL chunks, pending input, and decoded batches without retaining unbounded messages", () => {
    const validNotification = '{"method":"account/updated","params":{}}\n';
    const boundary = createCodexAppServerJsonlDecoder();
    const boundaryResult = boundary.push(validNotification.repeat(256));
    expect(boundaryResult).toMatchObject({ ok: true });
    if (boundaryResult.ok) expect(boundaryResult.value).toHaveLength(256);

    const overBatch = createCodexAppServerJsonlDecoder();
    expect(overBatch.push(validNotification.repeat(257))).toEqual({
      ok: false,
      reason: "frame-invalid",
    });
    expect(overBatch.push(validNotification)).toEqual({ ok: false, reason: "frame-invalid" });

    const overChunk = createCodexAppServerJsonlDecoder();
    expect(overChunk.push("x".repeat(1024 * 1024 + 1))).toEqual({
      ok: false,
      reason: "frame-oversized",
    });
    expect(overChunk.finish()).toEqual({ ok: false, reason: "frame-oversized" });
  });

  it("projects generated-compatible initialize, auth, thread, and turn responses", () => {
    expect(
      projectCodexAppServerResponse("initialize", {
        codexHome: "/isolated",
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "codex-cli/0.144.1",
      }),
    ).toMatchObject({ ok: true });
    expect(projectCodexAppServerResponse("account/read", { requiresOpenaiAuth: false })).toEqual({
      ok: true,
      value: { authenticated: false, authMode: null, requiresOpenaiAuth: false },
    });
    expect(
      projectCodexAppServerResponse("account/read", {
        account: { type: "chatgpt", email: null, planType: "enterprise" },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      ok: true,
      value: { authenticated: true, authMode: "chatgpt", requiresOpenaiAuth: true },
    });
    expect(
      projectCodexAppServerResponse("account/login/start", {
        type: "chatgpt",
        authUrl: "https://auth.example.test",
        loginId: "l1",
      }),
    ).toEqual({
      ok: true,
      value: { type: "chatgpt", authUrl: "https://auth.example.test", loginId: "l1" },
    });
    expect(
      projectCodexAppServerResponse("account/login/start", {
        type: "chatgptDeviceCode",
        verificationUrl: "https://device.example.test",
        userCode: "ABCD",
        loginId: "l2",
      }),
    ).toMatchObject({ ok: true, value: { type: "chatgptDeviceCode", userCode: "ABCD" } });
    expect(projectCodexAppServerResponse("account/login/cancel", { status: "canceled" })).toEqual({
      ok: true,
      value: { status: "canceled" },
    });
    expect(projectCodexAppServerResponse("account/logout", {})).toEqual({
      ok: true,
      value: { completed: true },
    });
    expect(projectCodexAppServerResponse("thread/start", threadStartResponse())).toEqual({
      ok: true,
      value: { threadId: "t1" },
    });
    expect(projectCodexAppServerResponse("turn/start", { turn: turn("u1") })).toEqual({
      ok: true,
      value: { turnId: "u1" },
    });
    expect(projectCodexAppServerResponse("turn/interrupt", {})).toEqual({
      ok: true,
      value: { completed: true },
    });
  });

  it("rejects upstream response variants and schema drift outside the reviewed projection", () => {
    for (const [method, result] of [
      ["account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true }],
      [
        "account/read",
        {
          account: { type: "chatgpt", email: null, planType: "invalid" },
          requiresOpenaiAuth: true,
        },
      ],
      ["account/login/start", { type: "apiKey" }],
      ["account/login/start", { type: "chatgptAuthTokens" }],
      ["account/login/cancel", { status: "unknown" }],
      ["thread/start", { thread: { id: "t1" } }],
      ["turn/start", { turn: { id: "u1" } }],
    ] as const)
      expect(projectCodexAppServerResponse(method, result)).toEqual({
        ok: false,
        reason: "message-denied",
      });
  });

  it("uses actual dynamic-tool and content-free auth notification shapes", () => {
    expect(
      projectCodexAppServerMessage({
        id: 2,
        method: "item/tool/call",
        params: {
          threadId: "t1",
          turnId: "u1",
          callId: "c1",
          tool: "keiko_lookup",
          arguments: { query: "private prompt" },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "tool-call",
        id: 2,
        threadId: "t1",
        turnId: "u1",
        callId: "c1",
        tool: "keiko_lookup",
        arguments: { query: "private prompt" },
      },
    });
    for (const params of [
      { threadId: "t1", turnId: "u1", callId: "c1", tool: "exec", arguments: {} },
      {
        threadId: "t1",
        turnId: "u1",
        callId: "c1",
        tool: "keiko_lookup",
        arguments: { token: "secret" },
      },
      ...["auth_token", "authTokens", "refresh-token", "refreshTokens", "ACCESS_TOKEN"].map(
        (key) => ({
          threadId: "t1",
          turnId: "u1",
          callId: "c1",
          tool: "keiko_lookup",
          arguments: { nested: { [key]: "secret" } },
        }),
      ),
    ])
      expect(projectCodexAppServerMessage({ id: 2, method: "item/tool/call", params })).toEqual({
        ok: false,
        reason: "message-denied",
      });
    expect(
      projectCodexAppServerMessage({
        method: "account/login/completed",
        params: { loginId: "l1", success: true, error: null },
      }),
    ).toEqual({
      ok: true,
      value: { kind: "auth-lifecycle", event: "account/login/completed", authenticated: true },
    });
    expect(
      projectCodexAppServerMessage({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "team" },
      }),
    ).toEqual({
      ok: true,
      value: { kind: "auth-lifecycle", event: "account/updated", authenticated: true },
    });
  });

  it("accepts only the reviewed remote-control status notification and discards identity", () => {
    for (const status of ["disabled", "connecting", "connected", "errored"] as const)
      expect(
        projectCodexAppServerMessage({
          method: "remoteControl/status/changed",
          params: {
            installationId: "installation-private",
            serverName: "server-private",
            environmentId: "environment-private",
            status,
          },
        }),
      ).toEqual({ ok: true, value: undefined });
    for (const params of [
      { installationId: "i1", serverName: "s1", status: "connected" },
      { installationId: "i1", serverName: "s1", status: "connected", environmentId: null },
    ])
      expect(
        projectCodexAppServerMessage({ method: "remoteControl/status/changed", params }),
      ).toEqual({ ok: true, value: undefined });
    for (const params of [
      { installationId: "i1", serverName: "s1" },
      { installationId: "i1", serverName: "s1", status: "unknown" },
      { installationId: "i1", serverName: "s1", status: "connected", extra: true },
      { installationId: "", serverName: "s1", status: "connected" },
      { installationId: "i1", serverName: "s1", status: "connected", environmentId: "" },
      { installationId: "i1", serverName: "s1", status: "connected", environmentId: false },
    ])
      expect(
        projectCodexAppServerMessage({ method: "remoteControl/status/changed", params }),
      ).toEqual({ ok: false, reason: "message-denied" });
  });

  it("projects generated thread, turn, and agent-delta notification structures", () => {
    const started = threadStartResponse();
    expect(
      projectCodexAppServerMessage({
        method: "thread/started",
        params: { thread: started.thread },
      }),
    ).toMatchObject({ ok: true, value: { kind: "lifecycle", threadId: "t1" } });
    expect(
      projectCodexAppServerMessage({
        method: "turn/started",
        params: { threadId: "t1", turn: turn("u1") },
      }),
    ).toMatchObject({ ok: true, value: { turnId: "u1" } });
    expect(
      projectCodexAppServerMessage({
        method: "turn/completed",
        params: { threadId: "t1", turn: { ...turn("u1"), status: "failed" } },
      }),
    ).toMatchObject({
      ok: true,
      value: { turnId: "u1", terminalStatus: "failed" },
    });
    expect(
      projectCodexAppServerMessage({
        method: "turn/completed",
        params: { threadId: "t1", turn: turn("u1") },
      }),
    ).toEqual({ ok: false, reason: "message-denied" });
    expect(
      projectCodexAppServerMessage({
        method: "item/agentMessage/delta",
        params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "transient" },
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        delta: "transient",
      },
    });
  });
});

function initializeParams(): Record<string, unknown> {
  return {
    clientInfo: { name: "keiko", version: KEIKO_PRODUCT_VERSION },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: false,
      optOutNotificationMethods: [],
    },
  };
}
function turn(id: string): Record<string, unknown> {
  return { id, items: [], status: "inProgress" };
}
function threadStartResponse(): Record<string, unknown> {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: "/workspace",
    model: "gpt-5",
    modelProvider: "openai",
    sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
    thread: {
      cliVersion: "0.144.1",
      createdAt: 1,
      cwd: "/workspace",
      ephemeral: false,
      id: "t1",
      modelProvider: "openai",
      preview: "",
      sessionId: "s1",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 1,
    },
  };
}
