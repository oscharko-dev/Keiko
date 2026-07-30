// The recovery path the shell boundary offers. It must clear the override in whichever layer holds
// it (user OR workspace), and it must REJECT when no layer accepted, so the boundary reports the
// failure instead of reloading into the same blank page.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorM11SettingsSnapshot } from "@oscharko-dev/keiko-contracts";
import { resetPersistedShortcutOverrides } from "./shellRecovery";

const fetchEditorSettings = vi.fn();
const mutateEditorSettings = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchEditorSettings: (...args: readonly unknown[]): unknown => fetchEditorSettings(...args),
  mutateEditorSettings: (...args: readonly unknown[]): unknown => mutateEditorSettings(...args),
}));

function snapshot(patch: Partial<EditorM11SettingsSnapshot> = {}): EditorM11SettingsSnapshot {
  return {
    schemaVersion: "1",
    storeState: "ready",
    userRevision: 4,
    workspaceRevision: 7,
    revision: 7,
    etag: "etag-1",
    definitions: [],
    settings: [],
    eventSequence: 1,
    ...patch,
  } as EditorM11SettingsSnapshot;
}

describe("resetPersistedShortcutOverrides", () => {
  beforeEach(() => {
    fetchEditorSettings.mockReset();
    mutateEditorSettings.mockReset();
  });

  it("clears the override in every writable layer at that layer's own revision", async () => {
    fetchEditorSettings.mockResolvedValue(snapshot());
    mutateEditorSettings.mockResolvedValue({
      kind: "ok",
      changed: true,
      revision: 8,
      etag: "etag-2",
      snapshot: snapshot({ etag: "etag-2", userRevision: 5, workspaceRevision: 8 }),
    });

    await resetPersistedShortcutOverrides();

    expect(mutateEditorSettings).toHaveBeenCalledTimes(2);
    expect(mutateEditorSettings.mock.calls[0]?.[0]).toMatchObject({
      scope: "user",
      action: "reset",
      expectedRevision: 4,
      settingIds: ["keybindingOverrides"],
    });
    expect(mutateEditorSettings.mock.calls[1]?.[0]).toMatchObject({
      scope: "workspace",
      expectedRevision: 8,
    });
    expect(mutateEditorSettings.mock.calls[1]?.[1]).toBe("etag-2");
  });

  it("still succeeds when only one layer accepts the reset", async () => {
    fetchEditorSettings.mockResolvedValue(snapshot());
    mutateEditorSettings
      .mockResolvedValueOnce({
        kind: "ok",
        changed: true,
        revision: 5,
        etag: "etag-2",
        snapshot: snapshot({ etag: "etag-2" }),
      })
      .mockRejectedValueOnce(new Error("workspace layer unavailable"));

    await expect(resetPersistedShortcutOverrides()).resolves.toBeUndefined();
  });

  it("rejects when no layer accepted the reset", async () => {
    fetchEditorSettings.mockResolvedValue(snapshot());
    mutateEditorSettings.mockResolvedValue({
      kind: "conflict",
      code: "STALE_REVISION",
      etag: "etag-9",
    });

    await expect(resetPersistedShortcutOverrides()).rejects.toThrow(/refused by 2 setting layers/u);
  });

  it("rejects when the settings snapshot cannot be read", async () => {
    fetchEditorSettings.mockRejectedValue(new Error("settings unavailable"));

    await expect(resetPersistedShortcutOverrides()).rejects.toThrow(/settings unavailable/u);
    expect(mutateEditorSettings).not.toHaveBeenCalled();
  });
});
