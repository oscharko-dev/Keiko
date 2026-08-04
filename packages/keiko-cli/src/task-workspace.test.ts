import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "./runner.js";
import { runTaskWorkspaceCli } from "./task-workspace.js";

interface CapturedIo {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function capturedIo(): CapturedIo {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text): void => {
        output.push(text);
      },
      err: (text): void => {
        errors.push(text);
      },
    },
    out: (): string => output.join(""),
    err: (): string => errors.join(""),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("task-workspace CLI", () => {
  it.each([
    {
      command: ["reconciliation", "--root", "/repo root"],
      route: "/api/task-workspaces/reconciliation?root=%2Frepo+root",
    },
    {
      command: ["health", "--root", "/repo root"],
      route: "/api/task-workspaces/health?root=%2Frepo+root",
    },
  ])("reads the $command.0 report from the running loopback server", async ({ command, route }) => {
    const fetchImpl = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ kind: "redacted-report", count: 2 })),
    );
    const capture = capturedIo();

    const code = await runTaskWorkspaceCli(
      command,
      capture.io,
      { KEIKO_UI_HOST: "localhost", KEIKO_UI_PORT: "21983" },
      { fetchImpl },
    );

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://localhost:21983${route}`,
      expect.objectContaining({
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
      }),
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(capture.out()).toContain('"kind": "redacted-report"');
    expect(capture.err()).toBe("");
  });

  it.each([
    ["repair", ["repair", "workspace-1", "--strategy", "recreate-worktree", "--approve"]],
    ["cleanup", ["cleanup", "workspace-1", "--mode", "request", "--approve"]],
    ["cleanup-orphans", ["cleanup-orphans", "--root", "/repo", "--approve"]],
  ] as const)("requires explicit approval before %s", async (_title, approvedArgs) => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const capture = capturedIo();
    const args = approvedArgs.filter((arg) => arg !== "--approve");

    const code = await runTaskWorkspaceCli(args, capture.io, {}, { fetchImpl });

    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(capture.err()).toContain("--approve");
  });

  it.each([
    {
      args: ["repair", "workspace/1", "--strategy", "recreate-worktree", "--approve"],
      route: "/api/task-workspaces/workspace%2F1/repair",
      body: {
        requestedBy: "keiko-cli",
        strategy: "recreate-worktree",
        operatorApproved: true,
      },
    },
    {
      args: ["cleanup", "workspace/1", "--mode", "complete", "--approve"],
      route: "/api/task-workspaces/workspace%2F1/cleanup",
      body: { requestedBy: "keiko-cli", mode: "complete", operatorApproved: true },
    },
    {
      args: ["cleanup-orphans", "--root", "/repo", "--approve"],
      route: "/api/task-workspaces/cleanup/orphans",
      body: { requestedBy: "keiko-cli", root: "/repo", operatorApproved: true },
    },
  ])("sends an approved governed mutation to $route", async ({ args, route, body }) => {
    const fetchImpl = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ kind: "redacted-result" })),
    );
    const capture = capturedIo();

    const code = await runTaskWorkspaceCli(args, capture.io, {}, { fetchImpl });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:1983${route}`,
      expect.objectContaining({
        body: JSON.stringify(body),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-keiko-csrf": "1",
        },
        method: "POST",
        redirect: "error",
      }),
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("cancels a streamed response as soon as the response cap is crossed", async () => {
    let cancelled = false;
    let emittedChunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        emittedChunks += 1;
        controller.enqueue(new Uint8Array(emittedChunks === 1 ? 700_000 : 400_000));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(body)));
    const capture = capturedIo();

    const code = await runTaskWorkspaceCli(["health"], capture.io, {}, { fetchImpl });

    expect(code).toBe(1);
    expect(cancelled).toBe(true);
    expect(emittedChunks).toBeGreaterThanOrEqual(2);
    expect(capture.err()).toContain("RangeError");
    expect(capture.out()).toBe("");
  });

  it("cancels a response rejected by its declared content length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel(): void {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(body, { headers: { "content-length": String(1_048_577) } })),
    );
    const capture = capturedIo();

    const code = await runTaskWorkspaceCli(["health"], capture.io, {}, { fetchImpl });

    expect(code).toBe(1);
    expect(cancelled).toBe(true);
    expect(capture.err()).toContain("RangeError");
    expect(capture.out()).toBe("");
  });

  it("applies a bounded deadline to a stalled loopback request", async () => {
    const controller = new AbortController();
    const createTimeoutSignal = vi.fn(() => controller.signal);
    const fetchImpl = vi.fn((_input: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            const reason: unknown = signal.reason;
            reject(reason instanceof Error ? reason : new Error("request aborted"));
          },
          {
            once: true,
          },
        );
      });
    });
    const capture = capturedIo();

    const pending = runTaskWorkspaceCli(
      ["health"],
      capture.io,
      {},
      {
        fetchImpl,
        createTimeoutSignal,
      },
    );
    controller.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(pending).resolves.toBe(1);
    expect(createTimeoutSignal).toHaveBeenCalledWith(10_000);
    expect(capture.err()).toContain("TimeoutError");
  });

  it("reports a redacted HTTP failure without echoing the response body", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "OPERATOR_APPROVAL_REQUIRED", message: "sensitive body" } },
          403,
        ),
      ),
    );
    const capture = capturedIo();

    const code = await runTaskWorkspaceCli(["health"], capture.io, {}, { fetchImpl });

    expect(code).toBe(1);
    expect(capture.err()).toContain("HTTP 403");
    expect(capture.err()).toContain("OPERATOR_APPROVAL_REQUIRED");
    expect(capture.err()).not.toContain("sensitive body");
  });
});
