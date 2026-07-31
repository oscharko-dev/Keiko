"use client";

// The shell's global keyboard shortcuts resolve through the SAME parser the settings layer uses
// (keyboardShortcutsRegistry → parseEditorM7KeybindingOverrides in @oscharko-dev/keiko-contracts).
// It used to carry its own weaker copy in `globalKeyboardShortcuts.ts`, which re-declared the six
// global commands and validated only the record shape plus the binding→chord mapping — never the
// reserved-chord or collision rules. `useKeyboardShortcuts` fails closed by THROWING on either, in
// render, above no boundary: one hand-edited or imported `keybindingOverrides` line white-screened
// the whole desktop on every load. Persisted overrides are hostile input (AGENTS.md §7), so a
// rejected entry is IGNORED here and the command keeps its default binding — never thrown at render.
//
// Audit — the quick-access palette's chord hints came from a label map built over the SIX global
// commands only, so every editor command (`view.splitRight`, `tab.next`, `files.saveAll`, …) fell
// back to the hardcoded display string in `editorCommands.ts`: rebinding one in Settings never
// reached the palette, which kept advertising a chord that no longer did anything. Labels now cover
// every command something actually dispatches, so a rebind shows up everywhere at once.
//
// A label is always derived from the binding that REALLY fires, never from the binding the settings
// file asked for: for Keiko's own listeners that is the dispatch-safe projection (a refused override
// falls back to its default, and the palette must show that same default), and for Monaco-owned
// commands it is the effective binding Monaco itself receives.
//
// An UNBOUND command, and a BOUND command nothing dispatches, both contribute no entry at all.
// `shortcutLabel(null, …)` renders the "Unbound" wording the settings table wants, which is not a
// chord hint — leaving the entry out lets the palette row fall through to no chip instead of
// advertising a word as a keystroke. Keiko listens in the "global" context (AppShell →
// useKeyboardShortcuts) and the "editor" context (EditorWidget's capturing listener); no listener
// claims the "settings" context, so `open-editor-settings` (`CtrlOrMeta+,`) stays out until one
// exists. Advertising a chord nobody dispatches is the same defect one command later.

import {
  EDITOR_M7_COMMAND_REGISTRY,
  type EditorM7CommandContext,
  type EditorM7ReasonCode,
  type WorkspaceKeyboardShortcutBinding,
} from "@oscharko-dev/keiko-contracts";
import {
  detectKeyboardShortcutPlatform,
  dispatchableWorkspaceShortcutsForContext,
  projectDispatchableWorkspaceShortcuts,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
  type DispatchableShortcutRefusal,
  type EffectiveKeyboardShortcutRegistry,
} from "./keyboardShortcutsRegistry";
import { subscribeEditorShortcutOverrides } from "./useEditorShortcutOverrides";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

export type ShellShortcutState = {
  readonly labels: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
};

const KEIKO_DISPATCHED_CONTEXTS: readonly EditorM7CommandContext[] = ["global", "editor"];

// The binding each command is labelled from, keyed by command id. Monaco first, then Keiko's own
// contexts, so a command listed in both is labelled from the projection that refuses hostile input.
function labelledBindings(
  registry: EffectiveKeyboardShortcutRegistry,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  for (const entry of registry.commands) {
    if (entry.command.dispatchOwner === "monaco" && entry.binding !== null) {
      bindings.set(entry.command.id, entry.binding);
    }
  }
  for (const context of KEIKO_DISPATCHED_CONTEXTS) {
    for (const entry of dispatchableWorkspaceShortcutsForContext(registry, context)) {
      bindings.set(entry.commandId, entry.binding);
    }
  }
  return bindings;
}

export function resolveShellShortcutState(overrides: readonly string[]): ShellShortcutState {
  const registry = resolveEffectiveKeyboardShortcuts(overrides);
  const platform = detectKeyboardShortcutPlatform();
  const projection = projectDispatchableWorkspaceShortcuts(registry, "global");
  const settingRefusalReasonCode =
    registry.status.kind === "fallback" ? (registry.status.reasonCode ?? "INVALID_INPUT") : null;
  surfaceShellShortcutRefusals(projection.refusals, settingRefusalReasonCode);
  return {
    labels: new Map(
      [...labelledBindings(registry)].map(([commandId, binding]) => [
        commandId,
        shortcutLabel(binding, platform),
      ]),
    ),
    bindings: projection.shortcuts.map((entry) => ({
      commandId: entry.commandId,
      chord: entry.chord,
    })),
  };
}

// ─── Refusal diagnostic (ADR-0028 §4 amendment; AGENTS.md §7 "no silent failures") ────────────
//
// The projection drops hostile persisted input on purpose, but a drop the operator never sees is a
// silent failure: a rebind simply "does nothing" and nothing says why. This is the same bounded
// surface `useWorkspace` already uses for a failed workspace sync — a module-local surfaced flag, a
// process-local counter, and an exported read/reset for tests — deliberately reusing that idiom
// instead of growing a second logging path (AGENTS.md §5).
//
// `resolveShellShortcutState` runs on every shell mount AND every settings change, so the emission
// is keyed on the refusal SIGNATURE: the same refused table warns once per session and re-arms only
// when the signature changes or clears.
//
// REDACTION: the message carries closed-registry command ids and closed reason codes and nothing
// else. A keybinding is user-authored data — the rejected record, its raw binding text, a scope path
// and any command id outside the registry never appear; an id that is not in the closed registry is
// reported only as a count.
let shellShortcutRefusalCount = 0;
let shellShortcutRefusalSignature: string | null = null;

export function readShellShortcutRefusalCount(): number {
  return shellShortcutRefusalCount;
}

// Reset the refusal surface (tests only).
export function resetShellShortcutRefusalSurface(): void {
  shellShortcutRefusalCount = 0;
  shellShortcutRefusalSignature = null;
}

function isRegistryCommandId(commandId: string): boolean {
  return EDITOR_M7_COMMAND_REGISTRY.some((command) => command.id === commandId);
}

export function shellShortcutRefusalDiagnostic(
  refusals: readonly DispatchableShortcutRefusal[],
  settingRefusalReasonCode: EditorM7ReasonCode | null,
): string | null {
  if (refusals.length === 0 && settingRefusalReasonCode === null) return null;
  const named = refusals.filter((refusal) => isRegistryCommandId(refusal.commandId));
  const parts = named
    .map((refusal) => `${refusal.commandId}=${refusal.reasonCode}`)
    .sort((left, right) => left.localeCompare(right));
  if (named.length < refusals.length) {
    parts.push(`unknown-commands=${String(refusals.length - named.length)}`);
  }
  if (settingRefusalReasonCode !== null) parts.push(`setting=${settingRefusalReasonCode}`);
  return `shell-shortcuts: refused persisted keybinding overrides (${parts.join(", ")}); affected commands keep their default binding`; // i18n-exempt: console-only operator diagnostic, never rendered to the end user
}

function surfaceShellShortcutRefusals(
  refusals: readonly DispatchableShortcutRefusal[],
  settingRefusalReasonCode: EditorM7ReasonCode | null,
): void {
  const message = shellShortcutRefusalDiagnostic(refusals, settingRefusalReasonCode);
  if (message === null) {
    shellShortcutRefusalSignature = null;
    return;
  }
  shellShortcutRefusalCount += 1;
  if (shellShortcutRefusalSignature === message) return;
  shellShortcutRefusalSignature = message;
  reportClientDiagnostic(message);
}

export function subscribeShellShortcutState(
  root: string | undefined,
  onChange: (state: ShellShortcutState) => void,
): () => void {
  onChange(resolveShellShortcutState([]));
  return subscribeEditorShortcutOverrides(root, (overrides) => {
    onChange(resolveShellShortcutState(overrides));
  });
}
