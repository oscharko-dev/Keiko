import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askGrounded,
  clearModelCacheForTests,
  clearProjectRequestForTests,
  deleteChat,
  deleteProject,
  fetchFilesDirectories,
  fetchFilesPreview,
  fetchFilesTree,
  fetchModels,
  fetchProjects,
  fetchWorkspaceSummary,
  updateChatConnectedScope,
} from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("encodes directory picker, tree, and preview query parameters", async () => {
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
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchFilesDirectories("/repo space");
    await fetchFilesTree("/repo space", "src/app.ts");
    await fetchFilesPreview("/repo space", "src/app.ts");

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
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chats?id=chat-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Accept: "application/json",
          "X-Keiko-CSRF": "1",
        }),
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

// Issue #184 — connector binds a Files-window selection to a chat via PATCH /api/chats.
describe("updateChatConnectedScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /api/chats with a connectedScope body when a scope is supplied", async () => {
    const updated = {
      chat: {
        id: "chat-1",
        projectPath: "/p",
        title: "t",
        selectedModel: "example-chat-model",
        branchLabel: undefined,
        status: undefined,
        connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 100 },
        createdAt: 1,
        updatedAt: 2,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(updated));
    vi.stubGlobal("fetch", fetchMock);

    await updateChatConnectedScope("chat-1", {
      kind: "files",
      relativePaths: ["src/a.ts"],
      connectedAtMs: 100,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats?id=chat-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 100 },
        }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Keiko-CSRF": "1",
        }),
      }),
    );
  });

  it("PATCHes /api/chats with a null connectedScope to clear the binding", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        chat: {
          id: "chat-1",
          projectPath: "/p",
          title: "t",
          selectedModel: "example-chat-model",
          branchLabel: undefined,
          status: undefined,
          connectedScope: undefined,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateChatConnectedScope("chat-1", null);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats?id=chat-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ connectedScope: null }),
      }),
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

    const result = await askGrounded({ chatId: "chat-1", content: "how does foo work?" });
    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/messages/grounded",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ chatId: "chat-1", content: "how does foo work?" }),
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

    const pending = askGrounded({ chatId: "chat-1", content: "q" }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
