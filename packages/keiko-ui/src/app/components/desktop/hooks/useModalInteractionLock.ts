"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { CLIENT_STAGE_DURATION_MS_MAX } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";

const modalLockListeners = new Set<() => void>();

interface ModalInteractionLockOptions {
  readonly active?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

function emitModalLockChange(): void {
  for (const listener of modalLockListeners) listener();
}

type FocusOutcome = "applied" | "unavailable" | "cancelled";

function startFocusRestoration(): (outcome: FocusOutcome) => void {
  const correlationId = newClientCorrelationId();
  const started = performance.now();
  reportClientDiagnostic("Modal focus restoration started.", {
    correlationId,
    stageReport: { stage: "modal focus restoration", phase: "started", ordinal: 1 },
  });
  return (navigationOutcome): void => {
    reportClientDiagnostic("Modal focus restoration settled.", {
      correlationId,
      stageReport: {
        stage: "modal focus restoration",
        phase: "settled",
        ordinal: 1,
        durationMs: Math.min(
          CLIENT_STAGE_DURATION_MS_MAX,
          Math.max(0, Math.round(performance.now() - started)),
        ),
        navigationOutcome,
      },
    });
  };
}

function focusMovedAway(initialFocus: Element | null, trigger: HTMLElement): boolean {
  const focused = document.activeElement;
  return (
    focused !== initialFocus &&
    focused !== trigger &&
    focused !== document.body &&
    focused?.isConnected === true
  );
}

export function restoreModalTriggerFocus(trigger: HTMLElement | null, remainingFrames = 60): void {
  const settle = startFocusRestoration();
  const initialFocus = document.activeElement;
  const restore = (frames: number): void => {
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected !== true) return settle("unavailable");
      if (focusMovedAway(initialFocus, trigger)) return settle("cancelled");
      if (trigger.closest("[inert]") === null && !trigger.matches(":disabled")) {
        trigger.focus();
        return settle(document.activeElement === trigger ? "applied" : "unavailable");
      }
      if (frames > 1) restore(frames - 1);
      else settle("unavailable");
    });
  };
  restore(remainingFrames);
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
}: ModalInteractionLockOptions = {}): void {
  useEffect(() => {
    if (!active) return undefined;
    const root = document.documentElement;
    const trigger = document.activeElement as HTMLElement | null;
    const previousCount = Number(root.dataset.keikoModalOpenCount ?? "0");
    root.dataset.keikoModalOpenCount = String(previousCount + 1);
    root.dataset.keikoModalOpen = "true";
    emitModalLockChange();
    const initialFocusFrame =
      initialFocusRef === undefined
        ? null
        : window.requestAnimationFrame(() => initialFocusRef.current?.focus());

    return () => {
      if (initialFocusFrame !== null) window.cancelAnimationFrame(initialFocusFrame);
      const nextCount = Math.max(0, Number(root.dataset.keikoModalOpenCount ?? "1") - 1);
      if (nextCount === 0) {
        delete root.dataset.keikoModalOpenCount;
        delete root.dataset.keikoModalOpen;
      } else {
        root.dataset.keikoModalOpenCount = String(nextCount);
      }
      emitModalLockChange();
      restoreModalTriggerFocus(trigger);
    };
  }, [active, initialFocusRef]);
}
