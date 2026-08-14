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
