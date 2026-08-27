// Epic #518 / Issue #527 + 0.3.0 release audit — the shell's LIVE keyboard state.
//
// `resolveShellShortcutState` produces the two things AppShell consumes: the binding table it feeds
// to `useKeyboardShortcuts`, and the chord-label map the quick-access palette renders. The
// reserved-chord and conflict pins live here (relocated from shell-undo-bindings.test.ts, where they
// guarded a hardcoded copy nothing read) so they guard the table the product actually dispatches.
//
// This file also owns the persisted-keybinding boundary. Before the audit fix the module resolved
// shell chords through a SECOND, weaker override parser (globalKeyboardShortcuts.ts) that validated
// only the "version|commandId|binding" shape and the binding→chord mapping — never the
// reserved-chord or collision rules the settings layer enforces. `useKeyboardShortcuts` throws on
// either, IN RENDER, so one hand-edited or imported settings line ("1|undo|CtrlOrMeta+T")
// white-screened the whole desktop on every load with no in-product way out. The render tests below
// reproduce exactly that, which is why this suite renders and therefore lives in a .tsx file.

import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  WORKSPACE_TRUST_SCHEMA_VERSION,
  workspaceChordKey,
} from "@oscharko-dev/keiko-contracts";

import {
  readShellShortcutRefusalCount,
  resetShellShortcutRefusalSurface,
  resolveShellShortcutState,
  shellShortcutRefusalDiagnostic,
} from "./shellShortcutState";
import {
  detectReservedBindings,
  detectShortcutConflicts,
  useKeyboardShortcuts,
} from "./hooks/useKeyboardShortcuts";
import { buildUnifiedQuickAccessCommands, type Command } from "./quickAccessRegistry";
import { EDITOR_PALETTE_COMMANDS, type EditorPaletteHost } from "./widgets/cards/editorCommands";
import { translate } from "@/lib/i18n";

// The palette builder requires a translator (a caller that forgets the locale must not compile),
// and "en" is simply the locale under test here.
const enTranslate = (key: Parameters<typeof translate>[1]): string => translate("en", key);

// The commands the shell itself dispatches. The label map is deliberately WIDER than this (it
// covers every bound editor command too, see the palette suite below), so these are asserted as a
// present subset rather than as the whole key set.
const GLOBAL_SHELL_COMMAND_IDS = [
  "undo",
  "redo",
  "focus-status",
  "focus-workspace-search",
  "quick-access.files",
  "quick-access.commands",
  "open-editor-settings",
] as const;

function paletteHost(): EditorPaletteHost {
  return {
    root: "/repo",
    activePaneId: "pane-1",
    paneCount: 2,
    activeFile: "src/app.ts",
    closedTabCount: 1,
    dirtyCount: 1,
    verificationRunning: false,
    verifiableTarget: "src/app.test.ts",
    workspaceTrustUiAvailable: false,
    verificationCatalog: {
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      projectId: "/repo",
      workspaceTrust: {
        kind: "workspace-trust-status",
        schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
        projectId: "/repo",
        trust: "trusted",
        decidedBy: "server",
        reason: "human-grant",
        revision: 1,
      },
      kinds: [],
    },
    splitActive: () => undefined,
    closeActiveSplit: () => undefined,
    closeActiveTab: () => undefined,
    nextTab: () => undefined,
    prevTab: () => undefined,
    reopenClosed: () => undefined,
    saveAll: () => undefined,
    runFileTests: () => undefined,
    runWorkspaceVerification: () => undefined,
    cancelVerification: () => undefined,
    trustWorkspaceScripts: () => undefined,
    revokeWorkspaceScriptTrust: () => undefined,
    openProblems: () => undefined,
    openFileHistory: () => undefined,
  };
}

function appCommand(id: string): Command {
  return { id, label: `App ${id}`, group: "App", icon: "spark", run: () => undefined };
}

// Mirrors AppShellInner's own use of the substrate: resolved shell bindings straight into the
// hook that fails closed on a conflicting or browser-reserved chord.
function ShellShortcutHost({ overrides }: { readonly overrides: readonly string[] }): ReactNode {
  const state = resolveShellShortcutState(overrides);
  useKeyboardShortcuts({ bindings: state.bindings, dispatch: vi.fn(), platform: "other" });
  return <div>shell rendered</div>;
}

describe("shellShortcutState — the live shell binding table", () => {
  it("claims undo, redo, footer-status, workspace search, and quick-access chords", () => {
    const ids = resolveShellShortcutState([]).bindings.map((binding) => binding.commandId);

    expect(ids).toEqual([...GLOBAL_SHELL_COMMAND_IDS]);
  });

  it("uses the governed shell chords", () => {
    const map = new Map(
      resolveShellShortcutState([]).bindings.map((binding) => [binding.commandId, binding.chord]),
    );

    expect(map.get("undo")).toEqual({ key: "z", mod: ["cmd"] });
    expect(map.get("redo")).toEqual({ key: "z", mod: ["cmd", "shift"] });
    expect(map.get("focus-status")).toEqual({ key: "s", mod: ["alt"] });
    expect(map.get("focus-workspace-search")).toEqual({ key: "f", mod: ["cmd", "shift"] });
    expect(map.get("quick-access.files")).toEqual({ key: "p", mod: ["cmd"] });
    expect(map.get("quick-access.commands")).toEqual({ key: "p", mod: ["cmd", "shift"] });
    expect(map.get("open-editor-settings")).toEqual({ key: ",", mod: ["cmd"] });
  });

  // KEIKO-0164: the Keyboard Shortcuts panel advertises this chord, so the desktop shell must
  // dispatch it through the same substrate that receives every other shell shortcut.
  it("dispatches the advertised editor-settings chord from the desktop", () => {
    const dispatch = vi.fn();
    const view = render(<SubstrateHost overrides={[]} platform="other" onDispatch={dispatch} />);

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });

    expect(dispatch).toHaveBeenCalledWith("open-editor-settings");
    view.unmount();
  });

  it("contains no browser-reserved chord", () => {
    expect(detectReservedBindings(resolveShellShortcutState([]).bindings)).toEqual([]);
  });

  it("contains no internal chord conflict", () => {
    expect(detectShortcutConflicts(resolveShellShortcutState([]).bindings)).toEqual([]);
  });

  // The reserved/conflict contract must hold for a REBOUND table too — the input a hardcoded copy
  // of the table could never exercise.
  it("resolves a user override into the dispatched chord, still reserved-free and conflict-free", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(detectReservedBindings(state.bindings)).toEqual([]);
    expect(detectShortcutConflicts(state.bindings)).toEqual([]);
    expect(state.bindings.map((binding) => workspaceChordKey(binding.chord))).toContain(
      workspaceChordKey({ key: "o", mod: ["cmd", "shift"] }),
    );
  });
});

describe("shellShortcutState — persisted override validation", () => {
  it("resolves global bindings and labels from editor setting overrides", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.labels.get("quick-access.files")).toMatch(/O$/u);
  });

  it("labels every global shell command by default", () => {
    const state = resolveShellShortcutState([]);

    for (const commandId of GLOBAL_SHELL_COMMAND_IDS) {
      expect(state.labels.has(commandId)).toBe(true);
    }
    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("applies validated global overrides and ignores editor-only override records", () => {
    const state = resolveShellShortcutState([
      "1|quick-access.files|CtrlOrMeta+Shift+O",
      "1|view.splitRight|CtrlOrMeta+Alt+\\",
    ]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "o", mod: ["cmd", "shift"] },
    });
    expect(state.bindings.map((entry) => entry.commandId)).not.toContain("view.splitRight");
  });

  it("falls back to the default binding when a persisted override is malformed", () => {
    const state = resolveShellShortcutState(["not-a-valid-override"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("ignores a persisted override that claims a browser-reserved chord", () => {
    const state = resolveShellShortcutState(["1|undo|CtrlOrMeta+T"]);

    expect(state.bindings).toContainEqual({
      commandId: "undo",
      chord: { key: "z", mod: ["cmd"] },
    });
  });

  it("ignores a persisted override whose explicit modifier spelling hides a reserved chord", () => {
    const state = resolveShellShortcutState(["1|focus-status|Ctrl+T"]);

    expect(state.bindings).toContainEqual({
      commandId: "focus-status",
      chord: { key: "s", mod: ["alt"] },
    });
  });

  it("ignores a persisted override that collides with another command's chord", () => {
    const state = resolveShellShortcutState(["1|focus-status|Meta+Z"]);

    expect(state.bindings).toContainEqual({
      commandId: "undo",
      chord: { key: "z", mod: ["cmd"] },
    });
    expect(state.bindings).toContainEqual({
      commandId: "focus-status",
      chord: { key: "s", mod: ["alt"] },
    });
  });

  it.each([
    ["a browser-reserved chord", "1|undo|CtrlOrMeta+T"],
    ["an explicit-modifier reserved chord", "1|focus-status|Ctrl+T"],
    ["a chord already claimed by another command", "1|focus-status|Meta+Z"],
    ["an unparsable record", "1|undo"],
  ])("keeps the shell rendering when a persisted override carries %s", (_label, override) => {
    render(<ShellShortcutHost overrides={[override]} />);

    expect(screen.getByText("shell rendered")).toBeTruthy();
  });

  it("keeps the shell rendering for a valid override", () => {
    render(<ShellShortcutHost overrides={["1|quick-access.files|CtrlOrMeta+Shift+O"]} />);

    expect(screen.getByText("shell rendered")).toBeTruthy();
  });
});

// ─── 0.3.0 release audit (#2802) — the SUBSTRATE OUTCOME is the pin ───────────────────────────
//
// Two bypasses of the reserved-chord guard survived the projection fix above, and BOTH of them
// fooled `isWorkspaceReservedChord`, so that predicate cannot be what a regression test asks. What
// is pinned below is what the user experiences: whether the browser keeps its own chord
// (`defaultPrevented`) and which command id the shell dispatches. Every hostile case is compared
// against the SAME measurement taken with no overrides at all, so the expectation is derived from
// the shipped product rather than restated here.
//
// Both platforms are covered deliberately. Finding 1 is invisible on macOS — `["ctrl","cmd"]`
// only collapses onto a single physical modifier OFF macOS, where `normalizeModifiers` maps
// cmd → ctrlKey — so a mac-only assertion would have passed over the defect.

type SubstrateOutcome = {
  readonly defaultPrevented: boolean;
  readonly dispatched: readonly string[];
};

function SubstrateHost(props: {
  readonly overrides: readonly string[];
  readonly platform: "mac" | "other";
  readonly onDispatch: (commandId: string) => void;
}): ReactNode {
  const state = resolveShellShortcutState(props.overrides);
  useKeyboardShortcuts({
    bindings: state.bindings,
    dispatch: props.onDispatch,
    platform: props.platform,
  });
  return <div>shell rendered</div>;
}

function pressThroughShell(args: {
  readonly overrides: readonly string[];
  readonly platform: "mac" | "other";
  readonly chord: KeyboardEventInit;
}): SubstrateOutcome {
  const dispatched: string[] = [];
  const view = render(
    <SubstrateHost
      overrides={args.overrides}
      platform={args.platform}
      onDispatch={(commandId) => dispatched.push(commandId)}
    />,
  );
  const event = new KeyboardEvent("keydown", { ...args.chord, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  view.unmount();
  return { defaultPrevented: event.defaultPrevented, dispatched };
}

// The physical chord the browser owns, spelled with the modifier key the platform really uses.
function browserChord(platform: "mac" | "other", key: string, shift: boolean): KeyboardEventInit {
  return platform === "mac"
    ? { key, metaKey: true, shiftKey: shift }
    : { key, ctrlKey: true, shiftKey: shift };
}

const DOUBLED_MODIFIER_SPELLINGS = [
  "Ctrl+Meta+T",
  "Meta+Ctrl+T",
  "ctrl+meta+t",
  " Ctrl + Meta + T ",
] as const;

const DOUBLED_MODIFIER_RESERVED_KEYS: readonly (readonly [string, string, boolean])[] = [
  ["Ctrl+Meta+R", "r", false],
  ["Ctrl+Meta+W", "w", false],
  ["Ctrl+Meta+Q", "q", false],
  ["Meta+Ctrl+Shift+N", "n", true],
];

describe.each(["other", "mac"] as const)(
  "shellShortcutState — a persisted override can never smuggle a reserved chord (%s)",
  (platform) => {
    it.each(DOUBLED_MODIFIER_SPELLINGS)(
      "leaves Cmd/Ctrl+T with the browser when an override spells it %s",
      (binding) => {
        const chord = browserChord(platform, "t", false);
        const stock = pressThroughShell({ overrides: [], platform, chord });
        const smuggled = pressThroughShell({ overrides: [`1|undo|${binding}`], platform, chord });

        expect(stock).toEqual({ defaultPrevented: false, dispatched: [] });
        expect(smuggled).toEqual(stock);
      },
    );

    it.each(DOUBLED_MODIFIER_RESERVED_KEYS)(
      "leaves the browser's own chord alone when an override spells it %s",
      (binding, key, shift) => {
        const chord = browserChord(platform, key, shift);
        const stock = pressThroughShell({ overrides: [], platform, chord });
        const smuggled = pressThroughShell({ overrides: [`1|undo|${binding}`], platform, chord });

        expect(stock).toEqual({ defaultPrevented: false, dispatched: [] });
        expect(smuggled).toEqual(stock);
      },
    );
  },
);

describe("shellShortcutState — the chord vocabulary the matcher can express", () => {
  // `WorkspaceKeyChord.mod` could carry ["ctrl","cmd"], a state `normalizeModifiers` collapses to
  // {ctrl} off macOS and that neither the reservation key nor `isWorkspaceReservedChord` can name.
  // No table the shell dispatches may contain one — that is the whole class, not one input.
  it.each([
    "1|undo|Ctrl+Meta+T",
    "1|undo|Ctrl+Meta+Alt+T",
    "1|undo|Ctrl+Meta+P",
    "1|quick-access.files|Meta+Ctrl+O",
    "1|focus-status|ctrl+meta+j",
  ])("never dispatches a chord carrying both ctrl and cmd (%s)", (override) => {
    const ambiguous = resolveShellShortcutState([override]).bindings.filter(
      (binding) => binding.chord.mod.includes("ctrl") && binding.chord.mod.includes("cmd"),
    );

    expect(ambiguous).toEqual([]);
  });
});

describe("shellShortcutState — a refused override never disarms its victim", () => {
  function stockChords(): ReadonlyMap<string, unknown> {
    return new Map(
      resolveShellShortcutState([]).bindings.map((binding) => [binding.commandId, binding.chord]),
    );
  }

  it("keeps quick-access.files on Cmd/Ctrl+P when a colliding override claims it", () => {
    const chord = { key: "p", ctrlKey: true };
    const stock = pressThroughShell({ overrides: [], platform: "other", chord });
    const attacked = pressThroughShell({
      overrides: ["1|undo|Meta+P", "1|quick-access.files|Meta+Shift+F"],
      platform: "other",
      chord,
    });

    expect(stock.dispatched).toEqual(["quick-access.files"]);
    expect(attacked).toEqual(stock);
  });

  it("falls a colliding override back to its command's own default, never to no binding", () => {
    const stock = stockChords();
    const attacked = new Map(
      resolveShellShortcutState([
        "1|undo|Meta+P",
        "1|quick-access.files|Meta+Shift+F",
      ]).bindings.map((binding) => [binding.commandId, binding.chord]),
    );

    expect(attacked.get("quick-access.files")).toEqual(stock.get("quick-access.files"));
    expect(attacked.get("undo")).toEqual(stock.get("undo"));
  });

  it.each(["1|undo|Ctrl+Meta+P", "1|undo|Ctrl+P"])(
    "never advertises a chord the command can no longer receive (%s)",
    (override) => {
      const state = resolveShellShortcutState([override]);
      const outcome = pressThroughShell({
        overrides: [override],
        platform: "other",
        chord: { key: "p", ctrlKey: true },
      });

      expect(outcome.dispatched).toEqual(["quick-access.files"]);
      expect(state.labels.get("quick-access.files")).toBe(
        resolveShellShortcutState([]).labels.get("quick-access.files"),
      );
    },
  );

  // The reporter's own regression case for the reserved-chord refusal.
  it("falls quick-access.files back to Cmd+P when its override is browser-reserved", () => {
    const state = resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+W"]);

    expect(state.bindings).toContainEqual({
      commandId: "quick-access.files",
      chord: { key: "p", mod: ["cmd"] },
    });
  });

  it("mounts the shell with that reserved-override table without throwing", () => {
    expect(() =>
      render(<ShellShortcutHost overrides={["1|quick-access.files|CtrlOrMeta+W"]} />),
    ).not.toThrow();
  });
});

// A refused override must not be a silent failure (AGENTS.md §7) — but `resolveShellShortcutState`
// runs on every shell mount AND every settings change, so an unbounded warn would be its own defect.
describe("shellShortcutState — a refusal is reported, not swallowed", () => {
  const RESERVED_OVERRIDE = "1|quick-access.files|CtrlOrMeta+W";

  function warnSpy(): MockInstance<typeof console.warn> {
    return vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  function warnedMessages(spy: MockInstance<typeof console.warn>): readonly string[] {
    return spy.mock.calls.map((call) => String(call[0]));
  }

  beforeEach(() => {
    resetShellShortcutRefusalSurface();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetShellShortcutRefusalSurface();
  });

  it("surfaces a refused persisted override instead of dropping it silently", () => {
    const warn = warnSpy();

    resolveShellShortcutState([RESERVED_OVERRIDE]);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("emits exactly once for three re-resolves of the same refused override", () => {
    const warn = warnSpy();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      resolveShellShortcutState([RESERVED_OVERRIDE]);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(readShellShortcutRefusalCount()).toBe(3);
  });

  it("emits nothing for a clean resolve", () => {
    const warn = warnSpy();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      resolveShellShortcutState([]);
      resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]);
    }

    expect(warn).not.toHaveBeenCalled();
    expect(readShellShortcutRefusalCount()).toBe(0);
  });

  it("re-arms when the refusal signature changes, and again after it clears", () => {
    const warn = warnSpy();

    resolveShellShortcutState([RESERVED_OVERRIDE]);
    resolveShellShortcutState(["1|keiko.unknown|CtrlOrMeta+K"]);
    resolveShellShortcutState([]);
    resolveShellShortcutState([RESERVED_OVERRIDE]);

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("carries no raw binding text, no rejected record, and no unknown command id", () => {
    const warn = warnSpy();

    resolveShellShortcutState(["1|keiko.unknown|Ctrl+Meta+T"]);

    const message = warnedMessages(warn).join("\n");
    expect(message).toContain("UNKNOWN_COMMAND");
    for (const secret of ["keiko.unknown", "Ctrl+Meta+T", "CtrlOrMeta", "1|"]) {
      expect(message).not.toContain(secret);
    }
  });

  it("reports an out-of-registry command id as a count, never as an id", () => {
    const message = shellShortcutRefusalDiagnostic(
      [
        { commandId: "undo", reasonCode: "KEYBINDING_COLLISION" },
        { commandId: "attacker.injected", reasonCode: "RESERVED_KEYBINDING" },
      ],
      null,
    );

    expect(message).toContain("undo=KEYBINDING_COLLISION");
    expect(message).toContain("unknown-commands=1");
    expect(message).not.toContain("attacker.injected");
  });

  // A whole-setting refusal names no command: the record that caused it is never echoed back, so
  // the reason code is all the operator gets — and all they may be given.
  it("reports a whole-setting refusal by reason code alone", () => {
    const warn = warnSpy();

    resolveShellShortcutState([RESERVED_OVERRIDE]);

    const message = warnedMessages(warn).join("\n");
    expect(message).toContain("setting=RESERVED_KEYBINDING");
    expect(message).not.toContain("quick-access.files");
  });
});

describe("shellShortcutState — palette chord labels", () => {
  it("labels the global commands from the live bindings", () => {
    expect(
      resolveShellShortcutState(["1|quick-access.files|CtrlOrMeta+Shift+O"]).labels.get(
        "quick-access.files",
      ),
    ).toMatch(/O$/u);
  });

  // Audit — the label map used to carry the six global command ids only, so no editor command could
  // ever pick up a rebind and the palette kept advertising the hardcoded chord.
  it("labels EVERY bound editor command, not just the global six", () => {
    const labels = resolveShellShortcutState([]).labels;

    expect(labels.has("view.splitRight")).toBe(true);
    expect(labels.has("tab.next")).toBe(true);
    expect(labels.has("tab.prev")).toBe(true);
    expect(labels.has("files.saveAll")).toBe(true);
    expect(labels.has("tab.reopenClosed")).toBe(true);
  });

  it("omits an unbound command so the palette renders no chord chip", () => {
    // `view.splitDown` ships with no default binding, and "Unbound" is settings wording, not a chord.
    expect(resolveShellShortcutState([]).labels.has("view.splitDown")).toBe(false);
  });

  it("labels the dispatched editor-settings command", () => {
    const labels = resolveShellShortcutState([]).labels;

    expect(labels.get("open-editor-settings")).toMatch(/,$/u);
    // Monaco-owned chords ARE dispatched (by Monaco), so they stay in.
    expect(labels.has("editor.save")).toBe(true);
  });

  it("reaches the palette row with the REBOUND editor chord instead of the hardcoded hint", () => {
    const hardcoded = EDITOR_PALETTE_COMMANDS.find(
      (command) => command.id === "tab.next",
    )?.keybinding;
    const state = resolveShellShortcutState(["1|tab.next|CtrlOrMeta+Shift+ArrowRight"]);

    const row = buildUnifiedQuickAccessCommands(
      [appCommand("theme")],
      paletteHost(),
      enTranslate,
      state.labels,
    ).find((command) => command.id === "tab.next");

    expect(hardcoded).toBeDefined();
    expect(row?.shortcut).toBeDefined();
    expect(row?.shortcut).not.toBe(hardcoded);
    expect(row?.shortcut).toMatch(/Right$/u);
  });
});
