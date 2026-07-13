import { describe, expect, it } from "vitest";

import {
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
  type EditorM7ModelEntry,
  type EditorM7SettingId,
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
