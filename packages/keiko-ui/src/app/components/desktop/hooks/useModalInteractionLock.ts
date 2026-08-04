"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";

const modalLockListeners = new Set<() => void>();

interface ModalInteractionLockOptions {
  readonly active?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly restoreFocus?: boolean;
}

function emitModalLockChange(): void {
  for (const listener of modalLockListeners) listener();
}

export function restoreModalTriggerFocus(trigger: HTMLElement | null): void {
  if (trigger?.isConnected !== true) return;
  const startedAt = performance.now();
  const attempt = (): void => {
    if (!trigger.isConnected) return;
    if (trigger.closest("[inert]") === null) {
      trigger.focus();
      if (document.activeElement === trigger) return;
    }
    if (performance.now() - startedAt < 1_000) window.requestAnimationFrame(attempt);
  };
  attempt();
}

export function useModalInteractionLockState(): boolean {
  return useSyncExternalStore(
    (onStoreChange): (() => void) => {
      modalLockListeners.add(onStoreChange);
      return () => {
        modalLockListeners.delete(onStoreChange);
      };
    },
    () => document.documentElement.dataset.keikoModalOpen === "true",
    () => false,
  );
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
      if (restoreFocus) restoreModalTriggerFocus(trigger);
    };
  }, [active, initialFocusRef, restoreFocus]);
}
