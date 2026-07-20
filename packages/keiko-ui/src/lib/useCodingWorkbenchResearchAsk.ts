"use client";

import { useEffect, useState } from "react";
import type { CodingWorkbenchRuntimePendingResearch } from "@oscharko-dev/keiko-contracts";

import { getCodingWorkbenchRuntimeResearchAsk } from "./coding-workbench-runtime-api";

export type CodingWorkbenchResearchAskStatus = "idle" | "loading" | "ready" | "unavailable";

export interface CodingWorkbenchResearchAskState {
  readonly status: CodingWorkbenchResearchAskStatus;
  readonly ask: CodingWorkbenchRuntimePendingResearch | null;
}

export interface UseCodingWorkbenchResearchAskInput {
  readonly runId: string | undefined;
  /** The pending permission's request id; drives a refetch when a NEW ask replaces an old one. */
  readonly permissionRequestId: string | undefined;
  /** Only a `network-egress` ask has a destination to review. */
  readonly isNetworkEgress: boolean;
}

const IDLE: CodingWorkbenchResearchAskState = { status: "idle", ask: null };

/**
 * Reads the pending research ask — public host and sanitized request line — over the authenticated
 * app-session channel while a `network-egress` approval is on screen (#2387).
 *
 * The operator must be able to see the destination before granting egress to it; the runtime event
 * that raises the ask stays content-free, so this detail deliberately comes from the authenticated
 * channel instead. A single read per ask: the pending URL cannot change under a fixed request id,
 * so there is nothing to poll for. An unpaired window resolves to `unavailable` and the panel keeps
 * showing only the content-free approval facts — it never silently claims there is no destination.
 */
export function useCodingWorkbenchResearchAsk(
  input: UseCodingWorkbenchResearchAskInput,
): CodingWorkbenchResearchAskState {
  const { runId, permissionRequestId, isNetworkEgress } = input;
  const [state, setState] = useState<CodingWorkbenchResearchAskState>(IDLE);

  useEffect(() => {
    if (runId === undefined || permissionRequestId === undefined || !isNetworkEgress) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading", ask: null });
    getCodingWorkbenchRuntimeResearchAsk(runId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setState(
          payload.pending === undefined
            ? { status: "unavailable", ask: null }
            : { status: "ready", ask: payload.pending },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "unavailable", ask: null });
      });
    return () => {
      controller.abort();
    };
  }, [runId, permissionRequestId, isNetworkEgress]);

  return state;
}
