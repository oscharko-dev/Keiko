"use client";

// The footer's view of `GET /api/health`: the installed version and, since #3532, the Activity
// Log's diagnostic readiness. Read on mount and then every HEALTH_POLL_INTERVAL_MS, so a degraded
// evidence path that appears while the page is open reaches the footer within one interval (the
// server re-evaluates readiness on its own heartbeat). Lives in its own module for the same reason
// as `useUnhandledRejectionLog`: the shell's test suites mock sibling component files wholesale.

import { useEffect, useState } from "react";
import { fetchHealth, type HealthSnapshot } from "@/lib/api";

export const HEALTH_POLL_INTERVAL_MS = 60_000;

export type BackendHealth =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | { readonly state: "loaded"; readonly health: HealthSnapshot };

export function useBackendHealth(): BackendHealth {
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    async function readHealth(): Promise<void> {
      try {
        const health = await fetchHealth();
        if (!cancelled) setBackendHealth({ state: "loaded", health });
      } catch {
        // A failed read is itself the visible outcome: the footer shows the version as
        // unavailable and no readiness it can no longer vouch for.
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
