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

interface ScopedResearchState extends UseCodingWorkbenchResearchInput {
  readonly value: CodingWorkbenchResearchState;
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
    const controller = new AbortController();
    setScoped(scopeResearchState(runId, revision, permissionRequestId, LOADING));
    void (async (): Promise<void> => {
      try {
        await codingAppSessionPairingSettled();
        if (controller.signal.aborted) return;
        const payload = await getCodingWorkbenchRuntimeResearch(runId, controller.signal);
        if (!controller.signal.aborted) {
          setScoped(
            scopeResearchState(runId, revision, permissionRequestId, projectResearchState(payload)),
          );
        }
      } catch {
        if (!controller.signal.aborted) {
          setScoped(
            scopeResearchState(runId, revision, permissionRequestId, {
              status: "unavailable",
              ask: null,
              grant: null,
            }),
          );
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [runId, revision, permissionRequestId]);

  return sameResearchInput(scoped, input) ? scoped.value : inputState(input);
}

function inputState(input: UseCodingWorkbenchResearchInput): CodingWorkbenchResearchState {
  return input.runId === undefined ? IDLE : LOADING;
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
): CodingWorkbenchResearchState {
  return payload.session === "unpaired"
    ? { status: "unavailable", ask: null, grant: null }
    : {
        status: "ready",
        ask: payload.pending ?? null,
        grant: payload.grant ?? null,
      };
}
