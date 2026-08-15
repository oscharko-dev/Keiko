"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { EDITOR_SELECTION_HANDOFF_TTL_MS } from "../editorSelectionHandoffPolicy";

export type ChatWindowFlowIntensity = "light" | "heavy";

export interface ChatWindowFlow {
  readonly flowing: boolean;
  readonly intensity: ChatWindowFlowIntensity;
}

export interface ChatWindowRuntimeTarget {
  readonly conversationId: string;
  readonly projectPath: string;
}

interface ChatWindowRuntime extends ChatWindowRuntimeTarget {
  readonly acceptingSelectionHandoff?: boolean;
  readonly acceptSelectionHandoff: (selectionHandoffId: string) => void;
}

interface ChatWindowRuntimeState {
  runtime: ChatWindowRuntime;
  registration: symbol;
  registered: boolean;
  reserved: boolean;
  readonly pendingSelectionHandoffs: PendingSelectionHandoff[];
}

interface PendingSelectionHandoff {
  readonly id: string;
  readonly preferredWindowIds: readonly string[];
  readonly onAbandoned?: (() => void) | undefined;
  readonly onUnavailable?: (() => string | null | void) | undefined;
}

interface StagedRuntimeHandoffs {
  readonly pending: PendingSelectionHandoff[];
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

export type ChatWindowGroundingActivity =
  | {
      readonly groundingKind: "connected-context";
      readonly contextPack: {
        readonly usage: { readonly filesRead: number; readonly excerptBytes: number };
      };
    }
  | {
      readonly groundingKind: "hybrid";
      readonly contextPack: {
        readonly folder: {
          readonly usage: { readonly filesRead: number; readonly excerptBytes: number };
        };
        readonly knowledge: { readonly referencesUsed: number };
      };
    }
  | {
      readonly groundingKind: "local-knowledge";
      readonly contextPack: { readonly referencesUsed: number };
    };

const HEAVY_FILES_READ = 4;
const HEAVY_EXCERPT_BYTES = 8_192;
const HEAVY_REFERENCES = 4;
const FLOW_AFTERGLOW_MS = 2_500;
const MAX_RETAINED_SELECTION_HANDOFFS = 64;

let snapshot: ReadonlyMap<string, ChatWindowFlow> = new Map();
const listeners = new Set<() => void>();
const runtimes = new Map<string, ChatWindowRuntimeState>();
const stagedRuntimeHandoffs = new Map<string, StagedRuntimeHandoffs>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function publishSnapshot(next: ReadonlyMap<string, ChatWindowFlow>): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function publishFlow(windowId: string, flow: ChatWindowFlow): void {
  const current = snapshot.get(windowId);
  if (current?.flowing === flow.flowing && current.intensity === flow.intensity) return;
  publishSnapshot(new Map(snapshot).set(windowId, flow));
}

function removeFlow(windowId: string): void {
  if (!snapshot.has(windowId)) return;
  const next = new Map(snapshot);
  next.delete(windowId);
  publishSnapshot(next);
}

function isHeavyFolder(filesRead: number, excerptBytes: number): boolean {
  return filesRead >= HEAVY_FILES_READ || excerptBytes >= HEAVY_EXCERPT_BYTES;
}

export function groundingIntensity(latest: ChatWindowGroundingActivity): ChatWindowFlowIntensity {
  switch (latest.groundingKind) {
    case "connected-context":
      return isHeavyFolder(
        latest.contextPack.usage.filesRead,
        latest.contextPack.usage.excerptBytes,
      )
        ? "heavy"
        : "light";
    case "hybrid":
      return isHeavyFolder(
        latest.contextPack.folder.usage.filesRead,
        latest.contextPack.folder.usage.excerptBytes,
      ) || latest.contextPack.knowledge.referencesUsed >= HEAVY_REFERENCES
        ? "heavy"
        : "light";
    case "local-knowledge":
      return latest.contextPack.referencesUsed >= HEAVY_REFERENCES ? "heavy" : "light";
  }
}

function useChannelFlow(
  sending: boolean,
  latest: ChatWindowGroundingActivity | undefined,
): ChatWindowFlow {
  const [intensity, setIntensity] = useState<ChatWindowFlowIntensity>("light");
  const [afterglow, setAfterglow] = useState(false);
  useEffect((): (() => void) | undefined => {
    if (latest === undefined) {
      setAfterglow(false);
      return;
    }
    setIntensity(groundingIntensity(latest));
    setAfterglow(true);
    const timer = setTimeout((): void => setAfterglow(false), FLOW_AFTERGLOW_MS);
    return (): void => clearTimeout(timer);
  }, [latest]);
  return { flowing: sending || afterglow, intensity };
}

export function usePublishChatWindowActivity(
  windowId: string,
  sending: boolean,
  latest: ChatWindowGroundingActivity | undefined,
): void {
  const flow = useChannelFlow(sending, latest);
  useEffect((): void => {
    publishFlow(windowId, flow);
  }, [flow, windowId]);
  useEffect(
    (): (() => void) => (): void => {
      removeFlow(windowId);
    },
    [windowId],
  );
}

export function registerChatWindowRuntime(
  windowId: string,
  runtime: ChatWindowRuntime,
): () => void {
  const registration = Symbol("chat-window-runtime");
  const existing = runtimes.get(windowId);
  const state: ChatWindowRuntimeState = existing ?? {
    runtime,
    registration,
    registered: true,
    reserved: false,
    pendingSelectionHandoffs: [],
  };
  state.runtime = runtime;
  state.registration = registration;
  state.registered = true;
  if (state.reserved && runtime.acceptingSelectionHandoff !== false) state.reserved = false;
  enqueuePendingSelectionHandoffs(state, takeStagedRuntimeHandoffs(windowId));
  runtimes.set(windowId, state);
  dispatchPendingSelectionHandoff(state);
  return (): void => {
    if (state.registration !== registration) return;
    state.registered = false;
    queueMicrotask((): void => {
      if (state.registration !== registration || state.registered) return;
      runtimes.delete(windowId);
      reroutePendingSelectionHandoffs(state);
    });
  };
}

export function chatWindowRuntimeTarget(windowId: string): ChatWindowRuntimeTarget | undefined {
  const state = runtimes.get(windowId);
  return state === undefined
    ? undefined
    : {
        conversationId: state.runtime.conversationId,
        projectPath: state.runtime.projectPath,
      };
}

function dispatchPendingSelectionHandoff(state: ChatWindowRuntimeState): void {
  if (!state.registered || state.reserved || state.runtime.acceptingSelectionHandoff === false) {
    return;
  }
  const pending = state.pendingSelectionHandoffs.shift();
  if (pending === undefined) return;
  state.reserved = true;
  state.runtime.acceptSelectionHandoff(pending.id);
}

function orderedRuntimeIds(preferredWindowIds: readonly string[]): string[] {
  const available = (windowId: string): boolean => runtimes.get(windowId)?.registered === true;
  const ordered = preferredWindowIds.filter(available);
  const preferred = new Set(ordered);
  for (const windowId of runtimes.keys()) {
    if (available(windowId) && !preferred.has(windowId)) ordered.push(windowId);
  }
  return ordered;
}

function abandonPendingSelectionHandoffs(pending: readonly PendingSelectionHandoff[]): void {
  for (const handoff of pending) handoff.onAbandoned?.();
}

function enqueuePendingSelectionHandoffs(
  state: ChatWindowRuntimeState,
  pending: readonly PendingSelectionHandoff[],
): void {
  const available = Math.max(
    0,
    MAX_RETAINED_SELECTION_HANDOFFS - state.pendingSelectionHandoffs.length,
  );
  state.pendingSelectionHandoffs.push(...pending.slice(0, available));
  abandonPendingSelectionHandoffs(pending.slice(available));
}

function takeStagedRuntimeHandoffs(windowId: string): PendingSelectionHandoff[] {
  const staged = stagedRuntimeHandoffs.get(windowId);
  if (staged === undefined) return [];
  clearTimeout(staged.timeoutId);
  stagedRuntimeHandoffs.delete(windowId);
  return staged.pending;
}

function abandonStagedRuntimeHandoffs(windowId: string): void {
  const staged = stagedRuntimeHandoffs.get(windowId);
  if (staged === undefined) return;
  clearTimeout(staged.timeoutId);
  stagedRuntimeHandoffs.delete(windowId);
  abandonPendingSelectionHandoffs(staged.pending);
}

function stagedRuntimeHandoffCount(): number {
  let count = 0;
  for (const staged of stagedRuntimeHandoffs.values()) count += staged.pending.length;
  return count;
}

function evictStagedRuntimeTargetsForCapacity(incomingCount: number): void {
  while (stagedRuntimeHandoffCount() + incomingCount > MAX_RETAINED_SELECTION_HANDOFFS) {
    const oldestWindowId = stagedRuntimeHandoffs.keys().next().value;
    if (typeof oldestWindowId !== "string") return;
    abandonStagedRuntimeHandoffs(oldestWindowId);
  }
}

function stageRuntimeHandoffs(windowId: string, pending: readonly PendingSelectionHandoff[]): void {
  if (pending.length === 0) return;
  const state = runtimes.get(windowId);
  if (state?.registered === true) {
    enqueuePendingSelectionHandoffs(state, pending);
    dispatchPendingSelectionHandoff(state);
    return;
  }
  const existing = takeStagedRuntimeHandoffs(windowId);
  const combined = [...existing, ...pending];
  const retained = combined.slice(0, MAX_RETAINED_SELECTION_HANDOFFS);
  abandonPendingSelectionHandoffs(combined.slice(MAX_RETAINED_SELECTION_HANDOFFS));
  evictStagedRuntimeTargetsForCapacity(retained.length);
  stagedRuntimeHandoffs.set(windowId, {
    pending: retained,
    timeoutId: setTimeout(
      (): void => abandonStagedRuntimeHandoffs(windowId),
      EDITOR_SELECTION_HANDOFF_TTL_MS,
    ),
  });
}

function openFallbackForPending(pending: readonly PendingSelectionHandoff[]): void {
  for (const [index, handoff] of pending.entries()) {
    const fallbackWindowId = handoff.onUnavailable?.();
    if (typeof fallbackWindowId !== "string" || fallbackWindowId.length === 0) {
      handoff.onAbandoned?.();
      continue;
    }
    stageRuntimeHandoffs(fallbackWindowId, pending.slice(index + 1));
    return;
  }
}

function reroutePendingSelectionHandoffs(state: ChatWindowRuntimeState): void {
  const pending = state.pendingSelectionHandoffs.splice(0);
  for (const [index, handoff] of pending.entries()) {
    const routed = routeSelectionHandoffToOpenChat(
      state.runtime.projectPath,
      handoff.id,
      handoff.preferredWindowIds,
      handoff.onUnavailable,
      handoff.onAbandoned,
    );
    if (routed === null) {
      openFallbackForPending(pending.slice(index));
      return;
    }
  }
}

export function routeSelectionHandoffToOpenChat(
  projectPath: string,
  selectionHandoffId: string,
  preferredWindowIds: readonly string[] = [],
  onUnavailable?: (() => string | null | void) | undefined,
  onAbandoned?: (() => void) | undefined,
): string | null {
  for (const windowId of orderedRuntimeIds(preferredWindowIds)) {
    const state = runtimes.get(windowId);
    if (state?.runtime.projectPath !== projectPath) continue;
    if (state.pendingSelectionHandoffs.length >= MAX_RETAINED_SELECTION_HANDOFFS) continue;
    state.pendingSelectionHandoffs.push({
      id: selectionHandoffId,
      preferredWindowIds: [...preferredWindowIds],
      onAbandoned,
      onUnavailable,
    });
    dispatchPendingSelectionHandoff(state);
    return windowId;
  }
  return null;
}

export function usePublishChatWindowRuntime(
  windowId: string,
  target: ChatWindowRuntimeTarget | undefined,
  acceptSelectionHandoff: (selectionHandoffId: string) => void,
  acceptingSelectionHandoff = true,
): void {
  useEffect((): (() => void) | undefined => {
    if (target === undefined) return;
    return registerChatWindowRuntime(windowId, {
      ...target,
      acceptingSelectionHandoff,
      acceptSelectionHandoff,
    });
  }, [acceptSelectionHandoff, acceptingSelectionHandoff, target, windowId]);
}

export function useChatWindowFlows(): ReadonlyMap<string, ChatWindowFlow> {
  return useSyncExternalStore(
    subscribe,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
  );
}
