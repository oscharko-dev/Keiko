"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

const DEFAULT_MEMORY_BUDGET_TOKENS = 1200;

interface ConversationMemoryScopeSnapshot {
  readonly enabled: boolean;
  readonly budgetTokens: number;
}

interface ConversationMemorySettingsSnapshot extends ConversationMemoryScopeSnapshot {
  readonly mode: CodingWorkbenchMode;
}

const DEFAULT_MEMORY_SCOPE: ConversationMemoryScopeSnapshot = {
  enabled: false,
  budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS,
};

const DEFAULT_MEMORY_SETTINGS: ConversationMemorySettingsSnapshot = {
  ...DEFAULT_MEMORY_SCOPE,
  mode: "governed-assist",
};

let defaultScopeSettings = DEFAULT_MEMORY_SCOPE;
let currentMode = DEFAULT_MEMORY_SETTINGS.mode;
let currentModeRevision = 0;
const conversationScopes = new Map<string, ConversationMemoryScopeSnapshot>();
const listeners = new Set<() => void>();

function scopeSettingsEqual(
  left: ConversationMemoryScopeSnapshot,
  right: ConversationMemoryScopeSnapshot,
): boolean {
  return left.enabled === right.enabled && left.budgetTokens === right.budgetTokens;
}

function normalizeBudgetTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens);
}

function notifySubscribers(): void {
  for (const listener of listeners) listener();
}

function scopeSnapshot(scopeKey: string | undefined): ConversationMemoryScopeSnapshot {
  return scopeKey === undefined
    ? defaultScopeSettings
    : (conversationScopes.get(scopeKey) ?? defaultScopeSettings);
}

function publishScope(
  scopeKey: string | undefined,
  patch: Partial<ConversationMemoryScopeSnapshot>,
): void {
  const current = scopeSnapshot(scopeKey);
  const next = { ...current, ...patch };
  if (scopeSettingsEqual(next, current)) return;
  if (scopeKey === undefined) defaultScopeSettings = next;
  else conversationScopes.set(scopeKey, next);
  notifySubscribers();
}

function publishMode(next: CodingWorkbenchMode): void {
  if (next === currentMode) return;
  currentMode = next;
  currentModeRevision += 1;
  notifySubscribers();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Synchronous, non-subscribing revision read. Comparing the revision, rather than only the
// current value, closes the A→B→A case where a stale hydration would otherwise mistake an older
// value for an unchanged store and overwrite a newer user selection.
export function currentConversationMemoryModeRevision(): number {
  return currentModeRevision;
}

export function currentConversationMemoryMode(): CodingWorkbenchMode {
  return currentMode;
}

export function removeConversationMemorySettings(scopeKey: string): void {
  const removed = conversationScopes.get(scopeKey);
  if (removed === undefined) return;
  conversationScopes.delete(scopeKey);
  if (!scopeSettingsEqual(removed, defaultScopeSettings)) notifySubscribers();
}

export function useConversationMemorySettings(scopeKey?: string): {
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly memoryMode: CodingWorkbenchMode;
  readonly setMemoryMode: (next: CodingWorkbenchMode) => void;
} {
  const getScopeSnapshot = useCallback(
    (): ConversationMemoryScopeSnapshot => scopeSnapshot(scopeKey),
    [scopeKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getScopeSnapshot, getScopeSnapshot);
  const mode = useSyncExternalStore(
    subscribe,
    currentConversationMemoryMode,
    currentConversationMemoryMode,
  );
  const setMemoryEnabled = useCallback(
    (next: boolean): void => publishScope(scopeKey, { enabled: next }),
    [scopeKey],
  );
  const setMemoryBudgetTokens = useCallback(
    (next: number): void => publishScope(scopeKey, { budgetTokens: normalizeBudgetTokens(next) }),
    [scopeKey],
  );
  const setMemoryMode = useCallback((next: CodingWorkbenchMode): void => {
    publishMode(next);
  }, []);

  return {
    memoryEnabled: snapshot.enabled,
    setMemoryEnabled,
    memoryBudgetTokens: snapshot.budgetTokens,
    setMemoryBudgetTokens,
    memoryMode: mode,
    setMemoryMode,
  };
}

export function resetConversationMemorySettingsForTests(): void {
  const changed =
    !scopeSettingsEqual(defaultScopeSettings, DEFAULT_MEMORY_SCOPE) ||
    [...conversationScopes.values()].some(
      (scope) => !scopeSettingsEqual(scope, DEFAULT_MEMORY_SCOPE),
    ) ||
    currentMode !== DEFAULT_MEMORY_SETTINGS.mode;
  const modeChanged = currentMode !== DEFAULT_MEMORY_SETTINGS.mode;
  defaultScopeSettings = DEFAULT_MEMORY_SCOPE;
  conversationScopes.clear();
  currentMode = DEFAULT_MEMORY_SETTINGS.mode;
  if (modeChanged) currentModeRevision += 1;
  if (changed) notifySubscribers();
}
