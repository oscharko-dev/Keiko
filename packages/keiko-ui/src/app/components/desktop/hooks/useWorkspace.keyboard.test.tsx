import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace, type UseWorkspaceOptions } from "./useWorkspace";
import type { AppWindow, Connection } from "../windows/types";

const WORKSPACE_STORAGE_KEY = "keiko.workspace.v4";
const CONNECTION_STORAGE_KEY = "keiko.conns.v1";

function appWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return {
    id: "chat-1",
    type: "chat",
    x: 40,
    y: 40,
    w: 500,
    h: 360,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

function filesWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return appWindow({
    id: "files-1",
    type: "files",
    cfg: { resolvedRoot: "/repo", activeFilePath: "src/main.ts" },
    ...patch,
  });
}

function persistWorkspace(wins: readonly AppWindow[], conns: readonly Connection[] = []): void {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(wins));
  window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(conns));
}

function fakePointer(clientX = 100, clientY = 120): ReactPointerEvent<Element> {
  return {
    clientX,
    clientY,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactPointerEvent<Element>;
}

function Harness(options: UseWorkspaceOptions = {}): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(wsRef, options);

  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section className="window" data-window-id="chat-1">
        chat
      </section>
      <section className="window" data-window-id="files-1">
        files
      </section>
      <input aria-label="focused field" />
      <button type="button" onClick={() => workspace.api.close("files-1")}>
        close files
      </button>
      <button
        type="button"
        onClick={() =>
          workspace.api.updateConnBoundScope("files-1~chat-1", {
            kind: "directory",
            relativePaths: ["src"],
            root: "/repo",
            connectedAtMs: 99,
          })
        }
      >
        update bound scope
      </button>
      <button
        type="button"
        onClick={() => workspace.api.startConnect("files-1", fakePointer(180, 220))}
      >
        start connect
      </button>
      <button type="button" onClick={() => workspace.api.connect("files-1", "chat-1")}>
        connect
      </button>
      <output data-testid="wins">{JSON.stringify(workspace.wins ?? [])}</output>
      <output data-testid="conns">{JSON.stringify(workspace.conns)}</output>
      <output data-testid="connecting">{JSON.stringify(workspace.connecting)}</output>
    </main>
  );
}

function mockWorkspaceRect(): void {
  const workspace = screen.getByTestId("workspace");
  vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  });
}

function readWins(): AppWindow[] {
  return JSON.parse(screen.getByTestId("wins").textContent ?? "[]") as AppWindow[];
}

function readConns(): Connection[] {
  return JSON.parse(screen.getByTestId("conns").textContent ?? "[]") as Connection[];
}

describe("useWorkspace keyboard and connection workflow hardening", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("moves and resizes only the frontmost visible window with keyboard chords", async () => {
    persistWorkspace([
      filesWindow({ z: 1 }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    await waitFor(() => {
      const chat = readWins().find((w) => w.id === "chat-1");
      expect(chat).toMatchObject({ x: 116, y: 120, w: 500, h: 360, max: false });
    });

    fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    await waitFor(() => {
      const chat = readWins().find((w) => w.id === "chat-1");
      expect(chat).toMatchObject({ x: 116, y: 120, w: 500, h: 376, max: false });
    });
    expect(readWins().find((w) => w.id === "files-1")).toMatchObject({ x: 40, y: 40 });
  });

  it("keeps browser zoom chords untouched but routes Alt+Cmd zoom to window content zoom", async () => {
    persistWorkspace([filesWindow({ z: 4, zoom: 1 })]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()[0]?.zoom).toBe(1));

    fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true });
    expect(readWins()[0]?.zoom).toBe(1);

    fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true, altKey: true });
    await waitFor(() => expect(readWins()[0]?.zoom).toBe(1.1));
  });

  it("cancels an in-flight connect with Escape even when focus is inside a form field", async () => {
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "start connect" }));
    await waitFor(() => expect(screen.getByTestId("connecting")).toHaveTextContent("files-1"));

    screen.getByLabelText("focused field").focus();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(screen.getByTestId("connecting")).toHaveTextContent("null"));
  });

  it("unbinds bind-time Files scopes before closing a connected window", async () => {
    const onScopeUnbind = vi.fn();
    persistWorkspace(
      [filesWindow({ cfg: { resolvedRoot: "/repo-now" } }), appWindow()],
      [
        {
          id: "files-1~chat-1",
          a: "files-1",
          b: "chat-1",
          boundChatWindowId: "chat-1",
          boundRoot: "/repo-bound",
          boundScopeKind: "files",
          boundRelativePath: "old/path.ts",
        },
      ],
    );
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "close files" }));

    await waitFor(() => expect(readWins().some((w) => w.id === "files-1")).toBe(false));
    expect(onScopeUnbind).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        kind: "files",
        root: "/repo-bound",
        relativePaths: ["old/path.ts"],
      }),
    );
  });

  it("updates the persisted connection snapshot when a Files window changes visible scope", async () => {
    persistWorkspace(
      [filesWindow(), appWindow()],
      [{ id: "files-1~chat-1", a: "files-1", b: "chat-1", boundRoot: "/repo" }],
    );
    render(<Harness />);
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "update bound scope" }));

    await waitFor(() => {
      expect(readConns()[0]).toMatchObject({
        boundRoot: "/repo",
        boundScopeKind: "directory",
        boundRelativePath: "src",
      });
    });
  });

  it("draws valid manual edges only once", async () => {
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness />);
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    fireEvent.click(screen.getByRole("button", { name: "connect" }));

    await waitFor(() => expect(readConns()).toHaveLength(1));
    expect(readConns()[0]).toMatchObject({ id: "files-1~chat-1", a: "files-1", b: "chat-1" });
  });
});
