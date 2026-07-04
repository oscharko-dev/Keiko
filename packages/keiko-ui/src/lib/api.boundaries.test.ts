import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  StreamingUnavailableError,
  applyRun,
  cancelRun,
  createChat,
  createChatMessage,
  createDesktopChat,
  createProject,
  createRunSummaryPair,
  fetchChatMessages,
  fetchConfig,
  fetchEvidenceList,
  fetchEvidenceManifest,
  fetchHealth,
  fetchRunReport,
  fetchWorkflows,
  patchChatMessage,
  runGatewayReadiness,
  sendDesktopChat,
  sendDesktopChatStream,
  setupGateway,
  startRun,
  updateChat,
  updateChatConnectedScopes,
  updateChatLocalKnowledgeScope,
  updateChatLocalKnowledgeScopes,
  updateProject,
} from "./api";
import { DEFAULT_GROUNDING_LIMITS } from "./types";
import type { ChatConnectedScope, ChatLocalKnowledgeScope } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okBody(): unknown {
  return {
    ok: true,
    status: "ok",
    version: "0.2.0",
    workflows: [],
    models: [],
    config: null,
    configPresent: false,
    providerCount: 1,
    testedModelId: "model-a",
    testedModelIds: ["model-a"],
    runId: "run-1",
    fingerprint: "fp-1",
    run: { runId: "run-1", fingerprint: "fp-1" },
    report: { runId: "run-1", status: "completed" },
    entries: [],
    manifest: { runId: "run-1" },
    project: { path: "/repo", name: "Repo", favorite: false, available: true },
    chat: { id: "chat-1", projectPath: "/repo", title: "Release", selectedModel: "model-a" },
    messages: [],
  };
}

function streamResponse(text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

describe("API BFF boundary helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes high-risk chat, project, run, and evidence routes with CSRF on mutations", async () => {
    const responses = Array.from({ length: 24 }, () => jsonResponse(okBody()));
    const fetchMock = vi.fn(() => Promise.resolve(responses.shift() ?? jsonResponse(okBody())));
    vi.stubGlobal("fetch", fetchMock);

    const fileScope: ChatConnectedScope = {
      kind: "files",
      root: "/repo",
      relativePaths: ["src/app.ts"],
      connectedAtMs: 1,
    };
    const capsuleScope: ChatLocalKnowledgeScope = {
      kind: "capsule",
      capsuleId: "cap-1" as never,
      connectedAtMs: 2,
    };

    await fetchHealth();
    await fetchConfig();
    await fetchWorkflows();
    await setupGateway({ baseUrl: "https://llm.example/v1", apiKey: "secret" });
    await runGatewayReadiness("model-a", { includeDeepProbes: true });
    await startRun({ taskType: "verify", input: { target: "src/app.ts" }, modelId: "model-a" });
    await cancelRun("run 1");
    await fetchRunReport("run 1");
    await applyRun("run 1");
    await fetchEvidenceList({ workspace: "/repo", date: "", workflow: "verify", model: "model-a" });
    await fetchEvidenceManifest("run 1");
    await createProject({ path: "/repo", name: "Repo" });
    await updateProject("/repo", { favorite: true });
    await createChat({ projectPath: "/repo", title: "Release", selectedModel: "model-a" });
    await updateChat("chat 1", { title: "Renamed" });
    await updateChatConnectedScopes("chat 1", [fileScope]);
    await updateChatLocalKnowledgeScope("chat 1", capsuleScope);
    await updateChatLocalKnowledgeScopes("chat 1", [capsuleScope]);
    await fetchChatMessages("chat 1", "/repo");
    await createChatMessage({
      chatId: "chat 1",
      projectPath: "/repo",
      role: "user",
      content: "hello",
      timestamp: 3,
    });
    await createRunSummaryPair({
      chatId: "chat 1",
      projectPath: "/repo",
      user: { content: "hello", timestamp: 3 },
      summary: {
        content: "done",
        timestamp: 4,
        runId: "run 1",
        workflowStatus: "completed",
      },
    });
    await patchChatMessage("msg 1", "chat 1", "/repo", { shortResult: "patched" });
    await createDesktopChat({ projectPath: "/repo", title: "Desktop", modelId: "model-a" });
    await sendDesktopChat({
      chatId: "chat 1",
      projectPath: "/repo",
      content: "hello",
      modelId: "model-a",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gateway/setup",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gateway/readiness",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
        body: JSON.stringify({ modelId: "model-a", options: { includeDeepProbes: true } }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats?id=chat%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ connectedScopes: [fileScope] }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats?id=chat%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ localKnowledgeScopes: [capsuleScope] }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages?chatId=chat+1&projectPath=%2Frepo",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages?id=msg+1&chatId=chat+1&projectPath=%2Frepo",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ shortResult: "patched" }),
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
  });

  it("falls back to default grounding limits when older config responses omit them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ config: null, configPresent: false }))),
    );

    await expect(fetchConfig()).resolves.toMatchObject({
      effectiveGroundingLimits: DEFAULT_GROUNDING_LIMITS,
    });
  });

  it("throws typed ApiError instances without exposing unparseable response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: "BAD_REQUEST", message: "Nope" } }, 400),
        )
        .mockResolvedValueOnce(new Response("plain secret body", { status: 500 })),
    );

    await expect(fetchHealth()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Nope",
      status: 400,
    } satisfies Partial<ApiError>);
    await expect(fetchHealth()).rejects.toMatchObject({
      code: "INTERNAL",
      message: "HTTP 500",
      status: 500,
    } satisfies Partial<ApiError>);
  });

  it("dispatches real SSE token, done, error, and cancellation events", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        streamResponse(
          [
            "event: token",
            'data: {"text":"Hel"}',
            "event: token",
            'data: {"text":"lo"}',
            "event: done",
            'data: {"chat":{"id":"chat-1"},"messages":[]}',
            "event: error",
            'data: {"code":"MODEL","message":"model failed"}',
            "event: cancelled",
            "data: {}",
            "",
          ].join("\n"),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onCancelled: vi.fn(),
    };

    await sendDesktopChatStream(
      { chatId: "chat-1", projectPath: "/repo", content: "hi", modelId: "model-a" },
      new AbortController().signal,
      handlers,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop/chat/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
    expect(handlers.onToken).toHaveBeenNthCalledWith(1, "Hel");
    expect(handlers.onToken).toHaveBeenNthCalledWith(2, "lo");
    expect(handlers.onDone).toHaveBeenCalledWith({ chat: { id: "chat-1" }, messages: [] });
    expect(handlers.onError).toHaveBeenCalledWith({ code: "MODEL", message: "model failed" });
    expect(handlers.onCancelled).toHaveBeenCalledTimes(1);
  });

  it("throws StreamingUnavailableError for pre-stream JSON failures and null bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: { code: "STREAMING_UNSUPPORTED", message: "buffered only" } }, 409),
        )
        .mockResolvedValueOnce(
          new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
        ),
    );
    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onCancelled: vi.fn(),
    };
    const input = { chatId: "chat-1", projectPath: "/repo", content: "hi", modelId: "model-a" };

    await expect(
      sendDesktopChatStream(input, new AbortController().signal, handlers),
    ).rejects.toBeInstanceOf(StreamingUnavailableError);
    await expect(
      sendDesktopChatStream(input, new AbortController().signal, handlers),
    ).rejects.toMatchObject({ code: "STREAMING_UNSUPPORTED", message: "Response body was null." });
  });
});
