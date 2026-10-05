"use client";

// The workspace's shared view of `GET /api/health`: the installed version and, since #3532, the Activity
// Log's diagnostic readiness. Read on mount and then every HEALTH_POLL_INTERVAL_MS, so a degraded
// evidence path that appears while the page is open reaches the workspace within one interval (the
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
    let inFlight = false;
    async function readHealth(): Promise<void> {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const health = await fetchHealth();
        if (!cancelled) {
          if (health.diagnosticsInvalid && !failureReported)
            reportClientDiagnostic("[keiko] health diagnostics invalid: TypeError", {
              errorKind: "validation-failed",
            });
          failureReported = health.diagnosticsInvalid === true;
          setBackendHealth((previous) =>
            previous.state === "loaded" &&
            JSON.stringify(previous.health) === JSON.stringify(health)
              ? previous
              : { state: "loaded", health },
          );
        }
      } catch (error) {
        if (cancelled) return;
        // The workspace exposes unavailable readiness instead of retaining stale success.
        // A class-only diagnostic is emitted once per streak, not once per failed poll.
        if (!failureReported) {
          failureReported = true;
          reportClientDiagnostic(`[keiko] health read failed: ${clientErrorSummary(error)}`, {
            correlationId: correlationIdOf(error),
          });
        }
        setBackendHealth((previous) =>
          previous.state === "unavailable" ? previous : { state: "unavailable" },
        );
      } finally {
        inFlight = false;
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
