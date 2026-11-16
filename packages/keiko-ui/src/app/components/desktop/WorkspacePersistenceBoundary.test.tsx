import { StrictMode, useRef, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePersistenceBoundary } from "./WorkspacePersistenceBoundary";
import { useWorkspace } from "./hooks/useWorkspace";
import { APP_BOOT_RECOVERY_HANDOFF_EVENT } from "./AppBootPlaceholder";
import * as clientDiagnostics from "@/lib/client-diagnostics";

const STORAGE_ID = "a".repeat(64);

function Workspace(): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(ref);
  return (
    <main ref={ref} data-testid="workspace">
      {workspace.wins?.map((item) => item.id).join(",")}
    </main>
  );
}

function renderWorkspace(): ReturnType<typeof render> {
  return render(
    <WorkspacePersistenceBoundary>
      <Workspace />
    </WorkspacePersistenceBoundary>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(navigator, "webdriver", { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("workspace restoration boot boundary", () => {
  it("keeps ownership attempts bounded and observable across StrictMode remount and retry", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const handoffs = vi.fn();
    const reports = vi
      .spyOn(clientDiagnostics, "reportClientDiagnostic")
      .mockImplementation(() => {});
    const read = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal === undefined || init.signal === null) throw new Error("Missing signal");
          signals.push(init.signal);
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", read);
    window.addEventListener(APP_BOOT_RECOVERY_HANDOFF_EVENT, handoffs);
    try {
      render(
        <StrictMode>
          <WorkspacePersistenceBoundary>
            <main>Owned workspace</main>
          </WorkspacePersistenceBoundary>
        </StrictMode>,
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(handoffs).toHaveBeenCalledTimes(2);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
      expect(screen.queryByRole("main")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(screen.getByRole("alert")).toHaveTextContent("Your workspace could not be opened");

      read.mockResolvedValueOnce(
        new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })),
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("main")).toHaveTextContent("Owned workspace");
      expect(handoffs).toHaveBeenCalledTimes(3);
      const starts = reports.mock.calls.filter(
        ([, meta]) => meta?.composerActivity === "workspace-ownership-started",
      );
      expect(starts).toHaveLength(3);
      expect(new Set(starts.map(([, meta]) => meta?.correlationId)).size).toBe(3);
      const failures = reports.mock.calls.filter(([, meta]) => meta?.errorKind === "unavailable");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.[1]?.correlationId).toBe(starts[1]?.[1]?.correlationId);
      expect(JSON.stringify(reports.mock.calls)).not.toContain(STORAGE_ID);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      window.removeEventListener(APP_BOOT_RECOVERY_HANDOFF_EVENT, handoffs);
    }
  });

  it.each([null, [], {}, { workspace: null }, { workspace: [] }])(
    "refuses a malformed ownership response: %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      renderWorkspace();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    },
  );

  it("bounds a stalled startup and keeps the saved layout untouched", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    window.localStorage.setItem("keiko.workspace.v4", "[]");
    renderWorkspace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe("[]");
  });
  it("waits for the current data store before mounting or overwriting a saved layout", async () => {
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const legacy = '[{"id":"former-chat","type":"chat","cfg":{"chatId":"former"}}]';
    window.localStorage.setItem("keiko.workspace.v4", legacy);
    renderWorkspace();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe(legacy);
    await act(async () => {
      complete?.(new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })));
    });
    expect(await screen.findByTestId("workspace")).toBeEmptyDOMElement();
    expect(window.localStorage.getItem("keiko.workspace.v4")).toBe(legacy);
  });

  it.each([undefined, "", "../other-store", "a".repeat(65)])(
    "refuses an invalid storage identity: %s",
    async (storageId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspace: { storageId } }))),
      );
      renderWorkspace();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your workspace could not be opened",
      );
      expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    },
  );

  it("offers a retry after the local server becomes available", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })),
        ),
    );
    renderWorkspace();
    await screen.findByRole("alert");
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    expect(await screen.findByTestId("workspace")).toBeInTheDocument();
  });
});
