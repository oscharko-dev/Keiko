"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ChatConnectedScope } from "@/lib/types";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportFilesScopeDecision } from "@/lib/client-diagnostics";

export type ChatWindowFlowIntensity = "light" | "heavy";

export interface ChatWindowFlow {
  readonly flowing: boolean;
  readonly intensity: ChatWindowFlowIntensity;
}

export interface ChatWindowRuntimeTarget {
  readonly conversationId: string;
  readonly projectPath: string;
  readonly connectedScopes?: readonly ChatConnectedScope[];
}

interface ChatWindowRuntimeState {
  readonly runtime: ChatWindowRuntimeTarget;
  readonly registration: symbol;
  readonly prepareClose: (() => Promise<boolean>) | undefined;
  readonly isCloseReady: (() => boolean) | undefined;
  readonly cancelSend: (() => void) | undefined;
}

export type ChatScopeTransition = "pending" | "failed" | undefined;
interface ScopeIntent {
  readonly token: symbol;
  readonly status: "pending" | "failed";
  readonly correlationId: string;
  readonly isCurrent: () => boolean;
}
// Admission state only: canonical source lists and identities remain server-owned.
const scopeIntents = new Map<string, Map<string, ScopeIntent>>();

export function chatScopeTransition(chatId: string | undefined): ChatScopeTransition {
  const intents = chatId === undefined ? undefined : scopeIntents.get(chatId);
  if (intents === undefined || intents.size === 0) return undefined;
  return [...intents.values()].some((intent) => intent.status === "failed") ? "failed" : "pending";
}

export function chatScopeSourceTransition(chatId: string, sourceId: string): ChatScopeTransition {
  return scopeIntents.get(chatId)?.get(sourceId)?.status;
}

export function clearChatScopeTransitions(chatId: string): void {
  if (!scopeIntents.delete(chatId)) return;
  for (const listener of listeners) listener();
}

/** Explicitly forgetting a failed edge retains the server's unchanged canonical sources. */
export function releaseFailedChatScopeTransition(chatId: string, sourceId: string): boolean {
  const intents = scopeIntents.get(chatId);
  const intent = intents?.get(sourceId);
  if (intent?.status === "pending") return false;
  if (intent === undefined || intents === undefined) return true;
  intents.delete(sourceId);
  if (intents.size === 0) scopeIntents.delete(chatId);
  reportFilesScopeDecision(intent.correlationId, { decision: "released" });
  for (const listener of listeners) listener();
  return true;
}

export function releaseObsoleteFailedChatScopeTransitions(): void {
  for (const [chatId, intents] of scopeIntents) {
    for (const [sourceId, intent] of intents) {
      if (intent.status === "failed" && !intent.isCurrent())
        releaseFailedChatScopeTransition(chatId, sourceId);
    }
  }
}

export function refuseChatScopeSend(chatId: string): ChatScopeTransition {
  const transition = chatScopeTransition(chatId);
  const intent = scopeIntents.get(chatId)?.values().next().value;
  if (intent !== undefined)
    reportFilesScopeDecision(intent.correlationId, { decision: "intent-send-refused" });
  return transition;
}

function settleScopeIntent(
  chatId: string,
  sourceId: string,
  intent: ScopeIntent,
  accepted: boolean,
): void {
  const intents = scopeIntents.get(chatId);
  if (intents === undefined || intents.get(sourceId)?.token !== intent.token) return;
  const obsolete = !intent.isCurrent();
  if (accepted || obsolete) intents.delete(sourceId);
  else intents.set(sourceId, { ...intent, status: "failed" });
  if (intents.size === 0) scopeIntents.delete(chatId);
  const decision = accepted ? "intent-applied" : "intent-failed";
  reportFilesScopeDecision(intent.correlationId, {
    decision: obsolete ? "released" : decision,
  });
  for (const listener of listeners) listener();
}

export function beginChatScopeTransition(
  chatId: string,
  sourceId: string,
  isCurrent: () => boolean = (): boolean => true,
): { readonly correlationId: string; readonly settle: (accepted: boolean) => void } {
  const shouldCancel = chatScopeTransition(chatId) === undefined;
  const intent: ScopeIntent = {
    token: Symbol("chat-scope-intent"),
    status: "pending",
    correlationId: newClientCorrelationId(),
    isCurrent,
  };
  const intents = scopeIntents.get(chatId) ?? new Map<string, ScopeIntent>();
  intents.set(sourceId, intent);
  scopeIntents.set(chatId, intents);
  reportFilesScopeDecision(intent.correlationId, { decision: "intent-pending" });
  if (shouldCancel)
    for (const state of runtimes.values())
      if (state.runtime.conversationId === chatId) state.cancelSend?.();
  for (const listener of listeners) listener();
  let settled = false;
  return {
    correlationId: intent.correlationId,
    settle(accepted): void {
      if (settled) return;
      settled = true;
      settleScopeIntent(chatId, sourceId, intent, accepted);
    },
  };
}

export function useChatScopeTransition(
  chat: { readonly id: string } | undefined,
): ChatScopeTransition {
  return useSyncExternalStore(
    subscribe,
    () => chatScopeTransition(chat?.id),
    (): undefined => undefined,
  );
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

let snapshot: ReadonlyMap<string, ChatWindowFlow> = new Map();
const listeners = new Set<() => void>();
let runtimes: ReadonlyMap<string, ChatWindowRuntimeState> = new Map();

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
  runtime: ChatWindowRuntimeTarget,
  prepareClose?: () => Promise<boolean>,
  isCloseReady?: () => boolean,
  cancelSend?: () => void,
): () => void {
  const registration = Symbol("chat-window-runtime");
  runtimes = new Map(runtimes).set(windowId, {
    runtime,
    registration,
    prepareClose,
    isCloseReady,
    cancelSend,
  });
  for (const listener of listeners) listener();
  return (): void => {
    if (runtimes.get(windowId)?.registration !== registration) return;
    const next = new Map(runtimes);
    next.delete(windowId);
    runtimes = next;
    for (const listener of listeners) listener();
  };
}

export function isChatWindowCloseReady(windowId: string): boolean {
  return runtimes.get(windowId)?.isCloseReady?.() ?? true;
}

export function chatWindowCloseGuard(windowId: string): (() => Promise<boolean>) | undefined {
  return runtimes.get(windowId)?.prepareClose;
}

export function chatWindowRuntimeTarget(windowId: string): ChatWindowRuntimeTarget | undefined {
  const state = runtimes.get(windowId);
  return state === undefined
    ? undefined
    : {
        ...state.runtime,
      };
}

export function usePublishChatWindowRuntime(
  windowId: string,
  target: ChatWindowRuntimeTarget | undefined,
  prepareClose?: () => Promise<boolean>,
  isCloseReady?: () => boolean,
  cancelSend?: () => void,
): void {
  useLayoutEffect((): (() => void) | undefined => {
    if (target === undefined) return;
    return registerChatWindowRuntime(windowId, target, prepareClose, isCloseReady, cancelSend);
  }, [target, windowId, prepareClose, isCloseReady, cancelSend]);
}

export function useChatWindowFlows(): ReadonlyMap<string, ChatWindowFlow> {
  return useSyncExternalStore(
    subscribe,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
  );
}

export function useChatWindowRuntimes(): ReadonlyMap<string, ChatWindowRuntimeTarget> {
  const current = useSyncExternalStore(
    subscribe,
    () => runtimes,
    () => runtimes,
  );
  return useMemo(
    () => new Map(Array.from(current, ([id, state]) => [id, state.runtime])),
    [current],
  );
}
