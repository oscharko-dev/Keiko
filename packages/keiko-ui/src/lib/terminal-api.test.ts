// Unit tests for the terminalFetch wrapper in terminal-api.ts. Same shape as browser-api.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortTerminalExecution,
  createTerminalExecution,
  fetchTerminalDirectories,
  fetchTerminalPolicy,
} from "./terminal-api";

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("terminalFetch header injection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /api/terminal/policy sends no CSRF or Content-Type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({ commands: ["ls"], limits: { maxOutputBytes: 1, defaultTimeoutMs: 1 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchTerminalPolicy();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Keiko-CSRF"]).toBeUndefined();
    expect(headers["Accept"]).toBe("application/json");
  });

  it("POST /api/terminal/executions includes CSRF + JSON Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonOk({
        executionId: "e1",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 1,
        truncated: false,
        timedOut: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createTerminalExecution({ projectId: "/p", command: "ls", args: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/terminal/executions");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.method).toBe("POST");
  });

  it("DELETE /api/terminal/executions/:id includes CSRF + URL-encoded id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await abortTerminalExecution("exec/with slash");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/terminal/executions/${encodeURIComponent("exec/with slash")}`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Keiko-CSRF"]).toBe("1");
    expect(init.method).toBe("DELETE");
  });

  it("GET /api/terminal/directories?projectId=... encodes the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({
      path: "/p", parent: null, entries: [], roots: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTerminalDirectories("/proj", "/proj/sub");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toContain("projectId=%2Fproj");
    expect(path).toContain("path=%2Fproj%2Fsub");
  });

  it("non-OK responses throw ApiError with code + status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "COMMAND_DENIED", message: "no" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createTerminalExecution({ projectId: "/p", command: "rm", args: [] }),
    ).rejects.toMatchObject({ code: "COMMAND_DENIED", status: 403 });
  });
});
