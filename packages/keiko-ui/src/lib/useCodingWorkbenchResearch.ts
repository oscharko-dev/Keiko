"use client";

import { useEffect, useState } from "react";
import type {
  CodingWorkbenchRuntimePendingResearch,
  CodingWorkbenchRuntimeResearchChannelPayload,
  CodingWorkbenchRuntimeResearchGrant,
} from "@oscharko-dev/keiko-contracts";

import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { getCodingWorkbenchRuntimeResearch } from "./coding-workbench-runtime-api";

export type CodingWorkbenchResearchStatus = "idle" | "loading" | "ready" | "unavailable";

export interface CodingWorkbenchResearchState {
  readonly status: CodingWorkbenchResearchStatus;
  readonly ask: CodingWorkbenchRuntimePendingResearch | null;
  readonly grant: CodingWorkbenchRuntimeResearchGrant | null;
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
): CodingWorkbenchResearchState {
  const { runId, revision, permissionRequestId } = input;
  const [scoped, setScoped] = useState<ScopedResearchState>(() =>
    scopeResearchState(runId, revision, permissionRequestId, inputState(input)),
  );

  useEffect(() => {
    if (runId === undefined) {
      setScoped(scopeResearchState(runId, revision, permissionRequestId, IDLE));
      return;
    }
    setScoped(scopeResearchState(runId, revision, permissionRequestId, LOADING));
    return startResearchSync({ runId, revision, permissionRequestId }, setScoped);
  }, [runId, revision, permissionRequestId]);

  return sameResearchInput(scoped, input) ? scoped.value : inputState(input);
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
      publish(scopeResearchStateFromInput(input, projectResearchState(payload, nowMs)));
      expiryTimer = scheduleResearchRefresh(input, payload, nowMs, publish, refresh);
    } catch {
      if (!controller.signal.aborted) {
        publish(
          scopeResearchStateFromInput(input, {
            status: "unavailable",
            ask: null,
            grant: null,
          }),
        );
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
    publish(scopeResearchStateFromInput(input, projectResearchState(payload, Date.now())));
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

function projectResearchState(
  payload: CodingWorkbenchRuntimeResearchChannelPayload,
  nowMs: number,
): CodingWorkbenchResearchState {
  return payload.session === "unpaired"
    ? { status: "unavailable", ask: null, grant: null }
    : {
        status: "ready",
        ask: liveUntil(payload.pending, nowMs),
        grant: liveUntil(payload.grant, nowMs),
      };
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
