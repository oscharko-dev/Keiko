import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DebugActivationSummary,
  EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { ApiError } from "@/lib/api";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { useDebuggingSettings } from "./useDebuggingSettings";

const editorView = vi.hoisted(() => ({ current: undefined as unknown as EditorSettingsView }));
const mutateDebugActivationMock = vi.hoisted(() => vi.fn());

vi.mock("../cards/useEditorSettings", () => ({
  useEditorSettings: (): EditorSettingsView => editorView.current,
  settingById: (snapshot: EditorM11SettingsSnapshot | undefined) =>
    snapshot?.settings.find((setting) => setting.id === "debuggingEnabled"),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    mutateDebugActivation: (...args: readonly unknown[]): Promise<unknown> =>
      mutateDebugActivationMock(...args),
  };
});

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
): EditorM11SettingsSnapshot {
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
        layers: { workspace: enabled },
        policyLocked: false,
        effect: "live",
      },
    ],
    eventSequence: 1,
    ...(debugging === undefined ? {} : { debugging }),
  };
}

function view(snapshot: EditorM11SettingsSnapshot | undefined): EditorSettingsView {
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
    refresh: vi.fn().mockResolvedValue(undefined),
    setValue: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    createProfile: vi.fn(),
    renameProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    switchProfile: vi.fn(),
    resetProfile: vi.fn(),
  };
}

describe("useDebuggingSettings", () => {
  beforeEach(() => {
    mutateDebugActivationMock.mockReset();
    mutateDebugActivationMock.mockResolvedValue({
      kind: "ok",
      changed: true,
      revision: 2,
      etag: '"edm7-test-2"',
      snapshot: editorSnapshot(summary("available", "AVAILABLE"), true),
    });
    editorView.current = view(
      editorSnapshot(summary("disabled", "WORKSPACE_ACTIVATION_UNSET"), false),
    );
  });

  it("permits only an explicit workspace opt-in when the server says activation is available", async () => {
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.enabled).toBe(false);
    expect(result.current.canEnable).toBe(true);
    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(mutateDebugActivationMock).toHaveBeenCalledWith(
      "activate",
      { root: "/workspace", expectedRevision: 1 },
      '"edm7-test"',
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(editorView.current.setValue).not.toHaveBeenCalled();
    expect(editorView.current.refresh).toHaveBeenCalled();
  });

  it("fails closed when the server omits the trusted activation summary", async () => {
    editorView.current = view(editorSnapshot(undefined, false));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.canEnable).toBe(false);
    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(mutateDebugActivationMock).not.toHaveBeenCalled();
  });

  it("allows a local human to revoke an existing opt-in even after policy narrows", async () => {
    editorView.current = view(editorSnapshot(summary("disabledByPolicy", "POLICY_DENIED"), true));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    expect(result.current.canDisable).toBe(true);
    await act(async () => {
      await result.current.setEnabled(false);
    });

    expect(mutateDebugActivationMock).toHaveBeenCalledWith(
      "deactivate",
      { root: "/workspace", expectedRevision: 1 },
      '"edm7-test"',
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(editorView.current.setValue).not.toHaveBeenCalled();
  });

  it("surfaces a conflict issue when the server reports a stale revision", async () => {
    mutateDebugActivationMock.mockRejectedValue(new ApiError("STALE_REVISION", "stale", 409));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(result.current.issue).toBe("conflict");
    expect(result.current.mutating).toBe(false);
    expect(editorView.current.refresh).not.toHaveBeenCalled();
  });

  it("surfaces a mutation issue for any other activation failure", async () => {
    mutateDebugActivationMock.mockRejectedValue(new ApiError("STATE_UNAVAILABLE", "down", 503));
    const { result } = renderHook(() => useDebuggingSettings("/workspace"));

    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(result.current.issue).toBe("mutation");
    expect(result.current.mutating).toBe(false);
  });
});
