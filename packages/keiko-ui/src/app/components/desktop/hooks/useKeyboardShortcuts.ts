// Epic #518 / Issue #527 — Workspace keyboard shortcut substrate.
//
// Implements the keyboard shortcut substrate from ADR-0028:
//   - Conflict-at-startup: two bindings claiming the same chord throw at
//     module evaluation. Build fails first; users never see a collision.
//   - Browser-reserved chords (Cmd/Ctrl+T, +R, +Shift+N) are rejected at
//     bind time per WORKSPACE_RESERVED_CHORDS in @oscharko-dev/keiko-contracts.
//   - Platform normalization: "cmd" modifier resolves to metaKey on macOS
//     and ctrlKey elsewhere via navigator.platform detection.
//
// The hook is pure substrate; the consuming component supplies the command
// registry. No dependency is introduced.

"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  type WorkspaceKeyChord,
  type WorkspaceKeyChordModifier,
  type WorkspaceKeyboardShortcutBinding,
  type WorkspaceKeyboardShortcutConflict,
  isWorkspaceReservedChord,
  workspaceChordKey,
} from "@oscharko-dev/keiko-contracts";

export interface UseKeyboardShortcutsResult {
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
  readonly conflicts: ReadonlyArray<WorkspaceKeyboardShortcutConflict>;
  readonly reserved: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
}

export interface UseKeyboardShortcutsOptions {
  readonly bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
  readonly dispatch: (commandId: string) => void;
  readonly platform?: "mac" | "other";
}

function detectPlatform(): "mac" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/i.test(ua) ? "mac" : "other";
}

// Normalize "cmd" → metaKey on macOS, ctrlKey elsewhere. Other modifiers
// pass through unchanged. The returned set lists the modifier names a
// KeyboardEvent must have asserted to be considered a match.
function normalizeModifiers(
  mods: ReadonlyArray<WorkspaceKeyChordModifier>,
  platform: "mac" | "other",
): ReadonlySet<"meta" | "ctrl" | "alt" | "shift"> {
  const out = new Set<"meta" | "ctrl" | "alt" | "shift">();
  for (const m of mods) {
    if (m === "cmd") {
      out.add(platform === "mac" ? "meta" : "ctrl");
    } else if (m === "ctrl") {
      out.add("ctrl");
    } else if (m === "alt") {
      out.add("alt");
    } else if (m === "shift") {
      out.add("shift");
    }
  }
  return out;
}

// On macOS the Option key composes characters: Option+S yields event.key "ß"
// (US and DE layouts alike), never "s" — a pure event.key comparison makes any
// alt-modified letter chord unmatchable on Macs (audit C125). For single-letter
// chords with an alt modifier we therefore also accept the layout-independent
// physical key via event.code ("KeyS"). Cmd/Ctrl chords are unaffected.
function chordKeyMatches(event: KeyboardEvent, chord: WorkspaceKeyChord): boolean {
  if (event.key.toLowerCase() === chord.key.toLowerCase()) return true;
  if (chord.mod.includes("alt") && /^[a-z]$/i.test(chord.key)) {
    return event.code === `Key${chord.key.toUpperCase()}`;
  }
  return false;
}

function eventMatchesChord(
  event: KeyboardEvent,
  chord: WorkspaceKeyChord,
  platform: "mac" | "other",
): boolean {
  if (!chordKeyMatches(event, chord)) return false;
  const required = normalizeModifiers(chord.mod, platform);
  if (event.metaKey !== required.has("meta")) return false;
  if (event.ctrlKey !== required.has("ctrl")) return false;
  if (event.altKey !== required.has("alt")) return false;
  if (event.shiftKey !== required.has("shift")) return false;
  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Opt-in marker for a text field that must NOT swallow the shell chords. Put it on (or on an
 * ancestor of) the field; `useKeyboardShortcuts` then applies the forwarding rule below instead of
 * suppressing every chord.
 *
 * The chat composer is the case this exists for: `isEditableTarget` above suppresses the whole
 * shell chord set inside any text field, which left Cmd/Ctrl+P, Cmd/Ctrl+Shift+P and
 * Cmd/Ctrl+Shift+F dead in the product's primary input. The editor already had an explicit bypass
 * for exactly this shape (`EditorQuickAccessTriggerContext`, a capturing listener on the editor
 * container); this is the same seam declared on the element, so the decision stays in the ONE place
 * that owns chord dispatch instead of growing a second per-surface listener.
 */
export const SHELL_CHORD_BYPASS_ATTRIBUTE = "data-shell-chord-bypass";

// The chords a focused text field owns itself — undo/redo of the user's own typing plus the
// clipboard/select-all set.
const TEXT_FIELD_OWNED_KEYS: ReadonlySet<string> = new Set(["z", "y", "x", "c", "v", "a"]);

// THE RULE for a field that opted in via SHELL_CHORD_BYPASS_ATTRIBUTE: forward the keydown to the
// shell only when it carries Cmd/Ctrl, carries no Alt, and its key is not one of the chords the
// field's own text editing owns. Everything else stays with the caret:
//   - a plain or Shift-only key is literal typing;
//   - Alt is a character-composition modifier inside a text field (on macOS Option+S types "ß"),
//     so an Alt chord must never be taken away from the field;
//   - Cmd/Ctrl+Z / +Shift+Z / +Y inside a text field mean "undo my typing", NOT "undo a workspace
//     panel toggle" — routing them to the shell undo stack would silently reverse an unrelated
//     workspace action while the user was editing text;
//   - Cmd/Ctrl+X / +C / +V / +A are the field's clipboard and select-all.
function forwardableFromOptedInField(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return !TEXT_FIELD_OWNED_KEYS.has(event.key.toLowerCase());
}

function optsIntoShellChords(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(`[${SHELL_CHORD_BYPASS_ATTRIBUTE}]`) !== null;
}

function suppressedByEditableTarget(event: KeyboardEvent): boolean {
  if (!isEditableTarget(event.target)) return false;
  if (!optsIntoShellChords(event.target)) return true;
  return !forwardableFromOptedInField(event);
}

export function detectShortcutConflicts(
  bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>,
): ReadonlyArray<WorkspaceKeyboardShortcutConflict> {
  const seen = new Map<string, string[]>();
  for (const binding of bindings) {
    const key = workspaceChordKey(binding.chord);
    const existing = seen.get(key);
    if (existing !== undefined) {
      existing.push(binding.commandId);
    } else {
      seen.set(key, [binding.commandId]);
    }
  }
  const conflicts: WorkspaceKeyboardShortcutConflict[] = [];
  for (const [, commandIds] of seen) {
    if (commandIds.length > 1) {
      const first = bindings.find((b) => commandIds.includes(b.commandId));
      if (first !== undefined) {
        conflicts.push({ chord: first.chord, commandIds });
      }
    }
  }
  return conflicts;
}

export function detectReservedBindings(
  bindings: ReadonlyArray<WorkspaceKeyboardShortcutBinding>,
): ReadonlyArray<WorkspaceKeyboardShortcutBinding> {
  return bindings.filter((b) => isWorkspaceReservedChord(b.chord));
}

export class WorkspaceShortcutConflictError extends Error {
  readonly conflicts: ReadonlyArray<WorkspaceKeyboardShortcutConflict>;
  constructor(conflicts: ReadonlyArray<WorkspaceKeyboardShortcutConflict>) {
    super(
      `Workspace keyboard shortcut conflicts detected: ${conflicts
        .map((c) => `${workspaceChordKey(c.chord)} (${c.commandIds.join(", ")})`)
        .join("; ")}`,
    );
    this.name = "WorkspaceShortcutConflictError";
    this.conflicts = conflicts;
  }
}

export class WorkspaceShortcutReservedError extends Error {
  readonly reserved: ReadonlyArray<WorkspaceKeyboardShortcutBinding>;
  constructor(reserved: ReadonlyArray<WorkspaceKeyboardShortcutBinding>) {
    super(
      `Workspace keyboard shortcut bindings refused: ${reserved
        .map((b) => `${b.commandId} → ${workspaceChordKey(b.chord)}`)
        .join("; ")} are browser-reserved`,
    );
    this.name = "WorkspaceShortcutReservedError";
    this.reserved = reserved;
  }
}

export function useKeyboardShortcuts(
  options: UseKeyboardShortcutsOptions,
): UseKeyboardShortcutsResult {
  const { bindings, dispatch } = options;
  const platform = options.platform ?? detectPlatform();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const conflicts = useMemo(() => detectShortcutConflicts(bindings), [bindings]);
  const reserved = useMemo(() => detectReservedBindings(bindings), [bindings]);

  // Fail-closed at first user action — the build never ships a conflict.
  if (conflicts.length > 0) {
    throw new WorkspaceShortcutConflictError(conflicts);
  }
  if (reserved.length > 0) {
    throw new WorkspaceShortcutReservedError(reserved);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (suppressedByEditableTarget(event)) return;
      for (const binding of bindings) {
        if (eventMatchesChord(event, binding.chord, platform)) {
          event.preventDefault();
          dispatchRef.current(binding.commandId);
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return (): void => window.removeEventListener("keydown", onKeyDown);
  }, [bindings, platform]);

  return useMemo(() => ({ bindings, conflicts, reserved }), [bindings, conflicts, reserved]);
}
