"use client";

// In-product recovery for the one persisted setting that can keep the desktop from rendering at
// all: `keybindingOverrides`. A shell that fails in render has no settings panel to fix it from, so
// the shell error boundary needs a path that does not depend on the shell being alive. Reset is
// applied to every writable layer — the offending record can sit in the user layer or in the
// workspace layer of the launched root, and clearing only one leaves the desktop exactly as broken.

import {
  EDITOR_M7_SCHEMA_VERSION,
  type EditorM11SettingScope,
  type EditorM11SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";

const RESET_SCOPES: readonly EditorM11SettingScope[] = ["user", "workspace"];

type MutateEditorSettings = (typeof import("@/lib/api"))["mutateEditorSettings"];

function expectedRevisionFor(
  snapshot: EditorM11SettingsSnapshot,
  scope: EditorM11SettingScope,
): number {
  if (scope === "workspace") return snapshot.workspaceRevision;
  if (scope === "root") return snapshot.rootRevision ?? 0;
  return snapshot.userRevision;
}

// A layer that refuses the reset is not swallowed: it yields null, and resetPersistedShortcutOverrides
// rejects with the refused-layer count when no layer accepted, so the boundary reports the failure
// instead of offering a reload into the same broken state.
async function clearOverridesInScope(
  mutate: MutateEditorSettings,
  snapshot: EditorM11SettingsSnapshot,
  scope: EditorM11SettingScope,
): Promise<EditorM11SettingsSnapshot | null> {
  try {
    const result = await mutate(
      {
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        scope,
        action: "reset",
        expectedRevision: expectedRevisionFor(snapshot, scope),
        settingIds: ["keybindingOverrides"],
      },
      snapshot.etag,
      crypto.randomUUID(),
    );
    return result.kind === "ok" ? result.snapshot : null;
  } catch {
    return null;
  }
}

/**
 * Clear every persisted keybinding override. Resolves only once a layer has accepted the reset, and
 * rejects otherwise, so the caller can tell the user the recovery did not work.
 */
export async function resetPersistedShortcutOverrides(): Promise<void> {
  const { fetchEditorSettings, mutateEditorSettings } = await import("@/lib/api");
  let snapshot = await fetchEditorSettings(undefined);
  let refused = 0;
  let cleared = false;
  for (const scope of RESET_SCOPES) {
    const next = await clearOverridesInScope(mutateEditorSettings, snapshot, scope);
    if (next === null) {
      refused += 1;
      continue;
    }
    snapshot = next;
    cleared = true;
  }
  if (!cleared) {
    throw new Error(
      `Keyboard shortcut override reset refused by ${String(refused)} setting layers.`,
    );
  }
}
