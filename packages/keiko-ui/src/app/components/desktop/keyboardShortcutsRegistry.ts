"use client";

import type {
  EditorM7ActiveKeybinding,
  EditorM7CommandContext,
  EditorM7CommandDefinition,
  EditorM7KeybindingOverride,
  EditorM7ReasonCode,
  EditorM7SettingValue,
  WorkspaceKeyChord,
  WorkspaceKeyChordModifier,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_M7_COMMAND_REGISTRY,
  parseEditorM7KeybindingOverrides,
  serializeEditorM7KeybindingOverride,
  validateEditorM7Keybinding,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import {
  isWorkspaceDispatchableChord,
  isWorkspaceReservedChord,
  workspaceChordClaimKeys,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-ui";
import {
  detectKeyboardShortcutPlatform as detectPlatform,
  shortcutLabelForPlatform,
  type KeyboardShortcutPlatformLabel,
} from "./keyboardShortcutLabels";

type KeyboardShortcutSource = "default" | "user";
export type KeyboardShortcutPlatform = KeyboardShortcutPlatformLabel;

export interface EffectiveKeyboardShortcut {
  readonly command: EditorM7CommandDefinition;
  readonly binding: string | null;
  readonly defaultBinding: string | null;
  readonly source: KeyboardShortcutSource;
  readonly modified: boolean;
  readonly conflictCommandIds: readonly string[];
}

interface KeyboardShortcutRegistryStatus {
  readonly kind: "ready" | "fallback";
  readonly reasonCode?: EditorM7ReasonCode | undefined;
}

export interface EffectiveKeyboardShortcutRegistry {
  readonly commands: readonly EffectiveKeyboardShortcut[];
  readonly activeBindings: readonly EditorM7ActiveKeybinding[];
  readonly status: KeyboardShortcutRegistryStatus;
}

const MODIFIER_ORDER = Object.freeze(["CtrlOrMeta", "Ctrl", "Meta", "Alt", "Shift"] as const);

function settingArray(value: EditorM7SettingValue | undefined): readonly string[] {
  return Array.isArray(value) ? value : [];
}

function defaultBinding(command: EditorM7CommandDefinition): string | null {
  return command.defaultBindings[0] ?? null;
}

function defaultActiveBindings(): readonly EditorM7ActiveKeybinding[] {
  return EDITOR_M7_COMMAND_REGISTRY.flatMap((command) =>
    command.defaultBindings.map((binding) => ({ commandId: command.id, binding })),
  );
}

function commandFor(commandId: string): EditorM7CommandDefinition | undefined {
  return EDITOR_M7_COMMAND_REGISTRY.find((command) => command.id === commandId);
}

function contextsOverlap(
  left: EditorM7CommandDefinition,
  right: EditorM7CommandDefinition,
): boolean {
  if (left.contexts.includes("global") || right.contexts.includes("global")) return true;
  if (left.contexts.some((context) => right.contexts.includes(context))) return true;
  const editorLike = new Set<EditorM7CommandContext>(["editor", "monaco"]);
  return (
    left.contexts.some((context) => editorLike.has(context)) &&
    right.contexts.some((context) => editorLike.has(context))
  );
}

function conflictIds(
  command: EditorM7CommandDefinition,
  binding: string | null,
  activeBindings: readonly EditorM7ActiveKeybinding[],
): readonly string[] {
  if (binding === null) return [];
  return activeBindings.flatMap((entry) => {
    if (entry.commandId === command.id || entry.binding !== binding) return [];
    const other = commandFor(entry.commandId);
    return other !== undefined && contextsOverlap(command, other) ? [entry.commandId] : [];
  });
}

export function resolveEffectiveKeyboardShortcuts(
  rawOverrides: EditorM7SettingValue | undefined,
): EffectiveKeyboardShortcutRegistry {
  const parsed = parseEditorM7KeybindingOverrides(settingArray(rawOverrides));
  const overrides = parsed.ok ? parsed.value : [];
  const overrideByCommand = new Map(overrides.map((override) => [override.commandId, override]));
  const activeBindings = EDITOR_M7_COMMAND_REGISTRY.flatMap((command) => {
    const override = overrideByCommand.get(command.id);
    const bindings = override === undefined ? command.defaultBindings : [override.binding];
    return bindings.map((binding) => ({ commandId: command.id, binding }));
  });
  return {
    commands: EDITOR_M7_COMMAND_REGISTRY.map((command) => {
      const override = overrideByCommand.get(command.id);
      const binding = override?.binding ?? defaultBinding(command);
      return {
        command,
        binding,
        defaultBinding: defaultBinding(command),
        source: override === undefined ? "default" : "user",
        modified: override !== undefined,
        conflictCommandIds: conflictIds(command, binding, activeBindings),
      };
    }),
    activeBindings,
    status: parsed.ok ? { kind: "ready" } : { kind: "fallback", reasonCode: parsed.reasonCode },
  };
}

export function updateKeyboardShortcutOverride(args: {
  readonly current: EditorM7SettingValue | undefined;
  readonly commandId: string;
  readonly binding: string;
}):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly reasonCode: EditorM7ReasonCode } {
  const parsed = parseEditorM7KeybindingOverrides(settingArray(args.current));
  if (!parsed.ok) return { ok: false, reasonCode: parsed.reasonCode };
  const retained = parsed.value.filter((override) => override.commandId !== args.commandId);
  const activeBindings = activeBindingsWithOverrides(retained);
  const validated = validateEditorM7Keybinding({
    commandId: args.commandId,
    binding: args.binding,
    activeBindings,
  });
  if (!validated.ok) return { ok: false, reasonCode: validated.reasonCode };
  return {
    ok: true,
    value: [
      ...retained.map(serializeEditorM7KeybindingOverride),
      serializeEditorM7KeybindingOverride({
        schemaVersion: "1",
        commandId: args.commandId,
        binding: validated.value,
      }),
    ],
  };
}

export function removeKeyboardShortcutOverride(
  current: EditorM7SettingValue | undefined,
  commandId: string,
): readonly string[] {
  const parsed = parseEditorM7KeybindingOverrides(settingArray(current));
  if (!parsed.ok) return [];
  return parsed.value
    .filter((override) => override.commandId !== commandId)
    .map(serializeEditorM7KeybindingOverride);
}

function activeBindingsWithOverrides(
  overrides: readonly EditorM7KeybindingOverride[],
): readonly EditorM7ActiveKeybinding[] {
  const overrideByCommand = new Map(overrides.map((override) => [override.commandId, override]));
  return defaultActiveBindings().map((entry) => ({
    commandId: entry.commandId,
    binding: overrideByCommand.get(entry.commandId)?.binding ?? entry.binding,
  }));
}

/**
 * `CtrlOrMeta`, `Ctrl` and `Meta` all map into the two-value chord vocabulary (`cmd` / `ctrl`), so
 * any two of them in one binding produce a chord the matcher cannot express — `CtrlOrMeta+Ctrl+X`
 * and `Ctrl+Meta+X` alike. The refusal is the contracts predicate rather than a spelling check, so
 * a binding cannot smuggle the pair past this parser by naming the same physical key differently
 * (0.3.0 release audit, #2802).
 */
export function bindingToWorkspaceChord(binding: string): WorkspaceKeyChord | null {
  const parts = binding.split("+");
  const key = parts.at(-1);
  if (key === undefined || key.length === 0 || workspaceModifier(key) !== null) return null;
  const mod: WorkspaceKeyChordModifier[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = workspaceModifier(part);
    if (modifier === null || mod.includes(modifier)) return null;
    mod.push(modifier);
  }
  const chord: WorkspaceKeyChord = { key: keyForWorkspace(key), mod };
  return isWorkspaceDispatchableChord(chord) ? chord : null;
}

function workspaceModifier(part: string): WorkspaceKeyChordModifier | null {
  if (part === "CtrlOrMeta" || part === "Meta") return "cmd";
  if (part === "Ctrl") return "ctrl";
  if (part === "Alt") return "alt";
  if (part === "Shift") return "shift";
  return null;
}

function keyForWorkspace(key: string): string {
  if (key.startsWith("Arrow")) return key.toLowerCase();
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * A binding that is safe to hand to `useKeyboardShortcuts`, together with the binding string it was
 * actually resolved from — so a surface that LABELS a shortcut shows the chord that really fires.
 */
export interface DispatchableWorkspaceShortcut {
  readonly commandId: string;
  readonly chord: WorkspaceKeyChord;
  readonly binding: string;
}

/**
 * A refusal the projection reports so the drop is not silent (AGENTS.md §7, ADR-0028 §4 amendment).
 * Body-free by construction: a closed-registry command id and a closed reason code, never the
 * rejected record, its raw binding text, a scope path or any other settings content.
 */
export interface DispatchableShortcutRefusal {
  readonly commandId: string;
  readonly reasonCode: EditorM7ReasonCode;
}

export interface DispatchableWorkspaceShortcutProjection {
  readonly shortcuts: readonly DispatchableWorkspaceShortcut[];
  readonly refusals: readonly DispatchableShortcutRefusal[];
}

interface ShortcutChordOption {
  readonly chord: WorkspaceKeyChord;
  readonly binding: string;
}

interface ShortcutChordCandidate {
  readonly commandId: string;
  readonly overridden: boolean;
  readonly defaultOption: ShortcutChordOption | null;
  readonly overrideOption: ShortcutChordOption | null;
  // Set when the command carries an override that never becomes a usable chord at all.
  readonly overrideRefusal: EditorM7ReasonCode | null;
}

function dispatchableInContext(
  entry: EffectiveKeyboardShortcut,
  context: EditorM7CommandContext,
): boolean {
  return entry.command.contexts.includes(context) && entry.command.dispatchOwner === "keiko";
}

type ChordOptionOutcome =
  { readonly option: ShortcutChordOption } | { readonly reasonCode: EditorM7ReasonCode } | null;

// Persisted overrides are hostile input (AGENTS.md §7): a browser-reserved or inexpressible chord is
// dropped here rather than carried into render, where the substrate fails closed by THROWING.
function chordOption(binding: string | null): ChordOptionOutcome {
  if (binding === null) return null;
  const chord = bindingToWorkspaceChord(binding);
  if (chord === null) return { reasonCode: "INVALID_INPUT" };
  if (isWorkspaceReservedChord(chord)) return { reasonCode: "RESERVED_KEYBINDING" };
  return { option: { chord, binding } };
}

function optionOf(outcome: ChordOptionOutcome): ShortcutChordOption | null {
  return outcome !== null && "option" in outcome ? outcome.option : null;
}

function refusalOf(outcome: ChordOptionOutcome): EditorM7ReasonCode | null {
  return outcome !== null && "reasonCode" in outcome ? outcome.reasonCode : null;
}

function chordCandidate(entry: EffectiveKeyboardShortcut): ShortcutChordCandidate {
  const override = entry.modified ? chordOption(entry.binding) : null;
  return {
    commandId: entry.command.id,
    overridden: entry.modified,
    defaultOption: optionOf(chordOption(entry.defaultBinding)),
    overrideOption: optionOf(override),
    overrideRefusal: refusalOf(override),
  };
}

interface ChordClaimState {
  readonly claimedBy: Map<string, string>;
  readonly accepted: Map<string, ShortcutChordOption>;
  readonly refusals: DispatchableShortcutRefusal[];
}

function claimFree(
  state: ChordClaimState,
  option: ShortcutChordOption,
  commandId: string,
): boolean {
  return workspaceChordClaimKeys(option.chord).every((key) => {
    const holder = state.claimedBy.get(key);
    return holder === undefined || holder === commandId;
  });
}

function takeClaim(state: ChordClaimState, option: ShortcutChordOption, commandId: string): void {
  for (const key of workspaceChordClaimKeys(option.chord)) state.claimedBy.set(key, commandId);
  state.accepted.set(commandId, option);
}

function releaseClaim(state: ChordClaimState, option: ShortcutChordOption): void {
  for (const key of workspaceChordClaimKeys(option.chord)) state.claimedBy.delete(key);
}

// An override may only move its command onto a keystroke nothing else holds. Its own default is
// still reserved at this point, so a refused override simply keeps it.
function applyOverride(state: ChordClaimState, candidate: ShortcutChordCandidate): void {
  if (candidate.overrideRefusal !== null) {
    state.refusals.push({ commandId: candidate.commandId, reasonCode: candidate.overrideRefusal });
    return;
  }
  const option = candidate.overrideOption;
  if (option === null) return;
  if (!claimFree(state, option, candidate.commandId)) {
    state.refusals.push({ commandId: candidate.commandId, reasonCode: "KEYBINDING_COLLISION" });
    return;
  }
  const own = state.accepted.get(candidate.commandId);
  if (own !== undefined) releaseClaim(state, own);
  takeClaim(state, option, candidate.commandId);
}

/**
 * Claiming is two phases, and the order is the guarantee. Every command's OWN DEFAULT chord is
 * reserved first, so a persisted record can never take a chord away from a stock binding — it can
 * only move its command onto a keystroke nothing else holds, and otherwise falls back to that
 * default. Claims are compared on `workspaceChordClaimKeys`, the keystrokes a chord occupies across
 * platforms, because `cmd|p` and `ctrl|p` are one keystroke off macOS and a table that treats them
 * as two silently disarms whichever command the dispatch loop reaches second (#2802).
 */
function claimChords(candidates: readonly ShortcutChordCandidate[]): ChordClaimState {
  const state: ChordClaimState = { claimedBy: new Map(), accepted: new Map(), refusals: [] };
  for (const candidate of candidates) {
    const option = candidate.defaultOption;
    if (option !== null && claimFree(state, option, candidate.commandId)) {
      takeClaim(state, option, candidate.commandId);
    }
  }
  for (const candidate of candidates) {
    if (candidate.overridden) applyOverride(state, candidate);
  }
  return state;
}

/**
 * The single dispatch-safe projection of the effective registry: every returned chord is unique
 * within the context and none is browser-reserved or inexpressible, so `useKeyboardShortcuts` can
 * never be handed a set it refuses. A malformed, reserved or colliding persisted override is
 * REFUSED and the command falls back to its own default binding — never to no binding, unless that
 * default is itself unusable. Each refusal is reported body-free rather than dropped in silence.
 */
export function projectDispatchableWorkspaceShortcuts(
  registry: EffectiveKeyboardShortcutRegistry,
  context: EditorM7CommandContext,
): DispatchableWorkspaceShortcutProjection {
  const candidates = registry.commands
    .filter((entry) => dispatchableInContext(entry, context))
    .map(chordCandidate);
  const state = claimChords(candidates);
  return {
    shortcuts: candidates.flatMap((candidate) => {
      const option = state.accepted.get(candidate.commandId);
      return option === undefined
        ? []
        : [{ commandId: candidate.commandId, chord: option.chord, binding: option.binding }];
    }),
    refusals: state.refusals,
  };
}

export function dispatchableWorkspaceShortcutsForContext(
  registry: EffectiveKeyboardShortcutRegistry,
  context: EditorM7CommandContext,
): readonly DispatchableWorkspaceShortcut[] {
  return projectDispatchableWorkspaceShortcuts(registry, context).shortcuts;
}

export function shortcutLabel(binding: string | null, platform: KeyboardShortcutPlatform): string {
  return shortcutLabelForPlatform(binding, platform);
}

export function detectKeyboardShortcutPlatform(): KeyboardShortcutPlatform {
  return detectPlatform();
}

export function bindingFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = normalizedEventKey(event);
  if (key === null) return null;
  const modifiers: string[] = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("CtrlOrMeta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeBinding([...modifiers, key].join("+"));
}

function normalizedEventKey(event: KeyboardEvent): string | null {
  if (event.key === "Control" || event.key === "Meta" || event.key === "Alt") return null;
  if (event.key === "Shift") return null;
  if (event.key.startsWith("Arrow")) return event.key;
  if (/^F\d{1,2}$/u.test(event.key)) return event.key;
  if (event.key === "Escape") return "Esc";
  if (event.key === " ") return "Space";
  if (event.key.length === 1 && printableKeySafe(event.key)) return event.key.toUpperCase();
  if (event.altKey && /^Key[A-Z]$/u.test(event.code)) return event.code.slice(3);
  return null;
}

function printableKeySafe(key: string): boolean {
  return /^[A-Za-z0-9,./;'[\]`\\-]$/u.test(key);
}

function normalizeBinding(binding: string): string {
  const parts = binding
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = parts.at(-1);
  if (key === undefined) return "";
  const modifiers = parts
    .slice(0, -1)
    .sort(
      (left, right) =>
        MODIFIER_ORDER.indexOf(left as never) - MODIFIER_ORDER.indexOf(right as never),
    );
  return [...modifiers, key].join("+");
}
