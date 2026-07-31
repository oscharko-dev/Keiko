// The recovery path the shell boundary offers. The offending record can sit in the user layer or the
// workspace layer and this function never learns which, so it must clear EVERY writable layer and
// REJECT if any layer refused — the boundary reloads on a resolved promise, and a surviving override
// would reload straight back into the same blank page while reporting success.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorM11SettingsSnapshot } from "@oscharko-dev/keiko-contracts";
import { resetPersistedShortcutOverrides } from "./shellRecovery";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

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
    resetClientDiagnosticWriter();
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

  // Qodo review on #2869. This case previously asserted that a one-layer reset RESOLVES, which
  // contradicted this module's own header: the offending record can sit in either layer, this
  // function never learns which, and "clearing only one leaves the desktop exactly as broken". The
  // boundary reloads the moment the promise resolves, so partial success reloaded straight back into
  // the crash while telling the user recovery had worked. No ADR sanctioned that reading; it was a
  // wrong expectation, not a pin, and the assertion is inverted here rather than removed — a
  // strengthening (resolves -> rejects), never a relaxation.
  it("rejects when one layer refuses, because the surviving override still crashes the shell", async () => {
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

    await expect(resetPersistedShortcutOverrides()).rejects.toThrow(/refused by 1 setting layer/u);
  });

  // The refusal must not reach the user as raw vendor text: the recovery surface is what a user
  // screenshots into a bug report, so only the error CLASS is reported onward.
  it("reports a refusing layer as a redacted diagnostic, never the underlying message", async () => {
    const written: string[] = [];
    setClientDiagnosticWriter((message) => written.push(message));
    fetchEditorSettings.mockResolvedValue(snapshot());
    mutateEditorSettings.mockRejectedValue(new Error("https://internal.example/settings denied"));

    await expect(resetPersistedShortcutOverrides()).rejects.toThrow();

    expect(written.length).toBeGreaterThan(0);
    for (const message of written) {
      expect(message).not.toContain("internal.example");
      expect(message).not.toContain("denied");
    }
    expect(written[0]).toContain("Error");
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
