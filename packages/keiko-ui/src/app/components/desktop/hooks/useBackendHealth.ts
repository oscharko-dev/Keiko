"use client";

// The footer's view of `GET /api/health`: the installed version and, since #3532, the Activity
// Log's diagnostic readiness. Read on mount and then every HEALTH_POLL_INTERVAL_MS, so a degraded
// evidence path that appears while the page is open reaches the footer within one interval (the
// server re-evaluates readiness on its own heartbeat). Lives in its own module for the same reason
// as `useUnhandledRejectionLog`: the shell's test suites mock sibling component files wholesale.

import { useEffect, useState } from "react";
import { fetchHealth, type HealthSnapshot } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";

export const HEALTH_POLL_INTERVAL_MS = 60_000;

export type BackendHealth =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | { readonly state: "loaded"; readonly health: HealthSnapshot };

export function useBackendHealth(): BackendHealth {
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    let failureReported = false;
    async function readHealth(): Promise<void> {
      try {
        const health = await fetchHealth();
        failureReported = false;
        if (!cancelled) setBackendHealth({ state: "loaded", health });
      } catch (error) {
        // The footer shows the version as unavailable and drops a readiness it can no longer vouch
        // for. The failure is reported once per failure streak, by class only: a stopped server
        // must not turn into one diagnostic per poll.
        if (!failureReported) {
          failureReported = true;
          reportClientDiagnostic(`[keiko] health read failed: ${clientErrorSummary(error)}`, {
            correlationId: correlationIdOf(error),
          });
        }
        if (!cancelled) setBackendHealth({ state: "unavailable" });
      }
    }
    void readHealth();
    const timer = window.setInterval(() => {
      void readHealth();
    }, HEALTH_POLL_INTERVAL_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return backendHealth;
}
