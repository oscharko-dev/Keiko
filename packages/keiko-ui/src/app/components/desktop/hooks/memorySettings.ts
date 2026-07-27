"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

const DEFAULT_MEMORY_BUDGET_TOKENS = 1200;

interface ConversationMemorySettingsSnapshot {
  readonly enabled: boolean;
  readonly budgetTokens: number;
  readonly mode: CodingWorkbenchMode;
}

const DEFAULT_MEMORY_SETTINGS: ConversationMemorySettingsSnapshot = {
  enabled: true,
  budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS,
  mode: "governed-assist",
};

let currentSettings = DEFAULT_MEMORY_SETTINGS;
let currentModeRevision = 0;
const listeners = new Set<() => void>();

function normalizeBudgetTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens);
}

function publish(next: ConversationMemorySettingsSnapshot): void {
  if (
    next.enabled === currentSettings.enabled &&
    next.budgetTokens === currentSettings.budgetTokens &&
    next.mode === currentSettings.mode
  ) {
    return;
  }
  const modeChanged = next.mode !== currentSettings.mode;
  currentSettings = next;
  if (modeChanged) currentModeRevision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ConversationMemorySettingsSnapshot {
  return currentSettings;
}

// Synchronous, non-subscribing revision read. Comparing the revision, rather than only the
// current value, closes the A→B→A case where a stale hydration would otherwise mistake an older
// value for an unchanged store and overwrite a newer user selection.
export function currentConversationMemoryModeRevision(): number {
  return currentModeRevision;
}

export function currentConversationMemoryMode(): CodingWorkbenchMode {
  return currentSettings.mode;
}

export function useConversationMemorySettings(): {
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly memoryMode: CodingWorkbenchMode;
  readonly setMemoryMode: (next: CodingWorkbenchMode) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setMemoryEnabled = useCallback((next: boolean): void => {
    publish({ ...currentSettings, enabled: next });
  }, []);
  const setMemoryBudgetTokens = useCallback((next: number): void => {
    publish({ ...currentSettings, budgetTokens: normalizeBudgetTokens(next) });
  }, []);
  const setMemoryMode = useCallback((next: CodingWorkbenchMode): void => {
    publish({ ...currentSettings, mode: next });
  }, []);

  return {
    memoryEnabled: snapshot.enabled,
    setMemoryEnabled,
    memoryBudgetTokens: snapshot.budgetTokens,
    setMemoryBudgetTokens,
    memoryMode: snapshot.mode,
    setMemoryMode,
  };
}

export function resetConversationMemorySettingsForTests(): void {
  publish(DEFAULT_MEMORY_SETTINGS);
}
