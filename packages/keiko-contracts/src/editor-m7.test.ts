import { describe, expect, it } from "vitest";

import {
  EDITOR_M7_COMMAND_REGISTRY,
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  defaultEditorM7Settings,
  parseEditorM7SettingPatch,
  parseEditorM7SettingsEvent,
  parseEditorM7SettingsRecord,
  parseEditorM7KeybindingOverrides,
  parseEditorM7SnippetCollection,
  parseEditorM7WatchEvent,
  parseEditorM7WatchSnapshot,
  planEditorM7ModelEviction,
  resolveEditorM7AiActivation,
  resolveEditorM7Settings,
  serializeEditorM7KeybindingOverride,
  validateEditorM7Keybinding,
  type EditorM7AiActivationInput,
  type EditorM7ModelEntry,
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
    expect(EDITOR_M7_SETTING_REGISTRY.every((entry) => entry.description.length > 0)).toBe(true);
    expect(EDITOR_M7_SETTING_REGISTRY.every((entry) => entry.scopes.length > 0)).toBe(true);
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
  it("keeps a closed command registry and rejects reserved, malformed, unknown, and colliding bindings", () => {
    expect(EDITOR_M7_COMMAND_REGISTRY.map((entry) => entry.id)).toContain("editor.save");
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

  it("allows explicit context-disjoint reuse and normalizes persisted override records", () => {
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
    ).toStrictEqual({ ok: true, value: "Shift+Alt+X" });
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

  it("accepts safe TextMate snippets and rejects transforms, clipboard, execution, and unsafe globs", () => {
    expect(
      parseEditorM7SnippetCollection({
        schemaVersion: "1",
        snippets: [
          {
            name: "test",
            language: "typescript",
            body: ['describe("${1:name}", () => {', "  $0", "});"],
            pathGlob: "src/**/*.ts",
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    for (const body of [["${TM_FILENAME/(.*)/$1/}"], ["$CLIPBOARD"], ["$(rm -rf .)"], ["`id`"]]) {
      expect(
        parseEditorM7SnippetCollection({
          schemaVersion: "1",
          snippets: [{ name: "bad", language: "typescript", body }],
        }),
      ).toMatchObject({ ok: false, reasonCode: "UNSAFE_SNIPPET" });
    }
    expect(
      parseEditorM7SnippetCollection({
        schemaVersion: "1",
        snippets: [{ name: "bad", language: "typescript", body: ["ok"], pathGlob: "../x" }],
      }),
    ).toMatchObject({ ok: false, reasonCode: "UNSAFE_PATH" });
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
