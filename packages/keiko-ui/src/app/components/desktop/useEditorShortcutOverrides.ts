"use client";

import { useEffect, useState } from "react";
import type { EditorM7SettingsSnapshot } from "@oscharko-dev/keiko-contracts";

function eventsUrl(root: string | undefined): string {
  return root === undefined || root.length === 0
    ? "/api/editor/settings/events"
    : `/api/editor/settings/events?root=${encodeURIComponent(root)}`;
}

function keybindingOverrides(snapshot: EditorM7SettingsSnapshot): readonly string[] {
  const value = snapshot.settings.find((setting) => setting.id === "keybindingOverrides")?.value;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function useEditorShortcutOverrides(root: string | undefined): readonly string[] {
  const [overrides, setOverrides] = useState<readonly string[]>([]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;

    const load = async (): Promise<void> => {
      try {
        const { fetchEditorSettings } = await import("@/lib/api");
        const snapshot = await fetchEditorSettings(root, controller.signal);
        if (active && !controller.signal.aborted) setOverrides(keybindingOverrides(snapshot));
      } catch {
        if (active && !controller.signal.aborted) setOverrides([]);
      }
    };

    void load();
    void import("./widgets/cards/sharedEventSource").then(({ subscribeSharedEventSource }) => {
      if (!active) return;
      unsubscribe = subscribeSharedEventSource(
        eventsUrl(root),
        ["ready", "editor-settings:changed"],
        () => {
          void load();
        },
      );
    });

    return () => {
      active = false;
      controller.abort();
      unsubscribe?.();
    };
  }, [root]);

  return overrides;
}
