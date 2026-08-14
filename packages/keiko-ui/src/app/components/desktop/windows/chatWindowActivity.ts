"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

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
  readonly acceptSelectionHandoff: (selectionHandoffId: string) => void;
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
const runtimes = new Map<string, ChatWindowRuntime>();

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
  runtimes.set(windowId, runtime);
  return (): void => {
    if (runtimes.get(windowId) === runtime) runtimes.delete(windowId);
  };
}

export function chatWindowRuntimeTarget(windowId: string): ChatWindowRuntimeTarget | undefined {
  const runtime = runtimes.get(windowId);
  return runtime === undefined
    ? undefined
    : { conversationId: runtime.conversationId, projectPath: runtime.projectPath };
}

export function routeSelectionHandoffToOpenChat(
  projectPath: string,
  selectionHandoffId: string,
): string | null {
  for (const [windowId, runtime] of runtimes) {
    if (runtime.projectPath !== projectPath) continue;
    runtimes.delete(windowId);
    runtime.acceptSelectionHandoff(selectionHandoffId);
    return windowId;
  }
  return null;
}

export function usePublishChatWindowRuntime(
  windowId: string,
  target: ChatWindowRuntimeTarget | undefined,
  acceptSelectionHandoff: (selectionHandoffId: string) => void,
): void {
  useEffect((): (() => void) | undefined => {
    if (target === undefined) return;
    return registerChatWindowRuntime(windowId, { ...target, acceptSelectionHandoff });
  }, [acceptSelectionHandoff, target, windowId]);
}

export function useChatWindowFlows(): ReadonlyMap<string, ChatWindowFlow> {
  return useSyncExternalStore(
    subscribe,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
    (): ReadonlyMap<string, ChatWindowFlow> => snapshot,
  );
}
