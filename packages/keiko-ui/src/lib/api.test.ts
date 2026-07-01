import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askGrounded,
  clearModelCacheForTests,
  clearProjectRequestForTests,
  deleteChat,
  deleteProject,
  fetchFilesContent,
  fetchFilesDirectories,
  fetchFilesPreview,
  fetchFilesTree,
  fetchModels,
  fetchProjects,
  regenerateDesktopChat,
  requestEditorCompletion,
  requestEditorDiagnostics,
  requestEditorFormatting,
  requestEditorHover,
  requestEditorSymbols,
  saveFilesContent,
  sendDesktopChatStream,
  startGroundedWorkflowHandoff,
  fetchWorkspaceSummary,
  type StreamHandlers,
} from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestEditorCompletion (Issue #1199)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the overlay + cursor to the completion route with the CSRF header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [{ label: "alpha", kind: "field", insertText: "alpha", origin: "deterministic" }],
        isIncomplete: false,
        truncated: false,
        provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestEditorCompletion({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const value = {};\nvalue.\n",
      position: { line: 1, character: 6 },
      triggerKind: "trigger-character",
      triggerCharacter: ".",
      contextBudgetBytes: 4_096,
    });

    expect(response.items[0]?.label).toBe("alpha");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/completion",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          schemaVersion: "1",
          root: "/repo",
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "const value = {};\nvalue.\n",
          },
          position: { line: 1, character: 6 },
          triggerKind: "trigger-character",
          triggerCharacter: ".",
          contextBudgetBytes: 4_096,
        }),
      }),
    );
  });

  it("forwards an abort signal for superseded-request cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaVersion: "1",
        items: [],
        isIncomplete: false,
        truncated: false,
        provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestEditorCompletion(
      {
        root: "/repo",
        path: "src/a.ts",
        languageId: "typescript",
        text: "x",
        position: { line: 0, character: 1 },
        triggerKind: "invoked",
        contextBudgetBytes: 1_024,
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/completion",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("language-intelligence helpers (Issue #1201)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requestEditorDiagnostics posts a diagnostics operation and unwraps the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        operation: "diagnostics",
        result: {
          diagnostics: [{ range: {}, severity: "error", message: "x", source: "typescript" }],
          truncated: false,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestEditorDiagnostics({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x: number = 'no';\n",
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          operation: "diagnostics",
          root: "/repo",
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: "const x: number = 'no';\n",
          },
        }),
      }),
    );
  });

  it("requestEditorHover posts a hover operation with the cursor position", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ operation: "hover", result: { contents: "x: number" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestEditorHover({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x = 1;\n",
      position: { line: 0, character: 6 },
    });

    expect(result.contents).toBe("x: number");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "hover",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "const x = 1;\n" },
          position: { line: 0, character: 6 },
        }),
      }),
    );
  });

  it("requestEditorSymbols posts a symbols operation and forwards the abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "symbols", result: { symbols: [], truncated: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestEditorSymbols(
      { root: "/repo", path: "src/a.ts", languageId: "typescript", text: "export const a = 1;\n" },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("requestEditorFormatting posts a formatting operation with indentation options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ operation: "formatting", result: { edits: [], truncated: false } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await requestEditorFormatting({
      root: "/repo",
      path: "src/a.ts",
      languageId: "typescript",
      text: "const x   =   1;\n",
      options: { tabSize: 2, insertSpaces: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/editor/language",
      expect.objectContaining({
        body: JSON.stringify({
          operation: "formatting",
          root: "/repo",
          document: { path: "src/a.ts", languageId: "typescript", text: "const x   =   1;\n" },
          options: { tabSize: 2, insertSpaces: true },
        }),
      }),
    );
  });
});

describe("fetchWorkspaceSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the workspace summary route with required dir and optional filters", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          summary: {
            root: "/repo",
            sourceDirs: [],
            testDirs: [],
            languages: [],
            counts: { discovered: 0, denied: 0, ignored: 0 },
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceSummary({ dir: "/repo" });
    await fetchWorkspaceSummary({ dir: "/repo space", task: "src/index.ts", budget: 128 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspace?dir=%2Frepo",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspace?dir=%2Frepo+space&task=src%2Findex.ts&budget=128",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });
});

describe("files API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes directory picker, tree, preview, and editor requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ path: "/repo space", parent: null, entries: [], roots: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ root: "/repo space", path: "src/app.ts", entries: [], truncated: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 1,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          kind: "text",
          content: "const x = 1;\n",
          truncated: false,
          maxBytes: 1_000_000,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 1,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          content: "const x = 1;\n",
          maxBytes: 1_000_000,
          session: {
            schemaVersion: "1",
            version: { sizeBytes: 10, modifiedAt: 1, contentHash: "a".repeat(64) },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          root: "/repo space",
          path: "src/app.ts",
          name: "app.ts",
          sizeBytes: 10,
          modifiedAt: 2,
          extension: "ts",
          mime: "text/plain",
          symlink: false,
          content: "const x = 2;\n",
          maxBytes: 1_000_000,
          session: {
            schemaVersion: "1",
            version: { sizeBytes: 10, modifiedAt: 2, contentHash: "b".repeat(64) },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchFilesDirectories("/repo space");
    await fetchFilesTree("/repo space", "src/app.ts");
    await fetchFilesPreview("/repo space", "src/app.ts");
    await fetchFilesContent("/repo space", "src/app.ts");
    await saveFilesContent({
      root: "/repo space",
      path: "src/app.ts",
      content: "const x = 2;\n",
      expectedModifiedAt: 1,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/files/directories?root=%2Frepo+space",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/files/tree?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/files/preview?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/api/files/content?root=%2Frepo+space&path=src%2Fapp.ts",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/files/content",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: JSON.stringify({
          root: "/repo space",
          path: "src/app.ts",
          content: "const x = 2;\n",
          expectedModifiedAt: 1,
        }),
      }),
    );
  });

  it("serializes the version-aware baseVersion token on save (Issue #1197)", async () => {
    const baseVersion = { sizeBytes: 12, modifiedAt: 7, contentHash: "a".repeat(64) };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        root: "/repo",
        path: "src/app.ts",
        name: "app.ts",
        sizeBytes: 13,
        modifiedAt: 9,
        extension: "ts",
        mime: "text/plain",
        symlink: false,
        content: "const x = 3;\n",
        maxBytes: 1_000_000,
        session: {
          schemaVersion: "1",
          version: { sizeBytes: 13, modifiedAt: 9, contentHash: "b".repeat(64) },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const saved = await saveFilesContent({
      root: "/repo",
      path: "src/app.ts",
      content: "const x = 3;\n",
      baseVersion,
    });

    expect(saved.session.version.contentHash).toBe("b".repeat(64));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/content",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          root: "/repo",
          path: "src/app.ts",
          content: "const x = 3;\n",
          baseVersion,
        }),
      }),
    );
  });
});

describe("fetchModels", () => {
  afterEach(() => {
    clearModelCacheForTests();
    vi.unstubAllGlobals();
  });

  it("reuses the in-flight model registry request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchModels(), fetchModels()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("clears the model registry cache after a failed request", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModels()).rejects.toThrow("offline");
    await expect(fetchModels()).resolves.toEqual({ models: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchProjects", () => {
  afterEach(() => {
    clearProjectRequestForTests();
    vi.unstubAllGlobals();
  });

  it("reuses the in-flight project list request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchProjects(), fetchProjects(), fetchProjects()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("does not cache a resolved project list response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/a" }] }))
      .mockResolvedValueOnce(jsonResponse({ projects: [{ path: "/repo/b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/a" }] });
    await expect(fetchProjects()).resolves.toEqual({ projects: [{ path: "/repo/b" }] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("delete helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats 204 DELETE responses as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteProject("/repo/project");
    await deleteChat("chat-123");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects?path=%2Frepo%2Fproject",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chats?id=chat-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
        body: "{}",
      }),
    );
  });

  it("propagates fetch network errors for deleteProject and deleteChat", async () => {
    const networkError = new TypeError("fetch failed");
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteProject("/repo/project")).rejects.toBe(networkError);
    await expect(deleteChat("chat-123")).rejects.toBe(networkError);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects?path=%2Frepo%2Fproject",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chats?id=chat-123",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// Issue #185 — grounded repository Q&A wire helper.
describe("askGrounded", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the request body and CSRF header to /api/chats/messages/grounded", async () => {
    const response = {
      userMessageId: "msg-u",
      assistantMessageId: "msg-a",
      content: "Inspected 1 file(s) for: how does foo work?",
      citations: [
        {
          scopePath: "src/foo.ts",
          lineRange: { startLine: 1, endLine: 10 },
          score: 0.8,
          stableId: "atom-1",
        },
      ],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 42,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await askGrounded({
      chatId: "chat-1",
      content: "how does foo work?",
      modelId: "example-chat-model",
    });
    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages/grounded",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chatId: "chat-1",
          content: "how does foo work?",
          modelId: "example-chat-model",
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("rejects with an AbortError when the signal is aborted before the fetch resolves", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new DOMException("The user aborted a request.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = askGrounded(
      { chatId: "chat-1", content: "q", modelId: "example-chat-model" },
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ---------------------------------------------------------------------------
// consumeSseStream — residual lineBuffer flush (Issue #3 / WP-API)
// ---------------------------------------------------------------------------

function makeSseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

function makeStreamHandlers(overrides: Partial<StreamHandlers> = {}): StreamHandlers {
  return {
    onToken: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onCancelled: vi.fn(),
    ...overrides,
  };
}

function makeSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("sendDesktopChatStream — SSE residual lineBuffer flush", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ITEM #3: a 'done' frame whose final data line arrives WITHOUT a trailing \n
  // must still dispatch onDone. Against the pre-fix code this test is RED
  // because the residual lineBuffer is never flushed when read.done fires.
  it("dispatches onDone when the final done frame has no trailing newline", async () => {
    const donePayload = { chat: { id: "c1" }, messages: [] };
    // Normal SSE: two chunks. First carries the event line + data line.
    // Second chunk is the data payload with NO trailing \n\n — simulating a
    // proxy that drops the terminal blank line.
    const stream = makeSseStream([
      "event: done\n",
      `data: ${JSON.stringify(donePayload)}`, // intentionally no trailing \n
    ]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await sendDesktopChatStream(
      { chatId: "c1", projectPath: "/repo", content: "hello" },
      new AbortController().signal,
      handlers,
    );

    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).toHaveBeenCalledWith(expect.objectContaining({ chat: { id: "c1" } }));
    expect(handlers.onToken).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  // Regression: normal \n\n-terminated streams must still work correctly.
  it("dispatches onDone for a normally newline-terminated done frame", async () => {
    const donePayload = { chat: { id: "c2" }, messages: [] };
    const stream = makeSseStream([`event: done\ndata: ${JSON.stringify(donePayload)}\n\n`]);

    const handlers = makeStreamHandlers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSseResponse(stream)));

    await sendDesktopChatStream(
      { chatId: "c2", projectPath: "/repo", content: "hello" },
      new AbortController().signal,
      handlers,
    );

    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});

describe("regenerateDesktopChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the assistant turn id to the regenerate route with CSRF and an abort signal", async () => {
    const controller = new AbortController();
    const response = { chat: { id: "chat-1" }, messages: [{ id: "a1", role: "assistant" }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await regenerateDesktopChat(
      {
        chatId: "chat-1",
        projectPath: "/repo",
        assistantMessageId: "a1",
        modelId: "example-chat-model",
        memory: { enabled: false },
      },
      controller.signal,
    );

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/desktop/chat/regenerate",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          chatId: "chat-1",
          projectPath: "/repo",
          assistantMessageId: "a1",
          modelId: "example-chat-model",
          memory: { enabled: false },
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});

describe("startGroundedWorkflowHandoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the request body and CSRF header to /api/chats/messages/grounded/handoff", async () => {
    const response = {
      run: { runId: "run-42", fingerprint: "fp-42" },
      messages: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await startGroundedWorkflowHandoff({
      assistantMessageId: "msg-a",
      chatId: "chat-a",
      modelId: "wf-model",
      workflowKind: "unit-test-generation",
      input: { target: { kind: "file", filePath: "src/example.ts" } },
      editablePaths: ["tests/example.test.ts"],
      expectedChecks: ["tests"],
      unknowns: ["Need API confirmation"],
      requestedAtMs: 123,
    });

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages/grounded/handoff",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          assistantMessageId: "msg-a",
          chatId: "chat-a",
          modelId: "wf-model",
          workflowKind: "unit-test-generation",
          input: { target: { kind: "file", filePath: "src/example.ts" } },
          editablePaths: ["tests/example.test.ts"],
          expectedChecks: ["tests"],
          unknowns: ["Need API confirmation"],
          requestedAtMs: 123,
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });
});
