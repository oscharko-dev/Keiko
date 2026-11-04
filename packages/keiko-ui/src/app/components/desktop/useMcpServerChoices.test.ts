import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpServerConnectionView,
  McpServerDefinition,
  McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  codingAppSessionPairingSettled,
  notifyCodingAppSessionChanged,
} from "@/lib/coding-app-session-client";
import { useMcpServerChoices } from "./useMcpServerChoices";

vi.mock("@/lib/coding-app-session-client", async (original) => ({
  ...(await original<typeof import("@/lib/coding-app-session-client")>()),
  codingAppSessionPairingSettled: vi.fn(),
}));
const http = vi.hoisted(() => ({ bffFetchJson: vi.fn() }));
vi.mock("@/lib/http", async (original) => ({
  ...(await original<typeof import("@/lib/http")>()),
  bffFetchJson: http.bffFetchJson,
}));

function server(name: string, enabled = true): McpServerDefinition {
  return {
    name,
    description: undefined,
    enabled,
    transport: { kind: "remote", url: "https://mcp.example.invalid/" },
    tools: {},
  };
}
function connection(
  name: string,
  state: McpServerConnectionView["state"],
  authentication?: McpServerConnectionView["authentication"],
): McpServerConnectionView {
  return {
    name,
    state,
    toolCount: null,
    ...(authentication === undefined ? {} : { authentication }),
  };
}
function snapshot(
  servers: readonly McpServerDefinition[],
  connections?: readonly McpServerConnectionView[],
): McpSettingsSnapshot {
  return {
    revision: "rev-1",
    servers,
    ...(connections === undefined ? {} : { connections }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(codingAppSessionPairingSettled).mockResolvedValue(true);
});

describe("useMcpServerChoices", () => {
  it("starts loading and maps only enabled servers to their connection state", async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValue(
        snapshot(
          [
            server("wiki"),
            server("disabled", false),
            server("auth"),
            server("broken"),
            server("quiet"),
            server("starting"),
            server("unreported"),
          ],
          [
            connection("wiki", "connected"),
            connection("disabled", "connected"),
            connection("auth", "connected", "required"),
            connection("broken", "failed"),
            connection("quiet", "idle", "none"),
            connection("starting", "connecting", "authorized"),
          ],
        ),
      );
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    expect(result.current).toMatchObject({ servers: [], loading: true, failed: false });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(false);
    expect(result.current.servers).toEqual([
      { name: "wiki", state: "connected" },
      { name: "auth", state: "attention" },
      { name: "broken", state: "attention" },
      { name: "quiet", state: "idle" },
      { name: "starting", state: "idle" },
      { name: "unreported", state: "idle" },
    ]);
    expect(fetchSnapshot).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  });

  it("treats a snapshot without runtime connections as all idle", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot([server("wiki")]));
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.servers).toEqual([{ name: "wiki", state: "idle" }]);
  });

  it("waits for the app-session pairing before the first read", async () => {
    let settle: ((paired: boolean) => void) | undefined;
    vi.mocked(codingAppSessionPairingSettled).mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot([server("wiki")]));
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await Promise.resolve();
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      settle?.(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it("reports a failed read as failed, not loading, with no servers", async () => {
    const fetchSnapshot = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current).toMatchObject({ servers: [], loading: false, failed: true });
  });

  it("reports a failed pairing wait as failed without reading", async () => {
    vi.mocked(codingAppSessionPairingSettled).mockRejectedValue(new Error("aborted"));
    const fetchSnapshot = vi.fn();
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("reload reads again and replaces the servers", async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot([server("wiki")]))
      .mockResolvedValueOnce(snapshot([server("wiki"), server("build")]));
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.servers).toHaveLength(2));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.failed).toBe(false);
  });

  it("keeps the last servers when a reload fails and then recovers on the next reload", async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot([server("wiki")]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot([server("build")]));
    const { result } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.servers).toEqual([{ name: "wiki", state: "idle" }]);
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.servers).toEqual([{ name: "build", state: "idle" }]));
    expect(result.current.failed).toBe(false);
  });

  it("aborts the read of an unmounted hook and publishes nothing from it", async () => {
    let signal: AbortSignal | undefined;
    let finish: ((value: McpSettingsSnapshot) => void) | undefined;
    const fetchSnapshot = vi.fn(
      (abort: AbortSignal) =>
        new Promise<McpSettingsSnapshot>((resolve) => {
          signal = abort;
          finish = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledOnce());
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.(snapshot([server("wiki")]));
      await Promise.resolve();
    });
    expect(result.current.servers).toEqual([]);
  });

  it("reads again after a navigation redemption restored the session", async () => {
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot([server("wiki")]));
    renderHook(() => useMcpServerChoices(fetchSnapshot));
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledOnce());
    act(() => notifyCodingAppSessionChanged());
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2));
  });

  it("reads the central MCP settings route once by default and not on every render", async () => {
    // A fresh default fetcher on every render re-ran the effect and looped; the bound makes that
    // regression fail fast instead of spinning the runner.
    http.bffFetchJson.mockImplementation(() =>
      http.bffFetchJson.mock.calls.length > 5
        ? new Promise<never>(() => undefined)
        : Promise.resolve(snapshot([server("wiki")])),
    );
    const { result, rerender } = renderHook(() => useMcpServerChoices());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    rerender();
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(http.bffFetchJson).toHaveBeenCalledExactlyOnceWith("/api/mcp/servers", {
      signal: expect.any(AbortSignal),
    });
  });
});
