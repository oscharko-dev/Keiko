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

function eventMatchesChord(
  event: KeyboardEvent,
  chord: WorkspaceKeyChord,
  platform: "mac" | "other",
): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
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
      if (isEditableTarget(event.target)) return;
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
