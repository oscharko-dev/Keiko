import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteChat, deleteProject, fetchWorkspaceSummary } from "./api";

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

  it("requests the workspace summary route with default and optional filters", async () => {
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

    await fetchWorkspaceSummary();
    await fetchWorkspaceSummary({ dir: "/repo space", task: "src/index.ts", budget: 128 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspace?dir=.",
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
