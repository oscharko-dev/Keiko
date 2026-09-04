"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CodingWorkbenchRuntimePendingResearch,
  CodingWorkbenchRuntimeResearchChannelPayload,
  CodingWorkbenchRuntimeResearchGrant,
} from "@oscharko-dev/keiko-contracts";

import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { getCodingWorkbenchRuntimeResearch } from "./coding-workbench-runtime-api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";

export type CodingWorkbenchResearchStatus = "idle" | "loading" | "ready" | "unavailable";

export interface CodingWorkbenchResearchState {
  readonly status: CodingWorkbenchResearchStatus;
  readonly ask: CodingWorkbenchRuntimePendingResearch | null;
  readonly grant: CodingWorkbenchRuntimeResearchGrant | null;
}

export interface UseCodingWorkbenchResearchResult extends CodingWorkbenchResearchState {
  /**
   * Re-reads the research channel on demand, without waiting for `runId`/`revision`/
   * `permissionRequestId` to change (workbench audit, 2026-09-03) — the operator's only recourse after a
   * transient failure while a `network-egress` approval decision is still open, mirroring
   * `useCodingWorkbenchChanges`/`useCodingWorkbenchQuestions`.
   */
  readonly retry: () => void;
}

export interface UseCodingWorkbenchResearchInput {
  readonly runId: string | undefined;
  /** The runtime revision changes whenever an approved grant is minted or revoked. */
  readonly revision: number | undefined;
  /** Drives a refetch when a new pending ask replaces an old one. */
  readonly permissionRequestId: string | undefined;
}

const IDLE: CodingWorkbenchResearchState = { status: "idle", ask: null, grant: null };
const LOADING: CodingWorkbenchResearchState = { status: "loading", ask: null, grant: null };
const UNAVAILABLE: CodingWorkbenchResearchState = { status: "unavailable", ask: null, grant: null };
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ScopedResearchState extends UseCodingWorkbenchResearchInput {
  readonly value: CodingWorkbenchResearchState;
}

interface ActiveResearchInput extends UseCodingWorkbenchResearchInput {
  readonly runId: string;
}

/**
 * Reads all model-selected research state from its one authenticated channel (#2387, #2644). The
 * general runtime snapshot remains structurally unable to carry either proposed or approved hosts.
 */
export function useCodingWorkbenchResearch(
  input: UseCodingWorkbenchResearchInput,
): UseCodingWorkbenchResearchResult {
  const { runId, revision, permissionRequestId } = input;
  const [scoped, setScoped] = useState<ScopedResearchState>(() =>
    scopeResearchState(runId, revision, permissionRequestId, inputState(input)),
  );
  // Bumped only by `retry()`; not read inside the effect. Its sole job is to force the effect
  // below to re-run — including its `setScoped(...LOADING)` — on demand.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);

  useEffect(() => {
    if (runId === undefined) {
      setScoped(scopeResearchState(runId, revision, permissionRequestId, IDLE));
      return;
    }
    setScoped(scopeResearchState(runId, revision, permissionRequestId, LOADING));
    return startResearchSync({ runId, revision, permissionRequestId }, setScoped);
  }, [runId, revision, permissionRequestId, epoch]);

  const value = sameResearchInput(scoped, input) ? scoped.value : inputState(input);
  return { ...value, retry };
}

function startResearchSync(
  input: ActiveResearchInput,
  publish: (state: ScopedResearchState) => void,
): () => void {
  const controller = new AbortController();
  const pairingSettled = codingAppSessionPairingSettled();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(): Promise<void> {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    try {
      await pairingSettled;
      if (controller.signal.aborted) return;
      const payload = await getCodingWorkbenchRuntimeResearch(input.runId, controller.signal);
      if (controller.signal.aborted) return;
      const nowMs = Date.now();
      publish(
        scopeResearchStateFromInput(
          input,
          projectResearchState(payload, nowMs, input.permissionRequestId),
        ),
      );
      expiryTimer = scheduleResearchRefresh(input, payload, nowMs, publish, refresh);
    } catch (error) {
      if (!controller.signal.aborted) {
        // Same bounded console idiom as GEN-STAB-WINDOW-002: the rendered state stays the
        // content-free "unavailable", but the underlying refresh failure remains diagnosable.
        reportClientDiagnostic(
          `[keiko] research channel refresh failed: ${clientErrorSummary(error)}`,
          { correlationId: correlationIdOf(error) },
        );
        publish(scopeResearchStateFromInput(input, UNAVAILABLE));
      }
    }
  }

  void refresh();
  return (): void => {
    controller.abort();
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  };
}

function scheduleResearchRefresh(
  input: ActiveResearchInput,
  payload: CodingWorkbenchRuntimeResearchChannelPayload,
  nowMs: number,
  publish: (state: ScopedResearchState) => void,
  refresh: () => Promise<void>,
): ReturnType<typeof setTimeout> | undefined {
  const delayMs = researchRefreshDelay(payload, nowMs);
  if (delayMs === undefined) return undefined;
  return setTimeout(() => {
    publish(
      scopeResearchStateFromInput(
        input,
        projectResearchState(payload, Date.now(), input.permissionRequestId),
      ),
    );
    void refresh();
  }, delayMs);
}

function inputState(input: UseCodingWorkbenchResearchInput): CodingWorkbenchResearchState {
  return input.runId === undefined ? IDLE : LOADING;
}

function scopeResearchStateFromInput(
  input: UseCodingWorkbenchResearchInput,
  value: CodingWorkbenchResearchState,
): ScopedResearchState {
  return scopeResearchState(input.runId, input.revision, input.permissionRequestId, value);
}

function scopeResearchState(
  runId: string | undefined,
  revision: number | undefined,
  permissionRequestId: string | undefined,
  value: CodingWorkbenchResearchState,
): ScopedResearchState {
  return {
    runId,
    revision,
    permissionRequestId,
    value,
  };
}

function sameResearchInput(
  left: UseCodingWorkbenchResearchInput,
  right: UseCodingWorkbenchResearchInput,
): boolean {
  return (
    left.runId === right.runId &&
    left.revision === right.revision &&
    left.permissionRequestId === right.permissionRequestId
  );
}

/**
 * The channel read and the runtime snapshot advance independently, so a read issued while the card
 * was deciding P1 can be answered with the P2 ask the server has since moved on to. Published under
 * P1's id it renders P2's host and request line beside P1's approve/deny controls (#3381 review) —
 * the scoping in `useCodingWorkbenchResearch` cannot see it, because the input never changed, only
 * the answer did. A carried ask therefore has to name the request being decided, or the whole state
 * is the honest `unavailable`.
 *
 * An ABSENT ask is not a mismatch: it is the server having resolved or expired the request, which
 * the expiry revalidation ("revalidates each expiry and never retains server-expired research
 * state") must keep reporting as `ready` with a null ask so a live grant stays visible.
 */
function projectResearchState(
  payload: CodingWorkbenchRuntimeResearchChannelPayload,
  nowMs: number,
  expectedRequestId: string | undefined,
): CodingWorkbenchResearchState {
  if (payload.session === "unpaired") return UNAVAILABLE;
  if (mismatchedAsk(payload.pending, expectedRequestId)) return UNAVAILABLE;
  return {
    status: "ready",
    ask: liveUntil(payload.pending, nowMs),
    grant: liveUntil(payload.grant, nowMs),
  };
}

function mismatchedAsk(
  pending: CodingWorkbenchRuntimePendingResearch | undefined,
  expectedRequestId: string | undefined,
): boolean {
  if (pending === undefined || expectedRequestId === undefined) return false;
  return pending.requestId !== expectedRequestId;
}

function liveUntil<T extends { readonly expiresAt: string }>(
  value: T | undefined,
  nowMs: number,
): T | null {
  if (value === undefined) return null;
  const expiresAtMs = Date.parse(value.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs ? value : null;
}

function researchRefreshDelay(
  payload: CodingWorkbenchRuntimeResearchChannelPayload,
  nowMs: number,
): number | undefined {
  if (payload.session === "unpaired") return undefined;
  const expiries = [payload.pending?.expiresAt, payload.grant?.expiresAt]
    .map((value) => (value === undefined ? Number.NaN : Date.parse(value)))
    .filter((value) => Number.isFinite(value) && value > nowMs);
  const nextExpiryMs = Math.min(...expiries);
  return Number.isFinite(nextExpiryMs)
    ? Math.min(MAX_TIMER_DELAY_MS, Math.max(1, nextExpiryMs - nowMs + 1))
    : undefined;
}
