import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_DEFAULT_PROFILE_REF,
  resolveEditorM7Settings,
  resolveEditorM11Settings,
  type EditorM11ProfileSettingsLayer,
  type EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { resetSharedEventSourcesForTests } from "./sharedEventSource";
import { useEditorSettings } from "./useEditorSettings";

const api = vi.hoisted(() => ({
  currentSnapshot: undefined as EditorM11SettingsSnapshot | undefined,
  fetchEditorSettings: vi.fn(),
  mutateEditorSettings: vi.fn(),
  mutateEditorProfile: vi.fn(),
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
    mutateEditorProfile: api.mutateEditorProfile,
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

function snapshot(revision: number, fontSize: number): EditorM11SettingsSnapshot {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 0,
    workspaceRevision: revision,
    rootRevision: 0,
    revision,
    etag: `"edm7-0-${revision.toString()}-0-test"`,
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

function withFocusProfile(
  base: EditorM11SettingsSnapshot,
  active = true,
): EditorM11SettingsSnapshot {
  const profileRef = "profile-focus" as EditorM11ProfileSettingsLayer["profileRef"];
  const profile: EditorM11ProfileSettingsLayer = {
    kind: "editor-profile-settings",
    schemaVersion: 1,
    profileRef,
    revision: 1,
    values: { fontSize: 18 },
  };
  return {
    ...base,
    settings: active ? resolveEditorM11Settings({ profile }) : base.settings,
    profiles: {
      schemaVersion: 1,
      storeState: "ready",
      revision: 2,
      etag: '"edp-2"',
      activeProfileRef: active ? profileRef : EDITOR_M11_DEFAULT_PROFILE_REF,
      profiles: [
        {
          profileRef: EDITOR_M11_DEFAULT_PROFILE_REF,
          displayName: "Default",
          revision: 0,
          settingCount: 0,
          builtIn: true,
        },
        { profileRef, displayName: "Focus", revision: 1, settingCount: 1, builtIn: false },
      ],
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  api.currentSnapshot = snapshot(0, 13);
  api.fetchEditorSettings.mockImplementation(() => Promise.resolve(api.currentSnapshot));
  api.mutateEditorSettings.mockReset();
  api.mutateEditorProfile.mockReset();
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
      '"edm7-0-0-0-test"',
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("uses the root revision for root-scoped mutations", async () => {
    api.currentSnapshot = {
      ...snapshot(0, 13),
      rootRevision: 3,
      etag: '"edm7-0-0-3-test"',
    };
    api.mutateEditorSettings.mockRejectedValue(new Error("sentinel"));
    const { result } = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => {
      expect(result.current.snapshot?.rootRevision).toBe(3);
    });
    await act(async () => {
      await result.current.setValue("root", "fontSize", 17);
    });

    expect(api.mutateEditorSettings).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "root", expectedRevision: 3 }),
      '"edm7-0-0-3-test"',
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("resolves effective modelRetentionCount/modelRetentionBytes from the snapshot", async () => {
    api.currentSnapshot = {
      ...snapshot(0, 13),
      settings: resolveEditorM7Settings({
        workspace: {
          scope: "workspace",
          values: { modelRetentionCount: 5, modelRetentionBytes: 8 * 1024 * 1024 },
        },
      }),
    };
    const { result } = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => {
      expect(result.current.applied.modelRetentionCount).toBe(5);
      expect(result.current.applied.modelRetentionBytes).toBe(8 * 1024 * 1024);
    });
  });

  it("writes active-profile settings through the profile etag", async () => {
    api.currentSnapshot = withFocusProfile(snapshot(0, 13));
    api.mutateEditorProfile.mockRejectedValue(new Error("sentinel"));
    const { result } = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => expect(result.current.snapshot?.profiles?.revision).toBe(2));
    await act(async () => {
      await result.current.setValue("profile", "fontSize", 19);
    });

    expect(api.mutateEditorProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set",
        expectedRevision: 2,
        profileRef: "profile-focus",
        values: { fontSize: 19 },
      }),
      '"edp-2"',
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it("installs a switched profile snapshot without reloading the page", async () => {
    const inactive = withFocusProfile(snapshot(0, 13), false);
    const active = withFocusProfile(snapshot(0, 13));
    api.currentSnapshot = inactive;
    api.mutateEditorProfile.mockResolvedValue({
      kind: "ok",
      changed: true,
      profileRef: "profile-focus",
      revision: 2,
      etag: '"edp-2"',
      profiles: active.profiles,
      settings: active,
    });
    const { result } = renderHook(() => useEditorSettings("/repo"));

    await waitFor(() => expect(result.current.applied.fontSize).toBe(13));
    await act(async () => {
      await result.current.switchProfile(
        "profile-focus" as EditorM11ProfileSettingsLayer["profileRef"],
      );
    });

    expect(result.current.applied.fontSize).toBe(18);
    expect(result.current.snapshot?.profiles?.activeProfileRef).toBe("profile-focus");
    expect(api.fetchEditorSettings).toHaveBeenCalledTimes(1);
  });
});
