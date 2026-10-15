"use client";

import { useCallback, useEffect, useMemo, useRef, useReducer } from "react";
import { useCodingAppSessionRedemptions } from "@/lib/coding-app-session-client";
import { ChatDraftController, type DraftPhase } from "./chat-draft-controller";

export interface ChatDraftPersistence {
  readonly phase: DraftPhase;
  readonly pending: boolean;
  readonly retry: () => Promise<void>;
  readonly prepareClose: () => Promise<boolean>;
  readonly isCloseReady: () => boolean;
  readonly keepLocal: () => Promise<void>;
  readonly restoreSaved: () => Promise<void>;
}
interface ChatDraftState {
  readonly text: string;
  readonly setText: (text: string) => void;
  readonly persistence: ChatDraftPersistence;
  readonly controller: ChatDraftController;
}

function useDraftController(onReplace: (() => void) | undefined): ChatDraftController {
  const replacement = useRef(onReplace);
  replacement.current = onReplace;
  const [, update] = useReducer((revision: number): number => revision + 1, 0);
  const mounted = useRef(false);
  const controllerRef = useRef<ChatDraftController | null>(null);
  controllerRef.current ??= new ChatDraftController(
    () => {
      if (mounted.current) update();
    },
    () => replacement.current?.(),
  );
  const controller = controllerRef.current;
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      controller.flush();
    };
  }, [controller]);
  return controller;
}

export function useChatDraft(chatId: string | undefined, onReplace?: () => void): ChatDraftState {
  const controller = useDraftController(onReplace);
  const redemptions = useCodingAppSessionRedemptions();
  const key = chatId ?? "";
  const entry = controller.entry(key);
  const setText = useCallback(
    (text: string): void => controller.setText(key, text),
    [controller, key],
  );
  const retry = useCallback(async (): Promise<void> => {
    if (chatId !== undefined) await controller.refresh(chatId);
  }, [chatId, controller]);
  const keepLocal = useCallback(async (): Promise<void> => {
    if (chatId !== undefined) await controller.keepLocal(chatId);
  }, [chatId, controller]);
  const restoreSaved = useCallback(async (): Promise<void> => {
    if (chatId !== undefined) await controller.restoreSaved(chatId);
  }, [chatId, controller]);
  useEffect(() => {
    void retry();
    window.addEventListener("focus", retry);
    return (): void => window.removeEventListener("focus", retry);
  }, [retry, redemptions]);
  const prepareClose = useCallback((): Promise<boolean> => controller.prepareClose(), [controller]);
  const isCloseReady = useCallback((): boolean => !controller.hasUnsaved(), [controller]);
  const persistence = useMemo(
    () => ({
      phase: entry.phase,
      pending: entry.pending,
      retry,
      keepLocal,
      restoreSaved,
      prepareClose,
      isCloseReady,
    }),
    [entry.phase, entry.pending, retry, keepLocal, restoreSaved, prepareClose, isCloseReady],
  );
  return { text: entry.text, setText, persistence, controller };
}

/** A private save must be acknowledged before leaving; staged attachments remain transient. */
export function useChatDraftUnloadGuard(
  controller: ChatDraftController,
  attachments: number,
): void {
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!controller.hasUnsaved() && attachments === 0) return;
      controller.flush();
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return (): void => window.removeEventListener("beforeunload", beforeUnload);
  }, [controller, attachments]);
}
