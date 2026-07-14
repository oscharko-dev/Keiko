import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  type DebugActivationSummary,
  type EditorM7SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { useDebuggingSettings } from "./useDebuggingSettings";

const editorView = vi.hoisted(() => ({ current: undefined as unknown as EditorSettingsView }));

vi.mock("../cards/useEditorSettings", () => ({
  useEditorSettings: (): EditorSettingsView => editorView.current,
  settingById: (snapshot: EditorM7SettingsSnapshot | undefined) =>
    snapshot?.settings.find((setting) => setting.id === "debuggingEnabled"),
}));

function summary(
  state: DebugActivationSummary["state"],
  reasonCode: DebugActivationSummary["reasonCode"],
): DebugActivationSummary {
  return {
    ok: true,
    schemaVersion: "1",
    adapterId: "node-typescript",
    revision: 2,
    state,
    reasonCode,
    policyResult: state === "disabledByPolicy" ? "denied" : "allowed",
  };
}

function editorSnapshot(
  debugging: DebugActivationSummary | undefined,
  enabled: boolean,
): EditorM7SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: 1,
    revision: 1,
    etag: '"edm7-test"',
    root: "/workspace",
    definitions: [],
    settings: [
      {
        id: "debuggingEnabled",
        value: enabled,
        source: "workspace",
        scope: "workspace",
        policyLocked: false,
        effect: "live",
      },
    ],
    eventSequence: 1,
    ...(debugging === undefined ? {} : { debugging }),
  };
}

function view(snapshot: EditorM7SettingsSnapshot | undefined): EditorSettingsView {
  return {
    snapshot,
    applied: {
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      renderWhitespace: "selection",
      minimap: false,
      formatOnSave: false,
      externalReload: "prompt",
      largeFileMode: "default",
      keybindingOverrides: [],
      modelRetentionCount: 32,
      modelRetentionBytes: 64 * 1024 * 1024,
    },
    loading: false,
    mutating: false,
    issue: undefined,
    announcement: "",
    refresh: vi.fn(),
    setValue: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  };
}

describe("useDebuggingSettings", () => {
  beforeEach(() => {
    editorView.current = view(
      editorSnapshot(summary("disabled", "WORKSPACE_ACTIVATION_UNSET"), false),
    );
  });

  it("permits only an explicit workspace opt-in when the server says activation is available", async () => {
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canEnable).toBe(true);
    await result.current.setEnabled(true);

    expect(editorView.current.setValue).toHaveBeenCalledWith("workspace", "debuggingEnabled", true);
  });

  it("fails closed when the server omits the trusted activation summary", async () => {
    editorView.current = view(editorSnapshot(undefined, false));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.canEnable).toBe(false);
    await result.current.setEnabled(true);

    expect(editorView.current.setValue).not.toHaveBeenCalled();
  });

  it("allows a local human to revoke an existing opt-in even after policy narrows", async () => {
    editorView.current = view(editorSnapshot(summary("disabledByPolicy", "POLICY_DENIED"), true));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.canDisable).toBe(true);
    await result.current.setEnabled(false);

    expect(editorView.current.setValue).toHaveBeenCalledWith(
      "workspace",
      "debuggingEnabled",
      false,
    );
  });
});
