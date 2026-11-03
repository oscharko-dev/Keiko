import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchMcpServer } from "@oscharko-dev/keiko-contracts";

import { MCP_AUTHORIZATION_POLL_MS, useCodingWorkbenchMcp } from "./useCodingWorkbenchMcp";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const fetchMcpMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
const readMock = vi.hoisted(() => vi.fn());
const pairingSettledMock = vi.hoisted(() => vi.fn());

vi.mock("./coding-app-session-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-app-session-client")>()),
  codingAppSessionPairingSettled: pairingSettledMock,
}));

vi.mock("./coding-workbench-runtime-api", () => ({
  fetchCodingWorkbenchRuntimeMcp: fetchMcpMock,
  startCodingWorkbenchMcpAuthorization: startMock,
  readCodingWorkbenchMcpAuthorization: readMock,
}));

const NEEDS: CodingWorkbenchMcpServer = {
  name: "issues",
  status: "needs-authorization",
  authorization: "oauth",
};
const URL_ = "https://login.example.test/tenant/authorize?response_type=code";
const RUN = { runId: "run-1", revision: 3 } as const;

beforeEach(() => {
  for (const mock of [fetchMcpMock, startMock, readMock, pairingSettledMock]) mock.mockReset();
  pairingSettledMock.mockResolvedValue(true);
  fetchMcpMock.mockResolvedValue({ session: "active", servers: [NEEDS] });
});

afterEach(() => {
  vi.useRealTimers();
  resetClientDiagnosticWriter();
});

async function waiting(expiresAtMs = Date.now() + 600_000): Promise<{
  readonly result: { readonly current: ReturnType<typeof useCodingWorkbenchMcp> };
}> {
  startMock.mockResolvedValue({
    outcome: "started",
    attemptId: "con_abc",
    authorizationUrl: URL_,
    expiresAtMs,
  });
  const hook = renderHook(() => useCodingWorkbenchMcp(RUN));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  act(() => {
    hook.result.current.authorize("issues");
  });
  await waitFor(() => expect(hook.result.current.authorization?.phase).toBe("waiting"));
  return hook;
}

describe("useCodingWorkbenchMcp (#3903 AC3)", () => {
  it("reads the run's MCP servers from the authenticated channel", async () => {
    const { result } = renderHook(() => useCodingWorkbenchMcp(RUN));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.servers).toEqual([NEEDS]);
    expect(fetchMcpMock).toHaveBeenCalledWith("run-1", { signal: expect.any(AbortSignal) });
  });

  it("stays idle with no run and is unavailable when unpaired or unreadable", async () => {
    const idle = renderHook(() => useCodingWorkbenchMcp({ runId: undefined, revision: undefined }));
    expect(idle.result.current.status).toBe("idle");
    fetchMcpMock.mockResolvedValueOnce({ session: "unpaired" });
    const unpaired = renderHook(() => useCodingWorkbenchMcp(RUN));
    await waitFor(() => expect(unpaired.result.current.status).toBe("unavailable"));
    const reports: string[] = [];
    setClientDiagnosticWriter((message) => reports.push(message));
    fetchMcpMock.mockRejectedValueOnce(new Error("offline"));
    const failed = renderHook(() => useCodingWorkbenchMcp(RUN));
    await waitFor(() => expect(failed.result.current.status).toBe("unavailable"));
    expect(reports.join("\n")).toContain("mcp list failed");
  });

  it("hands the human the validated authorization page and settles a completed attempt", async () => {
    const { result } = await waiting();
    expect(result.current.authorization).toEqual({
      phase: "waiting",
      server: "issues",
      attemptId: "con_abc",
      authorizationUrl: URL_,
      expiresAtMs: expect.any(Number) as unknown,
    });
    readMock.mockResolvedValueOnce({ state: "pending" }).mockResolvedValue({ state: "complete" });
    fetchMcpMock.mockResolvedValue({
      session: "active",
      servers: [{ ...NEEDS, status: "connected" }],
    });
    await waitFor(
      () => expect(result.current.authorization).toMatchObject({ outcome: "complete" }),
      { timeout: MCP_AUTHORIZATION_POLL_MS * 3 },
    );
    expect(readMock).toHaveBeenCalledWith("run-1", { server: "issues", attemptId: "con_abc" });
    await waitFor(() => expect(result.current.servers[0]?.status).toBe("connected"));
  });

  it("shows a refused start with its closed reason", async () => {
    startMock.mockResolvedValue({ outcome: "refused", reason: "url-refused" });
    const { result } = renderHook(() => useCodingWorkbenchMcp(RUN));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      result.current.authorize("issues");
    });
    await waitFor(() =>
      expect(result.current.authorization).toEqual({
        phase: "settled",
        server: "issues",
        outcome: "url-refused",
      }),
    );
  });

  it("treats an attempt past its expiry as expired without asking the server again", async () => {
    const { result } = await waiting(Date.now() - 1);
    await waitFor(
      () => expect(result.current.authorization).toMatchObject({ outcome: "expired" }),
      { timeout: MCP_AUTHORIZATION_POLL_MS * 2 },
    );
    expect(readMock).not.toHaveBeenCalled();
  });

  it("cancels a waiting attempt on the server", async () => {
    readMock.mockResolvedValue({ state: "cancelled" });
    const { result } = await waiting();
    act(() => {
      result.current.cancel();
    });
    expect(result.current.authorization).toBeUndefined();
    expect(readMock).toHaveBeenCalledWith(
      "run-1",
      { server: "issues", attemptId: "con_abc" },
      true,
    );
  });
});
