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
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

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

// A layer that refuses the reset yields null rather than throwing, so the caller can attempt every
// remaining layer before deciding. The refusal is NOT swallowed silently: its error class reaches the
// client diagnostic sink, and the caller rejects. Only the class is reported — a settings error can
// carry an endpoint or a server message Keiko does not control, and the recovery surface is what a
// user screenshots into a bug report.
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
    if (result.kind === "ok") return result.snapshot;
    reportClientDiagnostic(`shell-recovery: ${scope} layer refused the reset (${result.kind})`);
    return null;
  } catch (error) {
    reportClientDiagnostic(
      `shell-recovery: ${scope} layer reset failed (${clientErrorSummary(error)})`,
      { correlationId: correlationIdOf(error) },
    );
    return null;
  }
}

/**
 * Clear the persisted keybinding override in EVERY writable layer.
 *
 * Rejects unless every layer accepted. That is deliberately stricter than "at least one accepted":
 * the offending record can sit in the user layer or in the workspace layer, this function never
 * learns which, and the boundary reloads the moment this promise resolves. Resolving after a partial
 * reset therefore reloads straight back into the same render crash while telling the user recovery
 * worked — the header note above ("clearing only one leaves the desktop exactly as broken") is the
 * invariant, and failing closed is the only way to honour it (Qodo review on #2869).
 */
export async function resetPersistedShortcutOverrides(): Promise<void> {
  const { fetchEditorSettings, mutateEditorSettings } = await import("@/lib/api");
  let snapshot = await fetchEditorSettings();
  let refused = 0;
  for (const scope of RESET_SCOPES) {
    const next = await clearOverridesInScope(mutateEditorSettings, snapshot, scope);
    if (next === null) {
      refused += 1;
      continue;
    }
    snapshot = next;
  }
  if (refused > 0) {
    const layers = refused === 1 ? "setting layer" : "setting layers";
    throw new Error(`Keyboard shortcut override reset refused by ${String(refused)} ${layers}.`);
  }
}
