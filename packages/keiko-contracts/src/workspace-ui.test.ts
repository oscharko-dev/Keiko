// ADR-0028 §4 — the workspace chord vocabulary.
//
// 0.3.0 release audit (#2802). `workspaceChordKey` names a DECLARATION and deliberately keeps `cmd`
// and `ctrl` apart. The keyboard does not: `cmd` is the Meta key on macOS and the Control key
// everywhere else, so two different declarations can be one keystroke. Every guard that asks "is
// this chord reserved / already claimed / expressible at all" must ask it of the PHYSICAL chord —
// asking it of the declaration is what let a persisted `Ctrl+Meta+T` reach the substrate as
// `["ctrl","cmd"]`, a state the matcher collapses to plain Ctrl off macOS and no reservation could
// name. These pins cover both platforms explicitly: the defect is invisible on macOS.

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_RESERVED_CHORDS,
  isWorkspaceChordAcceptable,
  isWorkspaceDispatchableChord,
  isWorkspaceReservedChord,
  workspaceChordClaimKeys,
  workspaceChordKey,
  workspaceChordKeyForPlatform,
  workspaceChordsCollide,
  workspacePlatformModifiers,
  type WorkspaceKeyChord,
  workspaceActionLabel,
  workspaceInverseAction,
  type WorkspaceUiAction,
} from "./workspace-ui.js";

describe("workspace chord vocabulary — platform collapse", () => {
  it("resolves cmd to the Meta key on macOS and the Control key elsewhere", () => {
    expect([...workspacePlatformModifiers(["cmd"], "mac")]).toEqual(["meta"]);
    expect([...workspacePlatformModifiers(["cmd"], "other")]).toEqual(["ctrl"]);
  });

  it("passes every other modifier through unchanged on both platforms", () => {
    for (const platform of ["mac", "other"] as const) {
      expect([...workspacePlatformModifiers(["alt", "shift", "ctrl"], platform)].sort()).toEqual([
        "alt",
        "ctrl",
        "shift",
      ]);
    }
  });

  it("collapses ctrl and cmd onto ONE physical modifier off macOS", () => {
    expect(workspaceChordKeyForPlatform({ key: "t", mod: ["ctrl", "cmd"] }, "other")).toBe(
      workspaceChordKeyForPlatform({ key: "t", mod: ["ctrl"] }, "other"),
    );
    expect(workspaceChordKeyForPlatform({ key: "t", mod: ["ctrl", "cmd"] }, "mac")).not.toBe(
      workspaceChordKeyForPlatform({ key: "t", mod: ["ctrl"] }, "mac"),
    );
  });

  it("claims one keystroke per platform, deduplicated when they coincide", () => {
    expect([...workspaceChordClaimKeys({ key: "p", mod: ["cmd"] })].sort()).toEqual([
      "ctrl|p",
      "meta|p",
    ]);
    expect(workspaceChordClaimKeys({ key: "s", mod: ["alt"] })).toEqual(["alt|s"]);
  });

  it("keeps the declaration key distinct from the physical key", () => {
    expect(workspaceChordKey({ key: "p", mod: ["cmd"] })).toBe("cmd|p");
    expect(workspaceChordKey({ key: "p", mod: ["ctrl"] })).toBe("ctrl|p");
    expect(workspaceChordsCollide({ key: "p", mod: ["cmd"] }, { key: "p", mod: ["ctrl"] })).toBe(
      true,
    );
  });

  it("does not collide chords that differ on every platform", () => {
    expect(
      workspaceChordsCollide({ key: "p", mod: ["cmd"] }, { key: "p", mod: ["cmd", "alt"] }),
    ).toBe(false);
    expect(workspaceChordsCollide({ key: "p", mod: ["cmd"] }, { key: "q", mod: ["cmd"] })).toBe(
      false,
    );
  });
});

describe("workspace chord vocabulary — expressibility", () => {
  it.each([
    [{ key: "t", mod: ["ctrl", "cmd"] }, false],
    [{ key: "t", mod: ["cmd", "ctrl"] }, false],
    [{ key: "t", mod: ["ctrl", "cmd", "alt"] }, false],
    [{ key: "t", mod: ["ctrl"] }, true],
    [{ key: "t", mod: ["cmd"] }, true],
    [{ key: "t", mod: [] }, true],
    [{ key: "t", mod: ["alt", "shift"] }, true],
  ] as readonly (readonly [WorkspaceKeyChord, boolean])[])(
    "answers %j with %s",
    (chord, expected) => {
      expect(isWorkspaceDispatchableChord(chord)).toBe(expected);
    },
  );
});

// KEIKO-0423: the two predicates are a must-call-BOTH pair — dispatchable alone still admits a
// chord the host OS or browser has reserved — but nothing exported or tested the composition, so
// every caller had to remember it.
describe("workspace chord acceptability (combined predicate)", () => {
  it("rejects a chord that is reserved even though it is dispatchable", () => {
    for (const reserved of WORKSPACE_RESERVED_CHORDS) {
      expect(isWorkspaceDispatchableChord(reserved)).toBe(true);
      expect(isWorkspaceChordAcceptable(reserved)).toBe(false);
    }
  });

  it("rejects a chord carrying both cmd and ctrl", () => {
    expect(isWorkspaceChordAcceptable({ key: "j", mod: ["ctrl", "cmd"] })).toBe(false);
  });

  it("accepts a chord that is both dispatchable and unreserved", () => {
    const chord: WorkspaceKeyChord = { key: "j", mod: ["alt", "shift"] };
    expect(isWorkspaceDispatchableChord(chord)).toBe(true);
    expect(isWorkspaceReservedChord(chord)).toBe(false);
    expect(isWorkspaceChordAcceptable(chord)).toBe(true);
  });
});

describe("workspace chord vocabulary — reservation", () => {
  it("keeps every declared reservation reserved", () => {
    for (const reserved of WORKSPACE_RESERVED_CHORDS) {
      expect(isWorkspaceReservedChord(reserved)).toBe(true);
    }
  });

  // The doubled physical modifier is the smuggle: off macOS it IS the browser's own chord.
  it.each([
    { key: "t", mod: ["ctrl", "cmd"] },
    { key: "r", mod: ["cmd", "ctrl"] },
    { key: "w", mod: ["ctrl", "cmd"] },
    { key: "n", mod: ["ctrl", "cmd", "shift"] },
  ] as readonly WorkspaceKeyChord[])("treats %j as reserved", (chord) => {
    expect(isWorkspaceReservedChord(chord)).toBe(true);
  });

  it.each([
    { key: "z", mod: ["cmd"] },
    { key: "z", mod: ["cmd", "shift"] },
    { key: "s", mod: ["alt"] },
    { key: "f", mod: ["cmd", "shift"] },
    { key: "p", mod: ["cmd"] },
    { key: "p", mod: ["cmd", "shift"] },
    { key: "t", mod: ["cmd", "alt"] },
    { key: "t", mod: [] },
  ] as readonly WorkspaceKeyChord[])("leaves the shipped chord %j unreserved", (chord) => {
    expect(isWorkspaceReservedChord(chord)).toBe(false);
  });
});

// KEIKO-0248 — workspaceActionLabel and workspaceInverseAction are the 11-branch functions the
// undo/redo stack is built on, and the suite exercised neither. A wrong branch in either is a
// silently wrong undo: the stack would happily apply an inverse that does not undo the action.
describe("workspace UI action label and inverse", () => {
  const RECT_A = { x: 0, y: 0, w: 100, h: 100 };
  const RECT_B = { x: 10, y: 20, w: 200, h: 150 };
  const VIEW_A = { zoom: 1, x: 0, y: 0 };
  const VIEW_B = { zoom: 2, x: 40, y: 60 };
  const SNAPSHOT = { id: "w-1", type: "chat", rect: RECT_A, z: 3 };
  const SELECTION_A = { focusedWindowId: null, selectedWindowIds: [] };
  const SELECTION_B = { focusedWindowId: "w-1", selectedWindowIds: ["w-1"] };

  const ACTIONS: readonly WorkspaceUiAction[] = [
    { kind: "ui.window.move", windowId: "w-1", before: RECT_A, after: RECT_B },
    { kind: "ui.window.resize", windowId: "w-1", before: RECT_A, after: RECT_B },
    { kind: "ui.window.zorder", windowId: "w-1", before: 1, after: 5 },
    { kind: "ui.window.close", windowId: "w-1", windowSnapshot: SNAPSHOT },
    { kind: "ui.window.open", windowId: "w-1", windowSnapshot: SNAPSHOT },
    { kind: "ui.workspace.pan", before: VIEW_A, after: VIEW_B },
    { kind: "ui.workspace.zoom", before: VIEW_A, after: VIEW_B },
    { kind: "ui.workspace.fit", before: VIEW_A, after: VIEW_B },
    {
      kind: "ui.panel.toggle",
      panel: "governedGit",
      before: false,
      after: true,
      projectRoot: "/repo",
    },
    { kind: "ui.selection.change", before: SELECTION_A, after: SELECTION_B },
    { kind: "ui.tab.switch", before: "tab-a", after: "tab-b" },
  ];

  it("covers every action kind in the union", () => {
    expect(new Set(ACTIONS.map((action) => action.kind)).size).toBe(ACTIONS.length);
  });

  it.each(ACTIONS.map((action) => [action.kind, action] as const))(
    "labels %s with a non-empty human-readable string",
    (_kind, action) => {
      const label = workspaceActionLabel(action);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("ui.");
    },
  );

  it("gives every action kind a distinct label", () => {
    const labels = ACTIONS.map((action) => workspaceActionLabel(action));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(ACTIONS.map((action) => [action.kind, action] as const))(
    "inverts %s such that applying the inverse twice returns the original",
    (_kind, action) => {
      expect(workspaceInverseAction(workspaceInverseAction(action))).toEqual(action);
    },
  );

  it("swaps before and after on every state-transition action", () => {
    for (const action of ACTIONS) {
      const inverse = workspaceInverseAction(action);
      if ("before" in action && "after" in action) {
        expect(inverse).toMatchObject({ before: action.after, after: action.before });
      }
    }
  });

  it("turns a close into an open and an open into a close, keeping the snapshot", () => {
    const close: WorkspaceUiAction = {
      kind: "ui.window.close",
      windowId: "w-1",
      windowSnapshot: SNAPSHOT,
    };
    const inverse = workspaceInverseAction(close);
    expect(inverse.kind).toBe("ui.window.open");
    expect(inverse).toMatchObject({ windowSnapshot: SNAPSHOT });
    expect(workspaceInverseAction(inverse).kind).toBe("ui.window.close");
  });
});
