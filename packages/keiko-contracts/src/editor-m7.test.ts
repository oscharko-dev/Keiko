import { describe, expect, it } from "vitest";

import {
  __validateEditorM7KeybindingForTests,
  EDITOR_M7_COMMAND_REGISTRY,
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  defaultEditorM7Settings,
  parseEditorM7SettingPatch,
  parseEditorM7SettingsEvent,
  parseEditorM7SettingsRecord,
  parseEditorM7SettingValue,
  parseEditorM7KeybindingOverrides,
  parseEditorM7WatchEvent,
  parseEditorM7WatchSnapshot,
  planEditorM7ModelEviction,
  resolveEditorM7AiActivation,
  resolveEditorM7Settings,
  serializeEditorM7KeybindingOverride,
  validateEditorM7Keybinding,
  type EditorM7AiActivationInput,
  type EditorM7CommandDefinition,
  type EditorM7CommandScope,
  type EditorM7ModelEntry,
  type EditorM7SettingId,
  type EditorM7SettingsSnapshot,
} from "./editor-m7.js";

function aiInput(change: Partial<EditorM7AiActivationInput> = {}): EditorM7AiActivationInput {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    feature: "inlineCompletion",
    productSupported: true,
    operatorCeiling: "allowed",
    explicitOptIn: true,
    modelCapability: "available",
    budget: "available",
    providerHealth: "healthy",
    securityPrerequisites: "satisfied",
    legacyFlag: "unset",
    ...change,
  };
}

describe("M7 editor setting registry", () => {
  it("declares an additive opaque debug workspace identity projection", () => {
    const workspaceId: NonNullable<EditorM7SettingsSnapshot["debugWorkspaceId"]> = "a".repeat(64);

    expect(workspaceId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("declares bounded defaults, scopes, live semantics, and M6-compatible defaults", () => {
    const defaults = defaultEditorM7Settings();
    expect(EDITOR_M7_SCHEMA_VERSION).toBe("1");
    expect(defaults.fontSize).toBe(13);
    expect(defaults.tabSize).toBe(2);
    expect(defaults.inlineCompletion).toBe(false);
    expect(defaults.testGeneration).toBe(false);
    expect(defaults.patchApply).toBe(false);
    expect(defaults.wordWrap).toBe("off");
    expect(defaults.renderWhitespace).toBe("selection");
    expect(defaults.inlineCompletion).toBe(false);
    expect(defaults.keybindingOverrides).toEqual([]);
    expect(defaults.debuggingEnabled).toBe(false);
    expect(defaults.gitCommitMessagePolicy).toBe("keiko-conventional");
    expect(EDITOR_M7_SETTING_REGISTRY.every((entry) => entry.description.length > 0)).toBe(true);
    expect(EDITOR_M7_SETTING_REGISTRY.every((entry) => entry.scopes.length > 0)).toBe(true);
  });

  // Codex-sweep finding (same bug class as command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
  // each entry's `scopes` array was individually frozen at declaration time, but the entry
  // OBJECT itself was not — only the outer array was, via Object.freeze — so
  // `EDITOR_M7_SETTING_REGISTRY[0].minimum = -1` (widening a bound parseEditorM7SettingPatch
  // enforces) succeeded. Modules run in strict mode, so a write to a genuinely frozen object
  // throws.
  it("freezes each setting entry itself, not just the registry array holding them", () => {
    const [first] = EDITOR_M7_SETTING_REGISTRY;
    expect(first).toBeDefined();
    expect(() => {
      (first as { defaultValue: unknown }).defaultValue = "tampered";
    }).toThrow(TypeError);
  });

  it("accepts only the two governed commit-message policy modes", () => {
    expect(
      parseEditorM7SettingPatch("user", { gitCommitMessagePolicy: "repository-native" }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7SettingPatch("workspace", { gitCommitMessagePolicy: "keiko-conventional" }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7SettingPatch("user", { gitCommitMessagePolicy: "arbitrary-rules" }),
    ).toEqual({ ok: false, reasonCode: "VALUE_OUT_OF_BOUNDS" });
  });

  it("resolves default < user < permitted workspace and carries source/provenance", () => {
    const user = parseEditorM7SettingPatch("user", { fontSize: 15, tabSize: 4 });
    const workspace = parseEditorM7SettingPatch("workspace", { fontSize: 17 });
    expect(user.ok).toBe(true);
    expect(workspace.ok).toBe(true);
    if (!user.ok || !workspace.ok) throw new Error("unexpected parse failure");

    const resolved = resolveEditorM7Settings({ user: user.value, workspace: workspace.value });
    expect(resolved.find((entry) => entry.id === "fontSize")).toMatchObject({
      value: 17,
      source: "workspace",
      scope: "workspace",
      effect: "live",
    });
    expect(resolved.find((entry) => entry.id === "tabSize")).toMatchObject({
      value: 4,
      source: "user",
      scope: "user",
    });
  });

  it("fails closed for workspace-denied, unknown, future, hostile, and oversized input", () => {
    expect(parseEditorM7SettingPatch("workspace", { minimap: true })).toMatchObject({
      ok: false,
      reasonCode: "WORKSPACE_SCOPE_DENIED",
    });
    expect(parseEditorM7SettingPatch("user", { debuggingEnabled: true })).toMatchObject({
      ok: false,
      reasonCode: "WORKSPACE_SCOPE_DENIED",
    });
    expect(parseEditorM7SettingPatch("user", { ghost: true })).toMatchObject({
      ok: false,
      reasonCode: "UNKNOWN_SETTING",
    });
    expect(
      parseEditorM7SettingsRecord({ schemaVersion: "99", revision: 0, values: {} }),
    ).toMatchObject({
      ok: false,
      reasonCode: "SCHEMA_VERSION_UNSUPPORTED",
    });
    expect(parseEditorM7SettingPatch("user", { fontSize: 999 })).toMatchObject({
      ok: false,
      reasonCode: "VALUE_OUT_OF_BOUNDS",
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("boom");
        },
      },
    );
    expect(() => parseEditorM7SettingPatch("user", hostile)).not.toThrow();
    expect(parseEditorM7SettingPatch("user", hostile)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it("applies policy locks without changing persisted user or workspace source semantics", () => {
    const user = parseEditorM7SettingPatch("user", { inlineCompletion: true });
    expect(user.ok).toBe(true);
    if (!user.ok) throw new Error("unexpected parse failure");
    const [inline] = resolveEditorM7Settings({
      user: user.value,
      ceiling: { locked: { inlineCompletion: "POLICY_LOCKED" } },
    }).filter((entry) => entry.id === "inlineCompletion");
    expect(inline).toMatchObject({
      value: true,
      source: "user",
      policyLocked: true,
      reasonCode: "POLICY_LOCKED",
    });
  });
});

describe("M7 watcher and model-retention contracts", () => {
  it("accepts content-free relative file events and rejects roots, bodies, and unsafe paths", () => {
    expect(
      parseEditorM7WatchEvent({
        schemaVersion: "1",
        sequence: 1,
        kind: "changed",
        relativePath: "src/index.ts",
        metadataHash: "0123456789abcdef",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7WatchEvent({
        schemaVersion: "1",
        sequence: 2,
        kind: "changed",
        relativePath: "/secret/root.ts",
      }),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_PATH" });
    expect(
      parseEditorM7WatchEvent({
        schemaVersion: "1",
        sequence: 3,
        kind: "changed",
        relativePath: "src/index.ts",
        body: "raw file content",
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts content-free watcher snapshots and explicit rescan events", () => {
    expect(
      parseEditorM7WatchEvent({
        schemaVersion: "1",
        sequence: 4,
        kind: "rescan",
        relativePath: "",
        health: "rescanRequired",
        reason: "ambiguous-event",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7WatchSnapshot({
        schemaVersion: "1",
        sequence: 4,
        health: "degraded",
        rootToken: "0123456789abcdef",
        nativeWatcherCount: 1,
        subscriberCount: 2,
        queueDepth: 0,
        replayCapacity: 128,
        replayOldestSequence: 1,
        eventCount: 4,
        requiresSnapshot: false,
        degradedReasons: ["unsupported-recursive-watch"],
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorM7WatchSnapshot({
        schemaVersion: "1",
        sequence: 4,
        health: "healthy",
        root: "/secret/root",
        rootToken: "0123456789abcdef",
        nativeWatcherCount: 1,
        subscriberCount: 1,
        queueDepth: 0,
        replayCapacity: 128,
        replayOldestSequence: 1,
        eventCount: 4,
        requiresSnapshot: false,
        degradedReasons: [],
      }),
    ).toMatchObject({ ok: false });
  });

  it("evicts deterministic LRU clean inactive models while protecting dirty, pinned, active, pending", () => {
    const entries: readonly EditorM7ModelEntry[] = [
      model("dirty", 1, 5, { dirty: true }),
      model("old-clean", 2, 5, {}),
      model("active", 3, 5, { active: true }),
      model("new-clean", 4, 5, {}),
    ];
    expect(planEditorM7ModelEviction({ entries, maximumCount: 3, maximumBytes: 15 })).toStrictEqual(
      {
        retained: ["dirty", "active", "new-clean"],
        evicted: ["old-clean"],
        protected: ["dirty", "active"],
      },
    );
  });
});

describe("M7 keybinding, snippet, and AI activation contracts", () => {
  // Codex-sweep finding: the editorCommand() factory returns a plain, unfrozen object per call
  // (its own contexts/defaultBindings sub-arrays are individually frozen, but the command object
  // itself is not) and EDITOR_M7_COMMAND_REGISTRY only froze the outer array — so a command's
  // own field, e.g. dispatchOwner, was writable after construction.
  it("freezes each command entry itself, not just the registry array holding them", () => {
    const [first] = EDITOR_M7_COMMAND_REGISTRY;
    expect(first).toBeDefined();
    expect(() => {
      (first as { rebindable: boolean }).rebindable = !first?.rebindable;
    }).toThrow(TypeError);
  });

  // KEIKO-0875 (#3332): "explorer" and "git" were legal EditorM7CommandScope values with zero
  // registered commands using either -- two unreachable branches in scopeLabel and two
  // unexercisable i18n keys. The product owner decided to narrow the type rather than keep it as
  // a forward declaration; this pin proves the union no longer admits either value.
  it("rejects explorer and git as EditorM7CommandScope values", () => {
    // The assertion here is the `@ts-expect-error` directive itself, enforced by `npm run
    // typecheck`: if either literal were ever legal again, tsc would fail on an unused
    // `@ts-expect-error`. A runtime `expect(...).toBe(...)` on a value just assigned from the
    // same literal would be tautological (SonarJS S5914) and prove nothing `tsc` doesn't already.
    // @ts-expect-error -- "explorer" is not a legal EditorM7CommandScope; no registered command
    // uses it, and the KeyboardShortcutsPanel branch that read it was deleted alongside the
    // "settings.keyboard.scopeExplorer" i18n key.
    const explorerScope: EditorM7CommandScope = "explorer";
    // @ts-expect-error -- same for "git"; the "settings.keyboard.scopeGit" i18n key was deleted
    // alongside its branch too.
    const gitScope: EditorM7CommandScope = "git";
    void explorerScope;
    void gitScope;

    // Real runtime assertion (not a restatement of the type check above): the type-level guard
    // only stops a literal "explorer"/"git" from being written in source. It cannot stop a value
    // smuggled in via a wider-typed variable or an `as EditorM7CommandScope` cast from reaching
    // the actual runtime registry. This proves the operational invariant the type narrowing is
    // meant to protect -- no registered command actually carries either retired scope -- against
    // the real array scopeLabel and every other registry consumer reads.
    const registeredScopes = new Set(EDITOR_M7_COMMAND_REGISTRY.map((entry) => entry.scope));
    expect(registeredScopes.has("explorer")).toBe(false);
    expect(registeredScopes.has("git")).toBe(false);
  });

  it("keeps a closed command registry and rejects reserved, malformed, unknown, and colliding bindings", () => {
    expect(EDITOR_M7_COMMAND_REGISTRY.map((entry) => entry.id)).toContain("editor.save");
    expect(
      EDITOR_M7_COMMAND_REGISTRY.find((entry) => entry.id === "open-editor-settings"),
    ).toMatchObject({
      contexts: ["settings", "editor"],
    });
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Shift+O",
        activeBindings: {},
      }),
    ).toStrictEqual({ ok: true, value: "CtrlOrMeta+Shift+O" });
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Q",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "RESERVED_KEYBINDING" });
    expect(
      validateEditorM7Keybinding({
        commandId: "keiko.unknown",
        binding: "CtrlOrMeta+K",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "UNKNOWN_COMMAND" });
    expect(
      validateEditorM7Keybinding({
        commandId: "view.splitRight",
        binding: "CtrlOrMeta+Alt+S",
        activeBindings: { "files.saveAll": "CtrlOrMeta+Alt+S" },
      }),
    ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
    expect(
      validateEditorM7Keybinding({
        commandId: "editor.save",
        binding: "CtrlOrMeta+Shift+S",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "POLICY_LOCKED" });
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "CtrlOrMeta+Shift",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  it("rejects reserved bindings regardless of modifier case or order", () => {
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "ctrlormeta+q",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "RESERVED_KEYBINDING" });
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "Shift+CtrlOrMeta+N",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "RESERVED_KEYBINDING" });
  });

  it.each(["U", "Space", "Esc", "F5", "Shift+U"])(
    "rejects the unsafe bare or Shift-only binding %s",
    (binding) => {
      expect(
        validateEditorM7Keybinding({
          commandId: "undo",
          binding,
          activeBindings: {},
        }),
      ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
    },
  );

  it("rejects malformed input before applying a command's policy lock", () => {
    expect(
      validateEditorM7Keybinding({
        commandId: "editor.renameSymbol",
        binding: "CtrlOrMeta+",
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  it("rejects a binding whose serialized override record exceeds the byte cap", () => {
    const binding = `Alt+${"A".repeat(168)}`;
    const record = serializeEditorM7KeybindingOverride({
      schemaVersion: "1",
      commandId: "quick-access.files",
      binding,
    });
    expect(parseEditorM7KeybindingOverrides([record])).toMatchObject({
      ok: false,
      reasonCode: "OVERSIZED",
    });

    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding,
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  it.each([
    "",
    " ",
    "+",
    "+S",
    "CtrlOrMeta+",
    "CtrlOrMeta++S",
    "CtrlOrMeta+\u0000S",
    `CtrlOrMeta+${"A".repeat(4096)}`,
  ])("rejects the malformed or hostile binding %j", (binding) => {
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding,
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  // 0.3.0 release audit (#2802) — `Ctrl` and `Meta` name the same position in the chord vocabulary
  // the workspace matcher uses, so a binding carrying both is not a keystroke a keyboard produces.
  // It was accepted, and the doubled modifier carried a browser-reserved chord past the reservation
  // check: `Ctrl+Meta+T` normalized to `ctrlormeta+ctrlormeta+t`, which matches no reservation, and
  // then fired on a plain Ctrl+T off macOS.
  it.each([
    "Ctrl+Meta+T",
    "Meta+Ctrl+T",
    "ctrl+meta+t",
    " Ctrl + Meta + T ",
    "Ctrl+Meta+Alt+T",
    "Ctrl+Meta+O",
    "Meta+Ctrl+Shift+N",
  ])("rejects the doubled physical modifier in %s", (binding) => {
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding,
        activeBindings: {},
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  // A reservation is one PHYSICAL chord however it is spelled — and the collapse must dedupe, or a
  // doubled modifier produces a key no reservation can equal.
  it.each(["Ctrl+T", "Meta+T", "CtrlOrMeta+T", "meta+r", "Ctrl+W", "Meta+Shift+N"])(
    "rejects the reserved chord spelled %s",
    (binding) => {
      expect(
        validateEditorM7Keybinding({
          commandId: "quick-access.files",
          binding,
          activeBindings: {},
        }),
      ).toMatchObject({ ok: false, reasonCode: "RESERVED_KEYBINDING" });
    },
  );

  // Collision is decided on the physical chord too: dispatch matches keystrokes, not strings. A
  // `Meta+P` override read as distinct from `CtrlOrMeta+P` and silently took Cmd+P from its owner.
  it.each(["Meta+P", "Ctrl+P", "ctrlormeta+p", " meta + p "])(
    "detects the collision when the taken chord is spelled %s",
    (binding) => {
      expect(
        validateEditorM7Keybinding({
          commandId: "undo",
          binding,
          activeBindings: { "quick-access.files": "CtrlOrMeta+P" },
        }),
      ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
    },
  );

  it("rejects a persisted override list that smuggles a reserved chord past the schema", () => {
    expect(parseEditorM7KeybindingOverrides(["1|undo|Ctrl+T"])).toMatchObject({
      ok: false,
      reasonCode: "RESERVED_KEYBINDING",
    });
  });

  it("still accepts a chord that only LOOKS adjacent to a claimed one", () => {
    expect(
      validateEditorM7Keybinding({
        commandId: "undo",
        binding: "CtrlOrMeta+Alt+P",
        activeBindings: { "quick-access.files": "CtrlOrMeta+P" },
      }),
    ).toStrictEqual({ ok: true, value: "CtrlOrMeta+Alt+P" });
  });

  it("rejects unknown and duplicate modifiers and canonicalizes valid chords", () => {
    for (const binding of [
      "Hyper+O",
      "CtrlOrMeta+CtrlOrMeta+O",
      "shift+Shift+O",
      "CtrlOrMeta+Meta+O",
    ]) {
      expect(
        validateEditorM7Keybinding({
          commandId: "quick-access.files",
          binding,
          activeBindings: {},
        }),
      ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
    }
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: " shift + CTRLORMETA + alt + o ",
        activeBindings: {},
      }),
    ).toStrictEqual({ ok: true, value: "CtrlOrMeta+Alt+Shift+O" });
  });

  it("detects collisions regardless of modifier order and case", () => {
    expect(
      validateEditorM7Keybinding({
        commandId: "view.splitRight",
        binding: "shift+ctrlormeta+o",
        activeBindings: { "quick-access.files": "CtrlOrMeta+Shift+O" },
      }),
    ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
  });

  it("rejects overlapping context reuse and normalizes persisted override records", () => {
    const disjointCommands = [
      {
        id: "settings-only",
        labelKey: "command.settingsOnly",
        descriptionKey: "command.settingsOnly.description",
        scope: "settings",
        contexts: ["settings"],
        defaultBindings: [],
        rebindable: true,
        dispatchOwner: "keiko",
      },
      {
        id: "explorer-only",
        labelKey: "command.explorerOnly",
        descriptionKey: "command.explorerOnly.description",
        // KEIKO-0875 (#3332): "explorer" was narrowed out of EditorM7CommandScope (zero commands
        // used it); "editor" here is an arbitrary scope disjoint from "settings" below -- this
        // fixture pins context-disjoint reuse, which the collision check keys on `contexts`, not
        // `scope`. The still-valid "explorer" EditorM7CommandContext is untouched (out of scope).
        scope: "editor",
        contexts: ["explorer"],
        defaultBindings: [],
        rebindable: true,
        dispatchOwner: "keiko",
      },
    ] as const satisfies readonly EditorM7CommandDefinition[];
    expect(
      __validateEditorM7KeybindingForTests(
        {
          commandId: "settings-only",
          binding: "Alt+S",
          activeBindings: [{ commandId: "explorer-only", binding: "Alt+S" }],
        },
        disjointCommands,
      ),
    ).toStrictEqual({ ok: true, value: "Alt+S" });
    expect(
      validateEditorM7Keybinding({
        commandId: "view.splitRight",
        binding: "Alt+S",
        activeBindings: [{ commandId: "focus-status", binding: "Alt+S" }],
      }),
    ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
    expect(
      validateEditorM7Keybinding({
        commandId: "view.splitRight",
        binding: "Shift+Alt+X",
        activeBindings: [{ commandId: "open-editor-settings", binding: "Shift+Alt+X" }],
      }),
    ).toMatchObject({ ok: false, reasonCode: "KEYBINDING_COLLISION" });
    const record = serializeEditorM7KeybindingOverride({
      schemaVersion: "1",
      commandId: "view.splitRight",
      binding: " CtrlOrMeta + Alt + / ",
    });
    expect(record).toBe("1|view.splitRight|CtrlOrMeta+Alt+/");
    expect(parseEditorM7KeybindingOverrides([record])).toMatchObject({
      ok: true,
      value: [{ commandId: "view.splitRight", binding: "CtrlOrMeta+Alt+/" }],
    });
    expect(parseEditorM7KeybindingOverrides(["2|view.splitRight|CtrlOrMeta+Alt+/"])).toMatchObject({
      ok: false,
      reasonCode: "SCHEMA_VERSION_UNSUPPORTED",
    });
    expect(parseEditorM7KeybindingOverrides([record, record])).toMatchObject({
      ok: false,
      reasonCode: "KEYBINDING_COLLISION",
    });
  });

  it("keeps AI features default-off and applies operator, security, model, budget, and health ceilings", () => {
    expect(resolveEditorM7AiActivation(aiInput())).toMatchObject({
      state: "active",
      policyResult: "allowed",
      reasonCode: "ACTIVE",
    });
    expect(resolveEditorM7AiActivation(aiInput({ explicitOptIn: false }))).toMatchObject({
      state: "available",
      reasonCode: "EXPLICIT_OPT_IN_REQUIRED",
      policyResult: "denied",
    });
    expect(resolveEditorM7AiActivation(aiInput({ operatorCeiling: "denied" }))).toMatchObject({
      state: "denied",
      reasonCode: "OPERATOR_CEILING_DENIED",
    });
    expect(
      resolveEditorM7AiActivation(aiInput({ securityPrerequisites: "missing" })),
    ).toMatchObject({
      state: "denied",
      reasonCode: "SECURITY_PREREQUISITE_MISSING",
    });
    expect(resolveEditorM7AiActivation(aiInput({ modelCapability: "missing" }))).toMatchObject({
      state: "degraded",
      reasonCode: "MODEL_CAPABILITY_MISSING",
    });
    expect(resolveEditorM7AiActivation(aiInput({ budget: "exhausted" }))).toMatchObject({
      state: "degraded",
      reasonCode: "BUDGET_UNAVAILABLE",
    });
    expect(resolveEditorM7AiActivation(aiInput({ providerHealth: "unhealthy" }))).toMatchObject({
      state: "degraded",
      reasonCode: "PROVIDER_UNHEALTHY",
    });
    expect(resolveEditorM7AiActivation({ ...aiInput(), operatorCeiling: "root" })).toMatchObject({
      state: "denied",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
    expect(resolveEditorM7AiActivation(aiInput({ legacyFlag: "enabled" }))).toMatchObject({
      state: "active",
      reasonCode: "ACTIVE",
    });
  });

  it("parses content-free editor settings SSE events and rejects malformed setting ids", () => {
    expect(
      parseEditorM7SettingsEvent({
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        sequence: 1,
        kind: "changed",
        revision: 2,
        userRevision: 2,
        workspaceRevision: 0,
        scope: "user",
        settingIds: ["fontSize", "formatOnSave"],
        storeState: "ready",
      }),
    ).toMatchObject({
      ok: true,
      value: { settingIds: ["fontSize", "formatOnSave"] },
    });
    expect(
      parseEditorM7SettingsEvent({
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        sequence: 1,
        kind: "changed",
        revision: 2,
        userRevision: 2,
        workspaceRevision: 0,
        scope: "user",
        settingIds: ["fontSize", "secrets"],
        storeState: "ready",
      }),
    ).toMatchObject({ ok: false, reasonCode: "UNKNOWN_SETTING" });
  });
});

function model(
  identity: string,
  lastAccessSequence: number,
  byteSize: number,
  overrides: Partial<EditorM7ModelEntry>,
): EditorM7ModelEntry {
  return {
    identity,
    lastAccessSequence,
    byteSize,
    dirty: false,
    pinned: false,
    active: false,
    pendingOperation: false,
    ...overrides,
  };
}

const VALID_SETTINGS_EVENT = Object.freeze({
  schemaVersion: EDITOR_M7_SCHEMA_VERSION,
  sequence: 1,
  kind: "changed",
  revision: 2,
  userRevision: 2,
  workspaceRevision: 0,
  scope: "user",
  settingIds: [] as readonly string[],
  storeState: "ready",
});

const VALID_WATCH_ENVELOPE = Object.freeze({
  schemaVersion: EDITOR_M7_SCHEMA_VERSION,
  sequence: 1,
  kind: "changed",
  relativePath: "src/a.ts",
});

const VALID_WATCH_SNAPSHOT = Object.freeze({
  schemaVersion: EDITOR_M7_SCHEMA_VERSION,
  sequence: 1,
  health: "healthy",
  rootToken: "0123456789abcdef",
  nativeWatcherCount: 0,
  subscriberCount: 0,
  queueDepth: 0,
  replayCapacity: 0,
  replayOldestSequence: 0,
  eventCount: 0,
  requiresSnapshot: false,
  degradedReasons: [] as readonly string[],
});

function validAiRecord(): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    feature: "inlineCompletion",
    productSupported: true,
    operatorCeiling: "allowed",
    explicitOptIn: true,
    modelCapability: "available",
    budget: "available",
    providerHealth: "healthy",
    securityPrerequisites: "satisfied",
  };
}

describe("M7 malformed input rejection paths", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["array", []],
    ["number", 42],
    ["string", "record"],
  ])("rejects a setting patch that is not a record (%s)", (_label, input) => {
    expect(parseEditorM7SettingPatch("user", input)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it.each<[string, string, unknown]>([
    ["boolean typed", "insertSpaces", 1],
    ["enum typed", "wordWrap", "hard"],
    ["fractional integer", "fontSize", 12.5],
    ["string as integer", "fontSize", "13"],
  ])("rejects %s setting with malformed value", (_label, id, value) => {
    expect(parseEditorM7SettingPatch("user", { [id]: value })).toMatchObject({
      ok: false,
      reasonCode: "VALUE_OUT_OF_BOUNDS",
    });
  });

  it.each<[string, unknown, string]>([
    ["not an array", "list", "OVERSIZED"],
    [
      "exceeding max items",
      Array.from({ length: 65 }, (_, index) => `p${String(index)}`),
      "OVERSIZED",
    ],
    ["a non-string entry", [42], "UNSAFE_PATH"],
    ["an absolute path", ["/etc"], "UNSAFE_PATH"],
    ["a backslash", ["a\\b"], "UNSAFE_PATH"],
    ["a parent segment", ["../x"], "UNSAFE_PATH"],
    ["a current segment", ["./x"], "UNSAFE_PATH"],
    ["duplicate entries", ["a", "a"], "UNSAFE_PATH"],
  ])("rejects watcherExclusions with %s", (_label, input, expected) => {
    expect(parseEditorM7SettingPatch("user", { watcherExclusions: input })).toMatchObject({
      ok: false,
      reasonCode: expected,
    });
  });

  it.each<[string, unknown, string]>([
    ["null", null, "INVALID_INPUT"],
    ["an array", [], "INVALID_INPUT"],
    [
      "an unknown field",
      { schemaVersion: "1", revision: 0, values: {}, extra: 1 },
      "UNKNOWN_FIELD",
    ],
    ["a negative revision", { schemaVersion: "1", revision: -1, values: {} }, "INVALID_INPUT"],
    ["a fractional revision", { schemaVersion: "1", revision: 1.5, values: {} }, "INVALID_INPUT"],
    ["a string revision", { schemaVersion: "1", revision: "0", values: {} }, "INVALID_INPUT"],
  ])("rejects a settings record that is %s", (_label, input, expected) => {
    expect(parseEditorM7SettingsRecord(input)).toMatchObject({ ok: false, reasonCode: expected });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an unknown envelope key", { ...VALID_SETTINGS_EVENT, extra: 1 }],
    ["an invalid kind", { ...VALID_SETTINGS_EVENT, kind: "spurious" }],
    ["a fractional revision", { ...VALID_SETTINGS_EVENT, revision: 1.5 }],
    ["a negative sequence", { ...VALID_SETTINGS_EVENT, sequence: -1 }],
    ["an invalid scope", { ...VALID_SETTINGS_EVENT, scope: "system" }],
    ["an invalid storeState", { ...VALID_SETTINGS_EVENT, storeState: "half" }],
    ["settingIds that are not an array", { ...VALID_SETTINGS_EVENT, settingIds: "fontSize" }],
  ])("rejects a settings event with %s", (_label, input) => {
    expect(parseEditorM7SettingsEvent(input)).toMatchObject({ ok: false });
  });

  it.each<[string, unknown]>([
    ["not a record", null],
    ["an unknown envelope key", { ...VALID_WATCH_ENVELOPE, extra: 1 }],
    ["the wrong schemaVersion", { ...VALID_WATCH_ENVELOPE, schemaVersion: "2" }],
    ["a fractional sequence", { ...VALID_WATCH_ENVELOPE, sequence: 1.5 }],
  ])("rejects a watch event envelope when it is %s", (_label, input) => {
    expect(parseEditorM7WatchEvent(input)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an invalid kind", { kind: "delete" }],
    ["an invalid entryKind", { entryKind: "block" }],
    ["an invalid metadataHash", { metadataHash: "not-hex" }],
    ["an invalid health", { health: "chill" }],
    ["an invalid reason", { reason: "unknown" }],
    ["a negative sizeBytes", { sizeBytes: -1 }],
    ["a string modifiedAt", { modifiedAt: "yesterday" }],
    ["an unsafe oldRelativePath", { oldRelativePath: "/a" }],
  ])("rejects a watch event payload with %s", (_label, override) => {
    expect(parseEditorM7WatchEvent({ ...VALID_WATCH_ENVELOPE, ...override })).toMatchObject({
      ok: false,
      reasonCode: "UNSAFE_PATH",
    });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an unknown key", { ...VALID_WATCH_SNAPSHOT, extra: 1 }],
    ["an invalid health", { ...VALID_WATCH_SNAPSHOT, health: "sick" }],
    ["an invalid rootToken", { ...VALID_WATCH_SNAPSHOT, rootToken: "!!!" }],
    ["a non-boolean requiresSnapshot", { ...VALID_WATCH_SNAPSHOT, requiresSnapshot: "no" }],
    ["degradedReasons that are not an array", { ...VALID_WATCH_SNAPSHOT, degradedReasons: "none" }],
    ["a fractional queueDepth", { ...VALID_WATCH_SNAPSHOT, queueDepth: 1.5 }],
    [
      "a degradedReasons entry that is not recognized",
      { ...VALID_WATCH_SNAPSHOT, degradedReasons: ["nonsense"] },
    ],
  ])("rejects a watch snapshot when it has %s", (_label, input) => {
    expect(parseEditorM7WatchSnapshot(input)).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it("returns every entry retained when the pool is under both count and byte caps", () => {
    const entries: readonly EditorM7ModelEntry[] = [model("a", 1, 5, {}), model("b", 2, 5, {})];
    expect(
      planEditorM7ModelEviction({ entries, maximumCount: 5, maximumBytes: 100 }),
    ).toStrictEqual({ retained: ["a", "b"], evicted: [], protected: [] });
  });

  it("evicts nothing when every over-cap entry is dirty, pinned, active, or pending", () => {
    const entries: readonly EditorM7ModelEntry[] = [
      model("dirty", 1, 10, { dirty: true }),
      model("pinned", 2, 10, { pinned: true }),
      model("active", 3, 10, { active: true }),
      model("pending", 4, 10, { pendingOperation: true }),
    ];
    const plan = planEditorM7ModelEviction({ entries, maximumCount: 1, maximumBytes: 5 });
    expect(plan.evicted).toStrictEqual([]);
    expect(plan.retained).toStrictEqual(["dirty", "pinned", "active", "pending"]);
    expect(plan.protected).toStrictEqual(["dirty", "pinned", "active", "pending"]);
  });

  // KEIKO-0822: two entries sharing an `identity` used to make the second iteration's
  // `retained.findIndex(...)` return -1, and `splice(-1, 1)` then removed the LAST retained
  // entry — a possibly-protected entry that was never eligible to be evicted. Guard the splice
  // so a missing match is a no-op and the evicted list stays honest.
  it("does not remove a bystander when two entries share an identity (KEIKO-0822)", () => {
    const entries: readonly EditorM7ModelEntry[] = [
      model("dup", 1, 5, {}),
      model("dup", 2, 5, {}),
      model("safe", 3, 5, {}),
    ];
    const plan = planEditorM7ModelEviction({ entries, maximumCount: 1, maximumBytes: 5 });
    // `safe` must survive: no entry with that identity was ever eligible / evicted.
    expect(plan.retained).toContain("safe");
    for (const evictedIdentity of plan.evicted) {
      // Every identity claimed as evicted must have been in the original entries list.
      expect(entries.some((entry) => entry.identity === evictedIdentity)).toBe(true);
    }
    // No entry in `retained` should ever be an identity that was never in the input.
    for (const retainedIdentity of plan.retained) {
      expect(entries.some((entry) => entry.identity === retainedIdentity)).toBe(true);
    }
  });

  it.each<[string, unknown]>([
    ["not an array", "not-array"],
    ["longer than the max", Array.from({ length: 65 }, () => "1|view.splitRight|CtrlOrMeta+Alt+/")],
  ])("rejects a keybinding override collection that is %s", (_label, input) => {
    expect(parseEditorM7KeybindingOverrides(input)).toMatchObject({
      ok: false,
      reasonCode: "OVERSIZED",
    });
  });

  it("rejects a keybinding override array that contains a non-string entry", () => {
    expect(parseEditorM7KeybindingOverrides([42])).toMatchObject({
      ok: false,
      reasonCode: "INVALID_INPUT",
    });
  });

  it("rejects a single keybinding override record that exceeds the byte cap", () => {
    const oversizedRecord = `1|view.splitRight|${"a".repeat(200)}`;
    expect(parseEditorM7KeybindingOverrides([oversizedRecord])).toMatchObject({
      ok: false,
      reasonCode: "OVERSIZED",
    });
  });

  it.each<[string, string]>([
    ["not enough parts", "1|only-two"],
    ["too many parts", "1|view.splitRight|Alt+X|extra"],
  ])("rejects a keybinding override record with %s", (_label, record) => {
    expect(parseEditorM7KeybindingOverrides([record])).toMatchObject({
      ok: false,
      reasonCode: "SCHEMA_VERSION_UNSUPPORTED",
    });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["an unknown key", { ...validAiRecord(), extra: 1 }],
    ["the wrong schemaVersion", { ...validAiRecord(), schemaVersion: "2" }],
    ["a non-boolean productSupported", { ...validAiRecord(), productSupported: "yes" }],
    ["a non-boolean explicitOptIn", { ...validAiRecord(), explicitOptIn: 1 }],
    ["an invalid feature", { ...validAiRecord(), feature: "spellcheck" }],
    ["an invalid budget", { ...validAiRecord(), budget: "generous" }],
    ["an invalid legacyFlag", { ...validAiRecord(), legacyFlag: "spurious" }],
  ])("returns denied INVALID_INPUT for AI activation when input is %s", (_label, input) => {
    expect(resolveEditorM7AiActivation(input)).toMatchObject({
      state: "denied",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });

  it("returns disabled PRODUCT_UNSUPPORTED as the highest-priority AI activation rule", () => {
    expect(
      resolveEditorM7AiActivation(aiInput({ productSupported: false, explicitOptIn: false })),
    ).toMatchObject({
      state: "disabled",
      reasonCode: "PRODUCT_UNSUPPORTED",
      policyResult: "denied",
    });
  });

  it("fails closed instead of throwing for hostile Proxy input across every boundary parser", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error("boom");
        },
      },
    );
    expect(() => resolveEditorM7AiActivation(hostile)).not.toThrow();
    expect(resolveEditorM7AiActivation(hostile)).toMatchObject({
      state: "denied",
      reasonCode: "INVALID_INPUT",
    });
    expect(() =>
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "Alt+X",
        activeBindings: hostile,
      }),
    ).not.toThrow();
    expect(
      validateEditorM7Keybinding({
        commandId: "quick-access.files",
        binding: "Alt+X",
        activeBindings: hostile,
      }),
    ).toMatchObject({ ok: false, reasonCode: "INVALID_INPUT" });
  });

  it("separates an unverified provider from an unhealthy one, and denies both", () => {
    expect(resolveEditorM7AiActivation(aiInput({ providerHealth: "unverified" }))).toMatchObject({
      state: "degraded",
      reasonCode: "PROVIDER_UNVERIFIED",
      policyResult: "denied",
    });
    expect(resolveEditorM7AiActivation(aiInput({ providerHealth: "degraded" }))).toMatchObject({
      state: "degraded",
      reasonCode: "PROVIDER_UNHEALTHY",
      policyResult: "denied",
    });
    expect(
      resolveEditorM7AiActivation({ ...aiInput(), providerHealth: "probably-fine" }),
    ).toMatchObject({
      state: "denied",
      reasonCode: "INVALID_INPUT",
      policyResult: "denied",
    });
  });

  it("rejects an unknown setting id in parseEditorM7SettingValue instead of throwing", () => {
    expect(() =>
      parseEditorM7SettingValue("hostileUnknownId" as EditorM7SettingId, "x"),
    ).not.toThrow();
    expect(parseEditorM7SettingValue("hostileUnknownId" as EditorM7SettingId, "x")).toMatchObject({
      ok: false,
      reasonCode: "UNKNOWN_SETTING",
    });
  });
});
