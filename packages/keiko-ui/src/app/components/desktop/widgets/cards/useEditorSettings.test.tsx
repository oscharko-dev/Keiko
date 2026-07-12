import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
  type EditorM7SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { useEditorSettings } from "./useEditorSettings";

const api = vi.hoisted(() => ({
  currentSnapshot: undefined as EditorM7SettingsSnapshot | undefined,
  fetchEditorSettings: vi.fn(),
  mutateEditorSettings: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("../../../../../lib/api", () => {
  return {
    ApiError: api.ApiError,
    fetchEditorSettings: api.fetchEditorSettings,
    mutateEditorSettings: api.mutateEditorSettings,
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent<string>(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function snapshot(revision: number, fontSize: number): EditorM7SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: revision,
    revision,
    etag: `"edm7-0-${revision.toString()}-test"`,
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({
      workspace: { scope: "workspace", values: { fontSize } },
    }),
    eventSequence: revision,
  };
}

function settingsEvent(sequence: number, settingIds = ["fontSize"]): Record<string, unknown> {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence,
    kind: "changed",
    revision: sequence,
    userRevision: 0,
    workspaceRevision: sequence,
    scope: "workspace",
    settingIds,
    storeState: "ready",
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  api.currentSnapshot = snapshot(0, 13);
  api.fetchEditorSettings.mockImplementation(() => Promise.resolve(api.currentSnapshot));
  api.mutateEditorSettings.mockReset();
});

afterEach(() => {
  resetSharedEventSourcesForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useEditorSettings M7 cross-window integration", () => {
  it("shares one settings stream and refreshes each window exactly once per change event", async () => {
    const first = renderHook(() => useEditorSettings("/repo"));
    const second = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => {
      expect(first.result.current.snapshot?.revision).toBe(0);
      expect(second.result.current.snapshot?.revision).toBe(0);
    });
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/settings/events?root=%2Frepo",
    ]);
    expect(api.fetchEditorSettings).toHaveBeenCalledTimes(2);

    api.currentSnapshot = snapshot(1, 18);
    act(() => {
      FakeEventSource.instances[0]?.emit("editor-settings:changed", settingsEvent(1));
    });

    await waitFor(() => {
      expect(first.result.current.applied.fontSize).toBe(18);
      expect(second.result.current.applied.fontSize).toBe(18);
    });
    expect(api.fetchEditorSettings).toHaveBeenCalledTimes(4);

    first.unmount();
    second.unmount();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("surfaces stale concurrent mutations as conflicts without overwriting the current snapshot", async () => {
    api.currentSnapshot = snapshot(0, 13);
    api.mutateEditorSettings.mockRejectedValue(new Error("unhandled"));
    api.mutateEditorSettings.mockRejectedValueOnce(
      new api.ApiError("STALE_REVISION", "stale revision", 409),
    );
    const { result } = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => {
      expect(result.current.snapshot?.revision).toBe(0);
    });
    await act(async () => {
      await result.current.setValue("workspace", "fontSize", 19);
    });

    expect(result.current.issue).toBe("conflict");
    expect(result.current.applied.fontSize).toBe(13);
    expect(api.mutateEditorSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        values: { fontSize: 19 },
      }),
      '"edm7-0-0-test"',
      expect.any(String),
      expect.any(AbortSignal),
    );
  });
});
