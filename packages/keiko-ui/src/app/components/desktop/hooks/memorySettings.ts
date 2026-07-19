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

// Synchronous, non-subscribing read of the current mode — lets a background hydration (see
// useChatSession's autonomy-policy hydration effect) detect whether a newer selection landed
// while its request was in flight, without needing a full revision counter on the store.
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
