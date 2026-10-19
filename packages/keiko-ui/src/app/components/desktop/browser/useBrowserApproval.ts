"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import type { BrowserApprovalRequestDescriptor } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  createLocalBrowserApprovalClient,
  type BrowserApprovalAttempt,
  type BrowserApprovalClient,
  type BrowserApprovalCompletion,
} from "@/lib/browser-approval-client";

type ActiveCompletion = Extract<BrowserApprovalCompletion, { state: "active" }>;
type BrowserApprovalView =
  | { readonly phase: "idle" | "working" | "unavailable" | "expired" }
  | { readonly phase: "pending" | "failed"; readonly request: BrowserApprovalRequestDescriptor }
  | ({ readonly phase: "active" } & Omit<ActiveCompletion, "state">);

interface AttemptState {
  readonly attempt: BrowserApprovalAttempt;
  readonly deadline: number;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject): void => {
    const cancel = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout((): void => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 2_000);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function pollAttempt(
  client: BrowserApprovalClient,
  current: AttemptState,
  signal: AbortSignal,
  publish: (view: BrowserApprovalView) => void,
): Promise<void> {
  try {
    while (!signal.aborted) {
      const result = await client.complete(current.attempt, signal);
      signal.throwIfAborted();
      if (result.state === "active") {
        publish({ phase: "active", persistence: result.persistence });
        return;
      }
      if (result.state === "unavailable" || performance.now() >= current.deadline) {
        publish({ phase: performance.now() >= current.deadline ? "expired" : "unavailable" });
        return;
      }
      await waitForPoll(signal);
    }
  } catch (error) {
    if (signal.aborted) return;
    reportClientDiagnostic("Browser approval polling stopped.", {
      correlationId: current.attempt.correlationId,
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    publish({ phase: "failed", request: current.attempt.request });
  }
}

export interface BrowserApprovalController {
  readonly view: BrowserApprovalView;
  readonly begin: (remember: boolean) => Promise<void>;
  readonly retry: () => Promise<void>;
}

function useApprovalCleanup(
  active: RefObject<AbortController | undefined>,
  attempt: RefObject<AttemptState | undefined>,
  client: RefObject<BrowserApprovalClient | undefined>,
): void {
  useEffect(
    () => (): void => {
      active.current?.abort();
      attempt.current = undefined;
      client.current = undefined;
    },
    [active, attempt, client],
  );
}

/** The attempt key lives only in this mounted controller; cancellation cannot publish stale work. */
export function useBrowserApproval(): BrowserApprovalController {
  const [view, setView] = useState<BrowserApprovalView>({ phase: "idle" });
  const client = useRef<BrowserApprovalClient | undefined>(undefined);
  const attempt = useRef<AttemptState | undefined>(undefined);
  const active = useRef<AbortController | undefined>(undefined);
  useApprovalCleanup(active, attempt, client);
  const begin = useCallback(async (remember: boolean): Promise<void> => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    attempt.current = undefined;
    setView({ phase: "working" });
    const started = performance.now();
    try {
      client.current ??= createLocalBrowserApprovalClient();
      const pending = await client.current.begin(remember, controller.signal);
      controller.signal.throwIfAborted();
      if (pending === undefined) {
        setView({ phase: "unavailable" });
        return;
      }
      const duration = pending.request.expiresAtMs - pending.request.requestedAtMs;
      const current = { attempt: pending, deadline: started + duration };
      attempt.current = current;
      setView({ phase: "pending", request: pending.request });
      await pollAttempt(client.current, current, controller.signal, setView);
    } catch (error) {
      if (controller.signal.aborted) return;
      reportClientDiagnostic("Browser approval request could not complete.", {
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
      setView({ phase: "unavailable" });
    }
  }, []);
  const retry = useCallback(async (): Promise<void> => {
    const current = attempt.current;
    if (current === undefined || client.current === undefined) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setView({ phase: "pending", request: current.attempt.request });
    await pollAttempt(client.current, current, controller.signal, setView);
  }, []);
  return { view, begin, retry };
}
