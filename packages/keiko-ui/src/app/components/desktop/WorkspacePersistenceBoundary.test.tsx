import { StrictMode, useRef, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePersistenceBoundary } from "./WorkspacePersistenceBoundary";
import { useWorkspace } from "./hooks/useWorkspace";
import { APP_BOOT_RECOVERY_HANDOFF_EVENT } from "./AppBootPlaceholder";
import {
  WORKSPACE_STORAGE_CHANGED_EVENT,
  announceWorkspaceStorageChanged,
} from "./hooks/workspace-storage";
import * as clientDiagnostics from "@/lib/client-diagnostics";

const STORAGE_ID = "a".repeat(64);

function storageChangedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "WORKSPACE_STORAGE_CHANGED",
        message: "The saved workspace belongs to another data store.",
      },
    }),
    { status: 409 },
  );
}

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

  it("mounts the new data store's workspace when the server restarts with other state", async () => {
    // The page stays open while the Keiko behind it is started again with a different state
    // folder. Before the repair every poll still named the old store, was refused with 409 and was
    // repeated forever, and the page kept showing the old store's windows.
    vi.useFakeTimers();
    Object.defineProperty(navigator, "webdriver", { configurable: true, value: false });
    const OTHER_ID = "b".repeat(64);
    const oldWindow = {
      id: "old-files",
      type: "files",
      x: 40,
      y: 40,
      w: 360,
      h: 320,
      z: 1,
      cfg: { root: "/repo" },
      max: false,
      zoom: 1,
    };
    const windowsByStore: Record<string, unknown[]> = { [STORAGE_ID]: [oldWindow], [OTHER_ID]: [] };
    let current = STORAGE_ID;
    const requests: { method: string; storage: string | undefined; body: string }[] = [];
    const reports = vi
      .spyOn(clientDiagnostics, "reportClientDiagnostic")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const storage = headers["X-Keiko-Workspace-Storage"];
        const method = init?.method ?? "GET";
        requests.push({ method, storage, body: typeof init?.body === "string" ? init.body : "" });
        if (storage !== undefined && storage !== current) {
          return Promise.resolve(storageChangedResponse());
        }
        if (method === "PUT") {
          return Promise.resolve(new Response(JSON.stringify({ workspace: { revision: 1 } })));
        }
        const workspace = {
          revision: 1,
          windows: windowsByStore[current],
          connections: [],
          storageId: current,
        };
        return Promise.resolve(new Response(JSON.stringify({ workspace })));
      }),
    );
    window.localStorage.setItem(`keiko.workspace.v4:${STORAGE_ID}`, JSON.stringify([oldWindow]));
    renderWorkspace();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId("workspace")).toHaveTextContent("old-files");

    current = OTHER_ID;
    const switchedAt = requests.length;
    // One act per second, so React commits between polls as a browser would.
    for (let second = 0; second < 30; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(screen.getByTestId("workspace")).not.toHaveTextContent("old-files");
    const after = requests.slice(switchedAt);
    // At most the poll that discovered the change and one write already under way name the old
    // store; nothing is repeated against it.
    expect(after.filter((request) => request.storage === STORAGE_ID).length).toBeLessThanOrEqual(2);
    expect(
      after.some((request) => request.storage === OTHER_ID && request.body.includes("old-files")),
    ).toBe(false);
    expect(window.localStorage.getItem(`keiko.workspace.v4:${OTHER_ID}`) ?? "").not.toContain(
      "old-files",
    );
    const changes = reports.mock.calls.filter(
      ([, meta]) => meta?.composerActivity === "workspace-ownership-changed",
    );
    expect(changes).toHaveLength(1);
    expect(JSON.stringify(reports.mock.calls)).not.toContain(OTHER_ID);
  });

  it("ignores a late store-change refusal of a request the previous store's workspace sent", async () => {
    const reports = vi
      .spyOn(clientDiagnostics, "reportClientDiagnostic")
      .mockImplementation(() => {});
    const read = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ workspace: { storageId: STORAGE_ID } })));
    vi.stubGlobal("fetch", read);
    render(
      <WorkspacePersistenceBoundary>
        <main>Owned workspace</main>
      </WorkspacePersistenceBoundary>,
    );
    expect(await screen.findByRole("main")).toHaveTextContent("Owned workspace");
    const readsBefore = read.mock.calls.length;
    act(() => {
      announceWorkspaceStorageChanged("c".repeat(64));
      window.dispatchEvent(new Event(WORKSPACE_STORAGE_CHANGED_EVENT));
    });
    expect(screen.getByRole("main")).toHaveTextContent("Owned workspace");
    expect(read.mock.calls).toHaveLength(readsBefore);
    expect(
      reports.mock.calls.some(
        ([, meta]) => meta?.composerActivity === "workspace-ownership-changed",
      ),
    ).toBe(false);
  });

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
