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

/**
 * Reads all model-selected research state from its one authenticated channel (#2387, #2644). The
 * general runtime snapshot remains structurally unable to carry either proposed or approved hosts.
 */
export function useCodingWorkbenchResearch(
  input: UseCodingWorkbenchResearchInput,
): CodingWorkbenchResearchState {
  const { runId, revision, permissionRequestId } = input;
  const [state, setState] = useState<CodingWorkbenchResearchState>(IDLE);

  useEffect(() => {
    if (runId === undefined) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading", ask: null, grant: null });
    void (async (): Promise<void> => {
      try {
        await codingAppSessionPairingSettled();
        if (controller.signal.aborted) return;
        const payload = await getCodingWorkbenchRuntimeResearch(runId, controller.signal);
        if (!controller.signal.aborted) setState(projectResearchState(payload));
      } catch {
        if (!controller.signal.aborted) setState({ status: "unavailable", ask: null, grant: null });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [runId, revision, permissionRequestId]);

  return state;
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
