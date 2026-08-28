import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace, type UseWorkspaceOptions } from "./useWorkspace";
import { MAX_WORKSPACE_WINDOWS } from "./workspace-persistence";
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

function figmaImageWindow(patch: Partial<AppWindow> = {}): AppWindow {
  return appWindow({
    id: "figma-image-1",
    type: "figmaImage",
    cfg: {
      snapshotRunId: "snapshot-1",
      screenId: "1:42",
      selectedScreenName: "Payment view",
      imageSrc: "/api/figma/snapshots/snapshot-1/screens/0/image",
    },
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
  const [editorResults, setEditorResults] = useState<readonly boolean[]>([]);
  const [cutResult, setCutResult] = useState<unknown>(null);

  return (
    <main ref={wsRef} data-testid="workspace" className="workspace">
      <section className="window" data-window-id="chat-1" tabIndex={-1}>
        chat
        <button type="button">focus inside chat</button>
      </section>
      <section className="window" data-window-id="files-1" tabIndex={-1}>
        files
        <button type="button">focus inside files</button>
      </section>
      <input aria-label="focused field" />
      {/* Stands in for Monaco's hidden editing <textarea>, to assert the form-field guard (#1205 AC2). */}
      <textarea aria-label="editor text input" />
      <button type="button" onClick={() => workspace.api.close("files-1")}>
        close files
      </button>
      <button type="button" onClick={() => workspace.api.close("chat-1")}>
        close chat
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
      <button type="button" onClick={() => workspace.api.replaceSelection(["files-1"])}>
        select files
      </button>
      <button
        type="button"
        onClick={() => {
          for (
            let index = workspace.wins?.length ?? 0;
            index < MAX_WORKSPACE_WINDOWS - 1;
            index++
          ) {
            workspace.api.add("files");
          }
        }}
      >
        fill to one below the limit
      </button>
      <button
        type="button"
        onClick={() => {
          const filler = (workspace.wins ?? []).find(
            (win) => win.id !== "files-1" && win.id !== "chat-1",
          );
          if (filler !== undefined) workspace.api.close(filler.id);
        }}
      >
        close one filler window
      </button>
      <button type="button" onClick={() => workspace.api.replaceSelection(["files-1", "chat-1"])}>
        select files and chat
      </button>
      <button type="button" onClick={() => workspace.api.copySelectedWindows()}>
        copy selected windows
      </button>
      <button type="button" onClick={() => workspace.api.pasteCopiedWindows()}>
        paste copied windows
      </button>
      <button
        type="button"
        onClick={() => {
          const result = workspace.api.cutSelectedWindows();
          void result.settled.then((settled) => {
            setCutResult(settled);
          });
        }}
      >
        cut selected windows
      </button>
      <button
        type="button"
        onClick={() => {
          const first = workspace.api.openEditorFile({ root: "/repo-a", path: "src/a.ts" });
          const second = workspace.api.openEditorFile({ root: "/repo-b", path: "src/b.ts" });
          setEditorResults([first.ok, second.ok]);
        }}
      >
        open two editors
      </button>
      <output data-testid="wins">{JSON.stringify(workspace.wins ?? [])}</output>
      <output data-testid="conns">{JSON.stringify(workspace.conns)}</output>
      <output data-testid="connecting">{JSON.stringify(workspace.connecting)}</output>
      <output data-testid="selection">{JSON.stringify(workspace.selection)}</output>
      <output data-testid="image-sources">
        {JSON.stringify(workspace.api.linkedImageSources?.("quality") ?? null)}
      </output>
      <output data-testid="editor-results">{JSON.stringify(editorResults)}</output>
      <output data-testid="cut-result">{JSON.stringify(cutResult)}</output>
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

function readSelection(): { focusedWindowId: string | null; selectedWindowIds: readonly string[] } {
  return JSON.parse(screen.getByTestId("selection").textContent ?? "{}") as {
    focusedWindowId: string | null;
    selectedWindowIds: readonly string[];
  };
}

describe("useWorkspace keyboard and connection workflow hardening", () => {
  // The persisted-workspace reset is a PRECONDITION each test establishes for itself, not a
  // teardown. useDebouncedPersist flushes on unmount, so the previous test's cleanup() — which
  // runs in the shared afterEach of vitest.setup.ts, and therefore AFTER this file's afterEach
  // under vitest's default reverse ("stack") hook order — writes keiko.workspace.v4 and
  // keiko.conns.v1 again. Clearing here instead means no unmount write can outrun the reset,
  // whatever order the tests run in.
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reserves workspace capacity across editor allocations queued in one event", async () => {
    const onWindowLimitReached = vi.fn();
    persistWorkspace(
      Array.from({ length: MAX_WORKSPACE_WINDOWS - 1 }, (_unused, index) =>
        filesWindow({ id: `files-${String(index)}` }),
      ),
    );
    render(<Harness onWindowLimitReached={onWindowLimitReached} />);
    await waitFor(() => expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS - 1));
    mockWorkspaceRect();

    fireEvent.click(screen.getByRole("button", { name: "open two editors" }));

    await waitFor(() => {
      expect(JSON.parse(screen.getByTestId("editor-results").textContent ?? "[]")).toEqual([
        true,
        false,
      ]);
    });
    expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS);
    expect(readWins().filter((win) => win.type === "editor")).toHaveLength(1);
    expect(onWindowLimitReached).toHaveBeenCalledExactlyOnceWith(MAX_WORKSPACE_WINDOWS);
  });

  it("adopts workspace snapshots written by another tab", async () => {
    render(<Harness />);
    await waitFor(() => expect(readWins()).toEqual([]));

    persistWorkspace(
      [
        filesWindow({ z: 3, cfg: { resolvedRoot: "/repo", activeFilePath: "src/main.ts" } }),
        appWindow({ id: "chat-1", type: "chat", z: 4 }),
      ],
      [{ id: "files-1~chat-1", a: "files-1", b: "chat-1" }],
    );
    const storageEvent = new Event("storage");
    Object.defineProperties(storageEvent, {
      key: { value: WORKSPACE_STORAGE_KEY },
      newValue: { value: window.localStorage.getItem(WORKSPACE_STORAGE_KEY) },
      storageArea: { value: window.localStorage },
    });
    window.dispatchEvent(storageEvent);

    await waitFor(() => expect(readWins().map((w) => w.id)).toEqual(["files-1", "chat-1"]));
    expect(readConns()).toEqual([{ id: "files-1~chat-1", a: "files-1", b: "chat-1" }]);
  });

  it("moves and resizes the focused window with keyboard chords", async () => {
    // GEN-UI-KEYBOARD-006 — the move/resize chords act on the window that holds
    // focus. Focus inside chat-1 (also the frontmost window here) so the chord
    // scopes to it and leaves the background files-1 window untouched.
    persistWorkspace([
      filesWindow({ z: 1 }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    screen.getByRole("button", { name: "focus inside chat" }).focus();
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

  it("moves and resizes the focused NON-topmost window, not the topZ window (GEN-UI-KEYBOARD-006)", async () => {
    // files-1 is the LOWER window (z=1); chat-1 is topmost (z=10). Focus inside
    // files-1 and the chord must scope to files-1 — NOT the topZ chat-1.
    persistWorkspace([
      filesWindow({ z: 1, x: 40, y: 40, w: 500, h: 360 }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    screen.getByRole("button", { name: "focus inside files" }).focus();
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    await waitFor(() => {
      const files = readWins().find((w) => w.id === "files-1");
      expect(files).toMatchObject({ x: 56, y: 40, w: 500, h: 360, max: false });
    });

    fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown", altKey: true });
    await waitFor(() => {
      const files = readWins().find((w) => w.id === "files-1");
      expect(files).toMatchObject({ x: 56, y: 40, w: 500, h: 376, max: false });
    });
    // The topmost chat-1 window must not have moved at all.
    expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
      x: 100,
      y: 120,
      w: 500,
      h: 360,
    });
  });

  it("moves NO window when a keyboard chord fires with focus outside any window (GEN-UI-KEYBOARD-006)", async () => {
    persistWorkspace([
      filesWindow({ z: 1, x: 40, y: 40 }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    // A non-window control (outside every .window[data-window-id]) holds focus.
    screen.getByRole("button", { name: "start connect" }).focus();
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown", altKey: true });

    // Neither window moved or resized — the chord no-ops when focus is outside.
    expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
      x: 100,
      y: 120,
      w: 500,
      h: 360,
    });
    expect(readWins().find((w) => w.id === "files-1")).toMatchObject({
      x: 40,
      y: 40,
      w: 500,
      h: 360,
    });
  });

  it("copies and pastes selected windows through the workspace API", async () => {
    persistWorkspace([
      filesWindow({ z: 1, x: 40, y: 40, cfg: { resolvedRoot: "/repo" } }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1"]));

    fireEvent.click(screen.getByRole("button", { name: "copy selected windows" }));
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));

    await waitFor(() => expect(readWins()).toHaveLength(3));
    const pasted = readWins()[2];
    expect(pasted).toMatchObject({
      type: "files",
      x: 72,
      y: 72,
      cfg: {},
      max: false,
    });
    expect(pasted?.id).not.toBe("files-1");
    expect(readSelection().selectedWindowIds).toEqual([pasted?.id]);
  });

  it("issue #2150 — cuts selected windows and restores them at their original spot on first paste", async () => {
    persistWorkspace([
      filesWindow({ z: 1, x: 40, y: 40, cfg: { resolvedRoot: "/repo" } }),
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1"]));

    // Cut captures the content-free descriptor and closes the window.
    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(1));
    expect(readWins().find((w) => w.id === "files-1")).toBeUndefined();

    // Cut/paste is a MOVE: the first paste restores the cut window at its
    // original geometry AND with the state it had. Restoring only the layout
    // would silently destroy the window's root, open file, URL or cwd — the
    // content-free descriptor is the right payload for a duplicate, not for a
    // move of a window this same session just removed.
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(2));
    const restored = readWins().find((w) => w.type === "files");
    expect(restored).toMatchObject({ x: 40, y: 40, cfg: { resolvedRoot: "/repo" } });

    // A second paste is a duplicate again and offsets.
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(3));
    const duplicated = readWins().at(-1);
    expect(duplicated).toMatchObject({ x: 72, y: 72 });
  });

  it("issue #2150 — cut never closes a keyed (non-duplicable) window even when it is selected", async () => {
    // A chat window bound to a real conversation (chatId set) cannot be
    // recreated by paste — buildWorkspaceClipboardPayload treats it as keyed
    // and skips it. Cut must therefore leave it open: closing a window that
    // paste can never restore is data loss, not a cut.
    persistWorkspace([
      filesWindow({ z: 1, x: 40, y: 40, cfg: { resolvedRoot: "/repo" } }),
      appWindow({
        id: "chat-1",
        type: "chat",
        z: 10,
        x: 100,
        y: 120,
        cfg: { chatId: "conversation-1" },
      }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "select files and chat" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1", "chat-1"]));

    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));

    // Only the duplicable files window is removed; the keyed chat window survives.
    await waitFor(() => expect(readWins()).toHaveLength(1));
    expect(readWins().find((w) => w.id === "files-1")).toBeUndefined();
    expect(readWins().find((w) => w.id === "chat-1")).toBeDefined();

    // Selection state stays consistent: the removed window drops out, the
    // surviving one that was already selected stays selected.
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["chat-1"]));

    // The clipboard only ever captured the duplicable window, so paste
    // restores exactly the files window and never resurrects the chat window
    // as a second copy.
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(2));
    expect(readWins().filter((w) => w.type === "chat")).toHaveLength(1);
    const restoredFiles = readWins().find((w) => w.type === "files");
    expect(restoredFiles).toMatchObject({ x: 40, y: 40 });
  });

  it("tears a connection down once when a batch cut takes BOTH of its endpoints", async () => {
    // Every window in the batch reads the same pre-cut connection snapshot, so a
    // per-window loop would issue this edge's server-side unbind twice. A
    // non-idempotent second unbind can fail and leave the cut half-applied.
    const onScopeUnbind = vi.fn(() => true);
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "select files and chat" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1", "chat-1"]));

    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));

    await waitFor(() => expect(readWins()).toHaveLength(0));
    expect(onScopeUnbind).toHaveBeenCalledTimes(1);
  });

  it("restores a cut window's own state, not just its geometry", async () => {
    // The clipboard descriptor is content-free by design (ADR-0123 D5) — correct
    // for a duplicate, destructive for a move. A cut Files window must come back
    // with its root, otherwise cut silently discards what the user was working on.
    persistWorkspace([filesWindow({ cfg: { resolvedRoot: "/repo", activeFilePath: "src/a.ts" } })]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(0));

    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));

    await waitFor(() => expect(readWins()).toHaveLength(1));
    expect(readWins()[0]).toMatchObject({
      id: "files-1",
      cfg: { resolvedRoot: "/repo", activeFilePath: "src/a.ts" },
    });
  });

  it("lets a copy after a cut supersede the pending move", async () => {
    persistWorkspace([
      filesWindow({ cfg: { resolvedRoot: "/repo" } }),
      appWindow({ id: "chat-1", type: "chat", x: 300 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(1));

    // Copying the surviving window replaces the pending move.
    fireEvent.click(screen.getByRole("button", { name: "select files and chat" }));
    fireEvent.click(screen.getByRole("button", { name: "copy selected windows" }));
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));

    await waitFor(() => expect(readWins()).toHaveLength(2));
    // The cut Files window is NOT resurrected; the paste duplicated the chat.
    expect(readWins().some((w) => w.id === "files-1")).toBe(false);
    expect(readWins().filter((w) => w.type === "chat")).toHaveLength(2);
  });

  it("keeps un-restored cut windows buffered when the workspace is full", async () => {
    // The move buffer is the ONLY copy of a cut window's state. Dropping what
    // capacity could not take would destroy it permanently, and the paste must
    // report the real capacity outcome rather than a silent partial success.
    const onWindowLimitReached = vi.fn();
    persistWorkspace([
      filesWindow({ cfg: { resolvedRoot: "/repo" } }),
      appWindow({ id: "chat-1", type: "chat", x: 300 }),
    ]);
    render(<Harness onWindowLimitReached={onWindowLimitReached} />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "select files and chat" }));
    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(0));

    // Fill the workspace so only one of the two cut windows can come back.
    fireEvent.click(screen.getByRole("button", { name: "fill to one below the limit" }));
    await waitFor(() => expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS - 1));

    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS));
    expect(onWindowLimitReached).toHaveBeenCalled();

    // The window capacity refused is still buffered: closing one frees a slot
    // and the next paste brings it back with its state intact.
    fireEvent.click(screen.getByRole("button", { name: "close one filler window" }));
    await waitFor(() => expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS - 1));
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));

    await waitFor(() => expect(readWins()).toHaveLength(MAX_WORKSPACE_WINDOWS));
    // BOTH originals are back under their own ids with their own state. Had the
    // remainder been dropped, this second paste would have fallen through to the
    // content-free duplicate path and produced a fresh `*-copy-*` id instead.
    const restoredFiles = readWins().find((w) => w.id === "files-1");
    const restoredChat = readWins().find((w) => w.id === "chat-1");
    expect(restoredFiles).toBeDefined();
    expect(restoredChat).toBeDefined();
    expect(restoredFiles?.cfg).toMatchObject({ resolvedRoot: "/repo" });
  });

  it("does not let a copy that lands mid-cut be overwritten by the settling cut", async () => {
    // Teardown is asynchronous, so a user can cut, copy something else, and
    // paste before the cut settles. The stale cut completion must not write its
    // windows back into the move buffer and hijack that paste.
    const onScopeUnbind = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)),
    );
    persistWorkspace([filesWindow({ cfg: { resolvedRoot: "/repo" } }), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));

    // Copy the chat BEFORE the cut's teardown resolves.
    fireEvent.click(screen.getByRole("button", { name: "select files and chat" }));
    fireEvent.click(screen.getByRole("button", { name: "copy selected windows" }));

    await waitFor(() => expect(readWins().some((w) => w.id === "files-1")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));

    // The paste duplicated the copy; it did not resurrect the cut Files window.
    await waitFor(() => expect(readWins().length).toBeGreaterThan(1));
    expect(readWins().some((w) => w.id === "files-1")).toBe(false);
  });

  it("does not report a cut for a window whose teardown refused to close it", async () => {
    // closeWithTeardown only removes a connected window once every unbind is
    // accepted; a refused unbind deliberately leaves the window open so the
    // grounding stays consistent. Cut must not announce that window as cut, and
    // must not arm the zero-offset restore — the next paste would then land a
    // duplicate exactly on a window that never left.
    const onScopeUnbind = vi.fn(() => false);
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1"]));

    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));

    await waitFor(() => expect(onScopeUnbind).toHaveBeenCalled());
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("cut-result").textContent ?? "null")).toMatchObject({
        captured: 0,
      }),
    );
    // The refused window is still there.
    expect(readWins().some((w) => w.id === "files-1")).toBe(true);

    // Paste must offset like a duplicate rather than restore onto the open window.
    fireEvent.click(screen.getByRole("button", { name: "paste copied windows" }));
    await waitFor(() => expect(readWins()).toHaveLength(3));
    const pasted = readWins().find((w) => w.type === "files" && w.id !== "files-1");
    expect(pasted?.x).not.toBe(readWins().find((w) => w.id === "files-1")?.x);
  });

  it("issue #2710 audit — cutting a connected window unbinds its scope like close does", async () => {
    // Cut used to remove windows through a raw setWins filter instead of
    // closeWithTeardown, so a cut Files window never fired onScopeUnbind: the
    // visible edge disappeared (useConnectionPrune sweeps the orphaned conn
    // object) but the chat's server-side grounding against the folder was
    // never told to let go — the exact bug closeWithTeardown's "uiux-fix F008
    // C120" comment exists to prevent for ordinary close.
    const onScopeUnbind = vi.fn();
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "select files" }));
    await waitFor(() => expect(readSelection().selectedWindowIds).toEqual(["files-1"]));

    fireEvent.click(screen.getByRole("button", { name: "cut selected windows" }));

    await waitFor(() => expect(readWins().some((w) => w.id === "files-1")).toBe(false));
    expect(onScopeUnbind).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ root: "/repo" }),
      undefined,
    );
    // The edge itself is swept by useConnectionPrune once the window is gone.
    await waitFor(() => expect(readConns()).toHaveLength(0));
  });

  it("snaps the focused window left/right/maximize with Cmd+Alt+Arrow (GEN-UI-KEYBOARD-009)", async () => {
    // Workspace rect is 1000×800 at zoom 1, so left snap = {x:0,y:0,w:500,h:800}.
    persistWorkspace([
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(1));

    screen.getByRole("button", { name: "focus inside chat" }).focus();

    fireEvent.keyDown(window, {
      key: "ArrowLeft",
      code: "ArrowLeft",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() => {
      expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
        x: 0,
        y: 0,
        w: 500,
        h: 800,
        max: false,
      });
    });

    fireEvent.keyDown(window, {
      key: "ArrowRight",
      code: "ArrowRight",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() => {
      expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
        x: 500,
        y: 0,
        w: 500,
        h: 800,
        max: false,
      });
    });

    fireEvent.keyDown(window, {
      key: "ArrowUp",
      code: "ArrowUp",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() => {
      expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
        x: 0,
        y: 0,
        w: 1000,
        h: 800,
        max: true,
      });
    });
  });

  it("does not move or resize the frontmost window while the editor text input is focused", async () => {
    // Issue #1205 Acceptance Criterion 2 + the keyboard conflict review: the Workspace window chords
    // (Cmd/Ctrl+Arrow move, Alt+Arrow resize) must never reach the editor's text input. Monaco's
    // editing surface is a <textarea>, which the form-field guard shields, so the chords are skipped
    // and the typed Arrow keys move the caret instead of the window.
    persistWorkspace([
      appWindow({ id: "chat-1", type: "chat", z: 10, x: 100, y: 120, w: 500, h: 360 }),
    ]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()).toHaveLength(1));

    screen.getByLabelText("editor text input").focus();
    fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown", altKey: true });

    expect(readWins().find((w) => w.id === "chat-1")).toMatchObject({
      x: 100,
      y: 120,
      w: 500,
      h: 360,
      max: false,
    });
  });

  it("keeps browser zoom chords untouched but routes Alt+Cmd zoom to window content zoom", async () => {
    persistWorkspace([filesWindow({ z: 4, zoom: 1 })]);
    render(<Harness />);
    mockWorkspaceRect();
    await waitFor(() => expect(readWins()[0]?.zoom).toBe(1));

    // GEN-UI-KEYBOARD-006 — content zoom now scopes to the focused window.
    screen.getByRole("button", { name: "focus inside files" }).focus();

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

  it("does not unbind the current Files scope when a persisted bind snapshot was elided", async () => {
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
    expect(onScopeUnbind).not.toHaveBeenCalled();
  });

  it("snapshots the chat owner before closing a bound chat window", async () => {
    const onScopeUnbind = vi.fn();
    persistWorkspace([
      filesWindow(),
      appWindow({ cfg: { chatId: "chat-private", projectPath: "/private" } }),
    ]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "close chat" }));

    await waitFor(() => expect(readWins().some((win) => win.id === "chat-1")).toBe(false));
    expect(onScopeUnbind).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ root: "/repo" }),
      { conversationId: "chat-private", projectPath: "/private" },
    );
  });

  it("retains a connected window until unbind is accepted and permits a retry", async () => {
    const onScopeUnbind = vi
      .fn<NonNullable<UseWorkspaceOptions["onScopeUnbind"]>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "close files" }));
    await waitFor(() => expect(onScopeUnbind).toHaveBeenCalledOnce());
    expect(readWins().some((win) => win.id === "files-1")).toBe(true);
    expect(readConns()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "close files" }));
    await waitFor(() => expect(onScopeUnbind).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(readWins().some((win) => win.id === "files-1")).toBe(false));
  });

  it("retains a connected window when its unbind callback rejects", async () => {
    const onScopeUnbind = vi.fn<NonNullable<UseWorkspaceOptions["onScopeUnbind"]>>(() =>
      Promise.reject(new TypeError("customer-specific detail")),
    );
    persistWorkspace([filesWindow(), appWindow()]);
    render(<Harness onScopeUnbind={onScopeUnbind} />);
    await waitFor(() => expect(readWins()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "connect" }));
    await waitFor(() => expect(readConns()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "close files" }));

    await waitFor(() => expect(onScopeUnbind).toHaveBeenCalledOnce());
    expect(readWins().some((win) => win.id === "files-1")).toBe(true);
    expect(readConns()).toHaveLength(1);
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

  it("exposes linked Figma image sources through the returned Workspace API", async () => {
    persistWorkspace(
      [appWindow({ id: "quality", type: "quality" }), figmaImageWindow()],
      [{ id: "quality~figma-image-1", a: "quality", b: "figma-image-1" }],
    );
    render(<Harness />);

    await waitFor(() =>
      expect(screen.getByTestId("image-sources")).toHaveTextContent("Payment view"),
    );
    expect(screen.getByTestId("image-sources")).toHaveTextContent('"kind":"image"');
    expect(screen.getByTestId("image-sources")).toHaveTextContent('"screenId":"1:42"');
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
