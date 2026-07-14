"use client";

import { useEffect, type RefObject } from "react";

interface ModalInteractionLockOptions {
  readonly active?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly restoreFocus?: boolean;
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
    initialFocusRef?.current?.focus();

    return () => {
      const nextCount = Math.max(0, Number(root.dataset.keikoModalOpenCount ?? "1") - 1);
      if (nextCount === 0) {
        delete root.dataset.keikoModalOpenCount;
        delete root.dataset.keikoModalOpen;
      } else {
        root.dataset.keikoModalOpenCount = String(nextCount);
      }
      if (restoreFocus) trigger?.focus?.();
    };
  }, [active, initialFocusRef, restoreFocus]);
}
