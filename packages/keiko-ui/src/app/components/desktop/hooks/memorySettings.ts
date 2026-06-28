"use client";

import { useCallback, useSyncExternalStore } from "react";

export const DEFAULT_MEMORY_BUDGET_TOKENS = 1200;

interface ConversationMemorySettingsSnapshot {
  readonly enabled: boolean;
  readonly budgetTokens: number;
}

const DEFAULT_MEMORY_SETTINGS: ConversationMemorySettingsSnapshot = {
  enabled: true,
  budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS,
};

let currentSettings = DEFAULT_MEMORY_SETTINGS;
const listeners = new Set<() => void>();

function normalizeBudgetTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens);
}

function publish(next: ConversationMemorySettingsSnapshot): void {
  if (
    next.enabled === currentSettings.enabled &&
    next.budgetTokens === currentSettings.budgetTokens
  ) {
    return;
  }
  currentSettings = next;
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

export function useConversationMemorySettings(): {
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setMemoryEnabled = useCallback((next: boolean): void => {
    publish({ ...currentSettings, enabled: next });
  }, []);
  const setMemoryBudgetTokens = useCallback((next: number): void => {
    publish({ ...currentSettings, budgetTokens: normalizeBudgetTokens(next) });
  }, []);

  return {
    memoryEnabled: snapshot.enabled,
    setMemoryEnabled,
    memoryBudgetTokens: snapshot.budgetTokens,
    setMemoryBudgetTokens,
  };
}

export function resetConversationMemorySettingsForTests(): void {
  publish(DEFAULT_MEMORY_SETTINGS);
}
