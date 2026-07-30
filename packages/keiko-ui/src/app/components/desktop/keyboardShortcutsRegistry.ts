"use client";

import {
  EDITOR_M7_COMMAND_REGISTRY,
  isWorkspaceReservedChord,
  parseEditorM7KeybindingOverrides,
  serializeEditorM7KeybindingOverride,
  validateEditorM7Keybinding,
  workspaceChordKey,
  type EditorM7ActiveKeybinding,
  type EditorM7CommandContext,
  type EditorM7CommandDefinition,
  type EditorM7KeybindingOverride,
  type EditorM7ReasonCode,
  type EditorM7SettingValue,
  type WorkspaceKeyChord,
  type WorkspaceKeyChordModifier,
} from "@oscharko-dev/keiko-contracts";
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

export function bindingToWorkspaceChord(binding: string): WorkspaceKeyChord | null {
  const parts = binding.split("+");
  const key = parts.at(-1);
  if (key === undefined || key.length === 0 || workspaceModifier(key) !== null) return null;
  const mod: WorkspaceKeyChordModifier[] = [];
  const sourceModifiers = parts.slice(0, -1);
  if (
    sourceModifiers.includes("CtrlOrMeta") &&
    (sourceModifiers.includes("Ctrl") || sourceModifiers.includes("Meta"))
  ) {
    return null;
  }
  for (const part of sourceModifiers) {
    const modifier = workspaceModifier(part);
    if (modifier === null || mod.includes(modifier)) return null;
    mod.push(modifier);
  }
  return { key: keyForWorkspace(key), mod };
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

interface ShortcutChordOption {
  readonly chord: WorkspaceKeyChord;
  readonly binding: string;
}

interface ShortcutChordCandidate {
  readonly commandId: string;
  readonly overridden: boolean;
  // Preference order: the effective (possibly user-overridden) binding first, the command's own
  // default second. A candidate whose every option is refused dispatches nothing.
  readonly options: readonly ShortcutChordOption[];
}

function dispatchableInContext(
  entry: EffectiveKeyboardShortcut,
  context: EditorM7CommandContext,
): boolean {
  return entry.command.contexts.includes(context) && entry.command.dispatchOwner === "keiko";
}

// Persisted overrides are hostile input (AGENTS.md §7): a browser-reserved chord is dropped here
// rather than carried into render, where the substrate fails closed by THROWING.
function chordOption(binding: string | null): ShortcutChordOption | null {
  if (binding === null) return null;
  const chord = bindingToWorkspaceChord(binding);
  if (chord === null || isWorkspaceReservedChord(chord)) return null;
  return { chord, binding };
}

function chordCandidate(entry: EffectiveKeyboardShortcut): ShortcutChordCandidate {
  const options: ShortcutChordOption[] = [];
  for (const option of [chordOption(entry.binding), chordOption(entry.defaultBinding)]) {
    if (option === null || options.some((existing) => existing.binding === option.binding))
      continue;
    options.push(option);
  }
  return { commandId: entry.command.id, overridden: entry.modified, options };
}

// First claim wins, and unoverridden commands claim first: a persisted override can never take a
// chord away from a stock binding, it can only fail to apply and fall back to its own default.
function claimedChords(
  candidates: readonly ShortcutChordCandidate[],
): ReadonlyMap<string, ShortcutChordOption> {
  const claimed = new Set<string>();
  const accepted = new Map<string, ShortcutChordOption>();
  const ordered = [
    ...candidates.filter((candidate) => !candidate.overridden),
    ...candidates.filter((candidate) => candidate.overridden),
  ];
  for (const candidate of ordered) {
    const option = candidate.options.find((entry) => !claimed.has(workspaceChordKey(entry.chord)));
    if (option === undefined) continue;
    claimed.add(workspaceChordKey(option.chord));
    accepted.set(candidate.commandId, option);
  }
  return accepted;
}

/**
 * The single dispatch-safe projection of the effective registry: every returned chord is unique
 * within the context and none is browser-reserved, so `useKeyboardShortcuts` can never be handed a
 * set it refuses. A malformed, reserved or colliding persisted override is IGNORED and the command
 * falls back to its default binding; a command with nothing usable dispatches nothing.
 */
export function dispatchableWorkspaceShortcutsForContext(
  registry: EffectiveKeyboardShortcutRegistry,
  context: EditorM7CommandContext,
): readonly DispatchableWorkspaceShortcut[] {
  const candidates = registry.commands
    .filter((entry) => dispatchableInContext(entry, context))
    .map(chordCandidate);
  const accepted = claimedChords(candidates);
  return candidates.flatMap((candidate) => {
    const option = accepted.get(candidate.commandId);
    return option === undefined
      ? []
      : [{ commandId: candidate.commandId, chord: option.chord, binding: option.binding }];
  });
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
