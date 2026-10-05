"use client";

// The workspace's shared view of `GET /api/health`: the installed version and, since #3532, the Activity
// Log's diagnostic readiness. Read on mount and then every HEALTH_POLL_INTERVAL_MS, so a degraded
// evidence path that appears while the page is open reaches the workspace within one interval (the
// server re-evaluates readiness on its own heartbeat). Lives in its own module for the same reason
// as `useUnhandledRejectionLog`: the shell's test suites mock sibling component files wholesale.

import { useEffect, useState } from "react";
import type { ClientOnlySupportReportInput } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { fetchHealth, type HealthSnapshot } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { newClientCorrelationId, responseCorrelationIdOf } from "@/lib/bff-correlation";
import { bffRequestErrorKind } from "@/lib/http";

export const HEALTH_POLL_INTERVAL_MS = 60_000;

interface HealthReport {
  readonly correlationId?: string;
  readonly failure?: ClientOnlySupportReportInput["failure"];
}

export type BackendHealth =
  | { readonly state: "loading" }
  | { readonly state: "unavailable"; readonly report?: HealthReport }
  | { readonly state: "loaded"; readonly health: HealthSnapshot; readonly report?: HealthReport };

interface HealthPoll {
  cancelled: boolean;
  inFlight: boolean;
  failedPolls: number;
  failureReport: HealthReport | undefined;
  invalidReport: HealthReport | undefined;
  degradedReport: HealthReport | undefined;
}

type PublishHealth = (update: (previous: BackendHealth) => BackendHealth) => void;

function recordHealthFailure(error: unknown, correlationId: string): HealthReport {
  const errorKind = bffRequestErrorKind(error);
  const errorEvidence = clientErrorEvidence(error);
  reportClientDiagnostic(`[keiko] health read failed: ${clientErrorSummary(error)}`, {
    correlationId,
    errorKind,
    errorEvidence,
  });
  return { correlationId, failure: { errorKind, errorEvidence, context: [] } };
}

function recordInvalidHealth(health: HealthSnapshot, correlationId: string): HealthReport {
  const healthDiagnosticsInvalidReason = health.diagnosticsInvalidReason ?? "snapshot-shape";
  reportClientDiagnostic("[keiko] health diagnostics failed validation", {
    correlationId,
    errorKind: "validation-failed",
    healthDiagnosticsInvalidReason,
  });
  return { correlationId, failure: { errorKind: "validation-failed", context: [] } };
}

function observedHealthReport(
  poll: HealthPoll,
  health: HealthSnapshot,
  correlationId: string,
): HealthReport | undefined {
  poll.failedPolls = 0;
  poll.failureReport = undefined;
  if (health.diagnosticsInvalid) {
    poll.invalidReport ??= recordInvalidHealth(
      health,
      responseCorrelationIdOf(health) ?? correlationId,
    );
    return poll.invalidReport;
  }
  poll.invalidReport = undefined;
  if (health.diagnostics !== undefined && health.diagnostics.readiness !== "ready") {
    // The successful health read did not cause the degraded writer. Let the existing report
    // owner select recent failure/incident evidence, including uncorrelated readiness lines.
    poll.degradedReport ??= {};
    return poll.degradedReport;
  }
  poll.degradedReport = undefined;
  return undefined;
}

function recordHealthReadFailure(
  poll: HealthPoll,
  publish: PublishHealth,
  error: unknown,
  requestCorrelationId: string,
): void {
  poll.failureReport ??= recordHealthFailure(error, correlationIdOf(error) ?? requestCorrelationId);
  poll.failedPolls += 1;
  const confirmedOutage = poll.failedPolls >= 2;
  const report = poll.failureReport;
  publish((previous) => {
    if (previous.state === "unavailable") return previous;
    if (previous.state === "loaded" && !confirmedOutage) return previous;
    return { state: "unavailable", report };
  });
}

async function readBackendHealth(poll: HealthPoll, publish: PublishHealth): Promise<void> {
  if (poll.inFlight || poll.cancelled) return;
  poll.inFlight = true;
  const correlationId = newClientCorrelationId();
  try {
    const health = await fetchHealth(correlationId);
    if (poll.cancelled) return;
    const report = observedHealthReport(poll, health, correlationId);
    publish((previous) =>
      previous.state === "loaded" && JSON.stringify(previous.health) === JSON.stringify(health)
        ? previous
        : { state: "loaded", health, ...(report === undefined ? {} : { report }) },
    );
  } catch (error) {
    if (!poll.cancelled) recordHealthReadFailure(poll, publish, error, correlationId);
  } finally {
    poll.inFlight = false;
  }
}

export function useBackendHealth(): BackendHealth {
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ state: "loading" });
  useEffect(() => {
    const poll: HealthPoll = {
      cancelled: false,
      inFlight: false,
      failedPolls: 0,
      failureReport: undefined,
      invalidReport: undefined,
      degradedReport: undefined,
    };
    void readBackendHealth(poll, setBackendHealth);
    const timer = window.setInterval(() => {
      void readBackendHealth(poll, setBackendHealth);
    }, HEALTH_POLL_INTERVAL_MS);
    return (): void => {
      poll.cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return backendHealth;
}
