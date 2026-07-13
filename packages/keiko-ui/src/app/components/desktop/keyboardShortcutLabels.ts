"use client";

export type KeyboardShortcutPlatformLabel = "mac" | "other";

export function shortcutLabelForPlatform(
  binding: string | null,
  platform: KeyboardShortcutPlatformLabel,
): string {
  if (binding === null) return "Unbound";
  return binding
    .split("+")
    .map((part) => shortcutLabelPart(part, platform))
    .join(platform === "mac" ? "" : "+");
}

export function shortcutLabelPart(part: string, platform: KeyboardShortcutPlatformLabel): string {
  const modifier = modifierLabel(part, platform);
  if (modifier !== null) return modifier;
  return keyLabel(part);
}

export function detectKeyboardShortcutPlatform(): KeyboardShortcutPlatformLabel {
  if (typeof navigator === "undefined") return "other";
  return /Mac|iPhone|iPad|iPod/iu.test(navigator.platform) ? "mac" : "other";
}

function modifierLabel(part: string, platform: KeyboardShortcutPlatformLabel): string | null {
  if (platform === "mac") return macModifierLabel(part);
  if (part === "CtrlOrMeta" || part === "Meta") return "Ctrl";
  if (part === "Alt") return "Alt";
  if (part === "Shift") return "Shift";
  return null;
}

function macModifierLabel(part: string): string | null {
  if (part === "CtrlOrMeta" || part === "Meta") return "⌘";
  if (part === "Ctrl") return "⌃";
  if (part === "Alt") return "⌥";
  if (part === "Shift") return "⇧";
  return null;
}

function keyLabel(part: string): string {
  if (part.startsWith("Arrow")) return part.replace("Arrow", "");
  return part.length === 1 ? part.toUpperCase() : part;
}
