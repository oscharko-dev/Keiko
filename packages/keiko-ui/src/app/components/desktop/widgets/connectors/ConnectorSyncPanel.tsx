// Issue #2245 (Epic #2238, ADR-0128 D5) — per-connector sync surface.
//
// Triggers a human-initiated sync for the selected scope, polls the job to terminal state (live
// progress updates, mirroring the memory-consolidation poll convention used elsewhere in the BFF),
// supports cancellation, and renders the terminal change summary plus degradation remediation copy
// keyed to the backend failure reason codes. Presentation reuses the #1856 pod-refresh atoms.

"use client";

import { useEffect, useState, type ReactNode } from "react";
import type {
  AtlassianConnectorProvider,
  AtlassianSyncChangeSummary,
  AtlassianSyncFailureReason,
  AtlassianSyncJobState,
} from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import type {
  AtlassianConnectorsClient,
  StartAtlassianSyncInput,
} from "@/lib/atlassian-connectors-api";
import { ConnectorScopeForm, type ConnectorScopeValue } from "./ConnectorScopeForm";
import {
  JobStatusBadge,
  SyncChangeCounts,
  SyncDegradation,
  SyncProgressCounts,
} from "./sync-summary";

export type SyncClient = Pick<
  AtlassianConnectorsClient,
  "startSync" | "getSyncJob" | "cancelSyncJob"
>;

interface TerminalDetails {
  readonly changeSummary?: AtlassianSyncChangeSummary;
  readonly reasons: readonly AtlassianSyncFailureReason[];
}

function terminalDetails(job: AtlassianSyncJobState): TerminalDetails {
  if (job.status === "succeeded" || job.status === "cancelled") {
    return { changeSummary: job.changeSummary, reasons: [] };
  }
  if (job.status === "partial") {
    return { changeSummary: job.changeSummary, reasons: job.failureReasons };
  }
  if (job.status === "failed") {
    return { changeSummary: job.changeSummary, reasons: [job.failureReason] };
  }
  return { reasons: [] };
}

function isRunning(job: AtlassianSyncJobState | undefined): boolean {
  return job !== undefined && (job.status === "pending" || job.status === "running");
}

function scopeToInput(
  provider: AtlassianConnectorProvider,
  scope: ConnectorScopeValue,
): StartAtlassianSyncInput {
  if (provider === "confluence") return { spaceKeys: scope.keys };
  const trimmed = scope.jql.trim();
  return { projectKeys: scope.keys, ...(trimmed.length > 0 ? { jql: trimmed } : {}) };
}

interface SyncController {
  readonly job: AtlassianSyncJobState | undefined;
  readonly busy: boolean;
  readonly cancelling: boolean;
  readonly error: string | undefined;
  readonly canStart: boolean;
  readonly start: () => void;
  readonly cancel: () => void;
  readonly onScopeChange: (value: ConnectorScopeValue) => void;
}

function useSyncJob(
  client: SyncClient,
  authRef: string,
  provider: AtlassianConnectorProvider,
  pollIntervalMs: number,
): SyncController {
  const t = useTranslate();
  const [scope, setScope] = useState<ConnectorScopeValue>({ keys: [], jql: "" });
  const [job, setJob] = useState<AtlassianSyncJobState | undefined>();
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const fail = (caught: unknown): void => {
    setError(caught instanceof ApiError ? caught.message : t("atlassianConnectors.retry"));
  };
  useEffect(() => {
    if (!isRunning(job) || job === undefined) return;
    let active = true;
    const timer = setTimeout(() => {
      client
        .getSyncJob(job.jobId)
        .then((next) => {
          if (active) setJob(next.job);
        })
        .catch(() => undefined);
    }, pollIntervalMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job, client, pollIntervalMs]);
  const start = (): void => {
    if (scope.keys.length === 0) return setError(t("atlassianConnectors.scope.empty"));
    setBusy(true);
    setError(undefined);
    client
      .startSync(authRef, scopeToInput(provider, scope))
      .then((result) => setJob(result.job))
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const cancel = (): void => {
    if (job === undefined) return;
    setCancelling(true);
    client
      .cancelSyncJob(job.jobId)
      .then((result) => setJob(result.job))
      .catch(fail)
      .finally(() => setCancelling(false));
  };
  return {
    job,
    busy,
    cancelling,
    error,
    // Enabled unless a run is in flight, so a start with no keys yields the actionable
    // "add at least one key" feedback rather than a silently inert control.
    canStart: !busy && !isRunning(job),
    start,
    cancel,
    onScopeChange: setScope,
  };
}

function SyncJobView({ job }: { readonly job: AtlassianSyncJobState }): ReactNode {
  const t = useTranslate();
  const details = terminalDetails(job);
  return (
    <div className="acx-section" data-testid="acx-sync-job" data-status={job.status}>
      <div className="acx-badge-row">
        <span className="acx-label">{t("atlassianConnectors.sync.statusLabel")}</span>
        <JobStatusBadge status={job.status} />
      </div>
      <p className="acx-section-title">{t("atlassianConnectors.sync.progressTitle")}</p>
      <SyncProgressCounts progress={job.progress} />
      {details.changeSummary !== undefined ? (
        <>
          <p className="acx-section-title">{t("atlassianConnectors.sync.changesTitle")}</p>
          <SyncChangeCounts counts={details.changeSummary.counts} />
        </>
      ) : null}
      <SyncDegradation reasons={details.reasons} />
    </div>
  );
}

export interface ConnectorSyncPanelProps {
  readonly client: SyncClient;
  readonly authRef: string;
  readonly provider: AtlassianConnectorProvider;
  readonly pollIntervalMs?: number;
}

export function ConnectorSyncPanel({
  client,
  authRef,
  provider,
  pollIntervalMs = 1500,
}: ConnectorSyncPanelProps): ReactNode {
  const t = useTranslate();
  const ctrl = useSyncJob(client, authRef, provider, pollIntervalMs);
  return (
    <div className="acx-section" data-testid="acx-sync">
      <ConnectorScopeForm provider={provider} onChange={ctrl.onScopeChange} />
      <div className="acx-actions">
        <button
          type="button"
          className="lk-btn lk-btn-primary"
          onClick={ctrl.start}
          disabled={!ctrl.canStart}
        >
          {ctrl.busy ? t("atlassianConnectors.sync.starting") : t("atlassianConnectors.sync.start")}
        </button>
        {isRunning(ctrl.job) ? (
          <button
            type="button"
            className="lk-btn lk-btn-danger"
            onClick={ctrl.cancel}
            disabled={ctrl.cancelling}
          >
            {ctrl.cancelling
              ? t("atlassianConnectors.sync.cancelling")
              : t("atlassianConnectors.sync.cancel")}
          </button>
        ) : null}
      </div>
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      <div role="status" aria-live="polite" data-testid="acx-sync-live">
        {ctrl.job !== undefined ? <SyncJobView job={ctrl.job} /> : null}
      </div>
    </div>
  );
}
