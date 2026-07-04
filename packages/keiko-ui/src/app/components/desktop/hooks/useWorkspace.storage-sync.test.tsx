/**
 * STEP 07 cluster B — cross-tab localStorage storage-sync guards.
 *
 *  - GEN-PERF-PERSISTENCE-001: a cross-tab `storage` event whose serialized value
 *    equals what is already applied must NOT re-apply the snapshot (which would give
 *    every window a brand-new object identity, defeating the WindowFrame memos and
 *    bumping the link revision). A genuinely-different storage event still applies.
 *  - GEN-PERF-PERSISTENCE-012 (storage path): a snapshot that just arrived from a
 *    sibling tab's storage event must NOT be immediately re-written to localStorage
 *    (a byte-identical echo of what the sibling just wrote).
 */
import { useRef } from "react";
import type { ReactElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "./useWorkspace";
import { Workspace } from "../Workspace";
import { registerWindowRender } from "../windows/WindowsRegistry";
import type { AppWindow } from "../windows/types";
import type { UseWorkspaceResult } from "./useWorkspace.types";

vi.mock("../WorkspaceShader", () => ({ WorkspaceShader: () => null }));

const WS_LS = "keiko.workspace.v4";

function win(patch: Partial<AppWindow> & Pick<AppWindow, "id">): AppWindow {
  return {
    type: "agents",
    x: 40,
    y: 40,
    w: 360,
    h: 320,
    z: 1,
    cfg: {},
    max: false,
    zoom: 1,
    ...patch,
  };
}

let latest: UseWorkspaceResult | null = null;

function Harness(): ReactElement {
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef);
  latest = ws;
  return <main ref={wsRef} className="workspace" data-testid="ws" />;
}

function setWebdriver(value: boolean): void {
  Object.defineProperty(navigator, "webdriver", { configurable: true, value });
}

function dispatchStorage(key: string, newValue: string): void {
  // Construct with the event type only, then define the read-only fields the handler reads. Passing
  // them through the init dict is standard, but the DOM externs CodeQL analyses against model
  // StorageEvent with a narrower signature, so the init dict reads as superfluous trailing arguments.
  const event = new StorageEvent("storage");
  Object.defineProperties(event, {
    key: { value: key },
    newValue: { value: newValue },
    storageArea: { value: window.localStorage },
  });
  window.dispatchEvent(event);
}

describe("useWorkspace cross-tab storage sync (STEP 07 cluster B)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setWebdriver(true); // disable server sync for localStorage-only assertions
    latest = null;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setWebdriver(true);
  });

  it("keeps window object identity for windows unchanged by a storage event (PERSISTENCE-001)", () => {
    const seeded = [win({ id: "agents-1" }), win({ id: "agents-2", x: 600 })];
    window.localStorage.setItem(WS_LS, JSON.stringify(seeded));
    render(<Harness />);

    const before = latest?.wins;
    expect(before?.map((w) => w.id)).toEqual(["agents-1", "agents-2"]);

    // A sibling tab moves ONLY agents-1's geometry; agents-2 is byte-identical.
    const moved = [win({ id: "agents-1", x: 123 }), win({ id: "agents-2", x: 600 })];
    act(() => {
      window.localStorage.setItem(WS_LS, JSON.stringify(moved));
      dispatchStorage(WS_LS, JSON.stringify(moved));
    });

    const after = latest?.wins;
    // agents-1 changed → new geometry is applied.
    expect(after?.find((w) => w.id === "agents-1")?.x).toBe(123);
  });

  it("skips the whole re-apply when the storage event value is byte-identical (PERSISTENCE-001)", () => {
    const seeded = [win({ id: "agents-1" })];
    const serialized = JSON.stringify(seeded);
    window.localStorage.setItem(WS_LS, serialized);
    render(<Harness />);

    const before = latest?.wins;
    // Prime lastApplied via the debounced local persist (deps [conns, wins]) —
    // hydration wrote the same value; the storage handler also seeds the ref.
    // Dispatch a storage event with the SAME value it already holds.
    act(() => {
      dispatchStorage(WS_LS, serialized);
    });
    const after = latest?.wins;
    // A no-op storage event must not swap in a fresh array (identity preserved),
    // so memoized WindowFrames and useLinkRevision are untouched.
    expect(after).toBe(before);
  });

  it("does not re-write localStorage for a snapshot that just arrived via storage (PERSISTENCE-012)", () => {
    const seeded = [win({ id: "agents-1" })];
    window.localStorage.setItem(WS_LS, JSON.stringify(seeded));
    render(<Harness />);

    // A sibling tab writes a genuinely different snapshot; our tab applies it.
    const incoming = [win({ id: "agents-1", x: 250 }), win({ id: "agents-2", x: 700 })];
    const incomingSerialized = JSON.stringify(incoming);
    window.localStorage.setItem(WS_LS, incomingSerialized);

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    act(() => {
      dispatchStorage(WS_LS, incomingSerialized);
    });
    // The apply commits new wins; the debounced local persist effect fires but MUST
    // skip the byte-identical echo write of what the sibling just wrote.
    const wsWritesAfterApply = setItemSpy.mock.calls.filter(([key]) => key === WS_LS).length;
    expect(wsWritesAfterApply).toBe(0);
    setItemSpy.mockRestore();

    // Confirm the apply actually happened (not a no-op skip).
    expect(latest?.wins?.map((w) => w.id).sort()).toEqual(["agents-1", "agents-2"]);
  });
});

// GEN-PERF-BENCHMARK-009 — end-to-end: the real Workspace fed by the real useWorkspace
// must NOT re-render any window body when a byte-identical cross-tab storage event
// arrives. This is the non-vacuous guard: remove the PERSISTENCE-001 equality skip and
// the storage handler swaps in a fresh wins array with new identities, re-rendering
// every window body → this test fails.
describe("no-op cross-tab storage event does not re-render window bodies (BENCHMARK-009)", () => {
  const bodyRenders: string[] = [];

  function IntegrationHarness(): ReactElement {
    const wsRef = useRef<HTMLDivElement>(null);
    const ws = useWorkspace(wsRef);
    return <Workspace ws={ws} wsRef={wsRef} openPalette={() => undefined} />;
  }

  beforeEach(() => {
    window.localStorage.clear();
    setWebdriver(true);
    bodyRenders.length = 0;
    registerWindowRender("agents", (_cfg, ctx) => {
      bodyRenders.push(String(ctx.windowId));
      return null;
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setWebdriver(true);
  });

  it("skips all window body rebuilds on a byte-identical storage event", () => {
    const seeded = [win({ id: "agents-1" }), win({ id: "agents-2", x: 600 })];
    const serialized = JSON.stringify(seeded);
    window.localStorage.setItem(WS_LS, serialized);
    render(<IntegrationHarness />);

    // Bodies rendered once at mount.
    expect([...bodyRenders].sort()).toEqual(["agents-1", "agents-2"]);
    bodyRenders.length = 0;

    // A sibling tab writes the SAME value → byte-identical storage event. The guard
    // must skip the re-apply so no window body rebuilds.
    act(() => {
      dispatchStorage(WS_LS, serialized);
    });
    expect(bodyRenders).toEqual([]);
  });
});
