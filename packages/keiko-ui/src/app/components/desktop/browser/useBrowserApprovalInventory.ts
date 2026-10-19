"use client";

import { useCallback, useEffect, useState } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import type { BrowserApprovalManagementResult } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { inspectBrowserApprovals } from "@/lib/browser-approval-api";
import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
  useCodingAppSessionChecks,
} from "@/lib/coding-app-session-client";

export interface BrowserApprovalInventory {
  readonly result: BrowserApprovalManagementResult | undefined;
  readonly failed: boolean;
  readonly refresh: () => void;
}

/** Every authentication decision comes from a fresh protected server read. */
export function useBrowserApprovalInventory(poll = false): BrowserApprovalInventory {
  const [result, setResult] = useState<BrowserApprovalManagementResult>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const redemptions = useCodingAppSessionRedemptions();
  const checks = useCodingAppSessionChecks();
  const refresh = useCallback((): void => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        await codingAppSessionPairingSettled(controller.signal);
        const current = await inspectBrowserApprovals(controller.signal);
        controller.signal.throwIfAborted();
        setResult(current);
        setFailed(false);
      } catch (error) {
        if (!controller.signal.aborted) {
          reportClientDiagnostic("Browser approval inventory unavailable.", {
            errorKind: bffRequestErrorKind(error),
            errorEvidence: clientErrorEvidence(error),
          });
          setFailed(true);
        }
      } finally {
        if (poll && !controller.signal.aborted)
          timer = setTimeout(() => {
            void load();
          }, 5_000);
      }
    };
    void load();
    window.addEventListener("focus", refresh);
    return (): void => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [revision, redemptions, checks, poll, refresh]);
  return { result, failed, refresh };
}
