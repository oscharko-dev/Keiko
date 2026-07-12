import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
  type EditorM7SettingsSnapshot,
  type EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";

import { resetSharedEventSourcesForTests } from "./widgets/cards/sharedEventSource";
import {
  subscribeEditorShortcutOverrides,
  useEditorShortcutOverrides,
} from "./useEditorShortcutOverrides";

const api = vi.hoisted(() => ({
  fetchEditorSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchEditorSettings: api.fetchEditorSettings,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<EventListener>>();

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

  emit(type: string): void {
    const event = new MessageEvent<string>(type, { data: "{}" });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function snapshot(value: EditorM7SettingValue): EditorM7SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 0,
    revision: 1,
    etag: '"edm7-1-0-test"',
    root: "/repo",
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({
      user: { scope: "user", values: { keybindingOverrides: value } },
    }),
    eventSequence: 1,
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  api.fetchEditorSettings.mockReset();
});

afterEach(() => {
  resetSharedEventSourcesForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useEditorShortcutOverrides", () => {
  it("loads overrides and refreshes them from the shared settings stream", async () => {
    const first = "1|quick-access.files|CtrlOrMeta+Shift+O";
    const second = "1|open-settings|CtrlOrMeta+,";
    api.fetchEditorSettings
      .mockResolvedValueOnce(snapshot([first]))
      .mockResolvedValueOnce(snapshot([second]));
    const { result, unmount } = renderHook(() => useEditorShortcutOverrides("/repo"));

    await waitFor(() => {
      expect(result.current).toEqual([first]);
    });
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      "/api/editor/settings/events?root=%2Frepo",
    ]);

    act(() => {
      FakeEventSource.instances[0]?.emit("editor-settings:changed");
    });
    await waitFor(() => {
      expect(result.current).toEqual([second]);
    });

    unmount();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("falls back to empty overrides after load errors and supports rootless subscriptions", async () => {
    const changes: (readonly string[])[] = [];
    api.fetchEditorSettings.mockRejectedValueOnce(new Error("offline"));
    const unsubscribe = subscribeEditorShortcutOverrides(undefined, (next) => {
      changes.push(next);
    });

    await waitFor(() => {
      expect(changes).toEqual([[]]);
    });
    expect(FakeEventSource.instances[0]?.url).toBe("/api/editor/settings/events");

    unsubscribe();
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
  });
});
