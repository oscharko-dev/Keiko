"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";

const MODAL_LOCK_CHANGE_EVENT = "keiko-modal-interaction-lock-change";

interface ModalInteractionLockOptions {
  readonly active?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly restoreFocus?: boolean;
}

function modalInteractionLocked(): boolean {
  return document.documentElement.dataset.keikoModalOpen === "true";
}

function emitModalLockChange(): void {
  window.dispatchEvent(new Event(MODAL_LOCK_CHANGE_EVENT));
}

function subscribeToModalLockChange(onStoreChange: () => void): () => void {
  window.addEventListener(MODAL_LOCK_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(MODAL_LOCK_CHANGE_EVENT, onStoreChange);
}

export function useModalInteractionLockState(): boolean {
  return useSyncExternalStore(subscribeToModalLockChange, modalInteractionLocked, () => false);
}

export function useModalInteractionLock({
  active = true,
  initialFocusRef,
  restoreFocus = true,
}: ModalInteractionLockOptions = {}): void {
  useEffect(() => {
    if (!active) return undefined;
    const root = document.documentElement;
    const trigger = restoreFocus ? (document.activeElement as HTMLElement | null) : null;
    const previousCount = Number(root.dataset.keikoModalOpenCount ?? "0");
    root.dataset.keikoModalOpenCount = String(previousCount + 1);
    root.dataset.keikoModalOpen = "true";
    emitModalLockChange();
    initialFocusRef?.current?.focus();

    return () => {
      const nextCount = Math.max(0, Number(root.dataset.keikoModalOpenCount ?? "1") - 1);
      if (nextCount === 0) {
        delete root.dataset.keikoModalOpenCount;
        delete root.dataset.keikoModalOpen;
      } else {
        root.dataset.keikoModalOpenCount = String(nextCount);
      }
      emitModalLockChange();
      if (restoreFocus) trigger?.focus?.();
    };
  }, [active, initialFocusRef, restoreFocus]);
}
