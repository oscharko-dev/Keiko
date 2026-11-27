"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyGatewayModelReadinessUpdated } from "@/app/components/desktop/widgets/shared/gatewaySetupBus";
import { activateChatModelFromSurface } from "./api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";
import { correlationIdOf } from "./client-error-summary";
import { bffRequestErrorKind } from "./http";
import type { GatewayReadinessSurface } from "./types";

// A person's own, in-place activation of one chat model (ADR-0171 D2, amended 2026-11-16; U-12,
// #4491). It is the SAME route and basic-chat readiness check Settings > Models runs, only started
// from the surface the person is working on; nothing activates a model on its own, and nothing is
// remembered beyond this server process (the server owns that).

/** Why the last activation of a model ended without activating it. */
export type ModelActivationFailure = "check-failed" | "request-failed";

export type ModelActivationState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly modelId: string }
  | {
      readonly status: "failed";
      readonly modelId: string;
      readonly failure: ModelActivationFailure;
    };

export interface ModelActivation {
  readonly state: ModelActivationState;
  /** Starts the one activation request; ignored while one runs. */
  readonly activate: (modelId: string) => void;
}

const IDLE: ModelActivationState = { status: "idle" };

export function useModelActivation(surface: GatewayReadinessSurface): ModelActivation {
  const [state, setState] = useState<ModelActivationState>(IDLE);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const activate = useCallback(
    (modelId: string): void => {
      if (running.current) return;
      running.current = true;
      setState({ status: "running", modelId });
      void runActivation(modelId, surface).then((failure) => {
        running.current = false;
        // The server recorded the verdict either way: the catalog and the Workbench re-read it.
        notifyGatewayModelReadinessUpdated();
        if (!mounted.current) return;
        setState(failure === undefined ? IDLE : { status: "failed", modelId, failure });
      });
    },
    [surface],
  );
  return { state, activate };
}

async function runActivation(
  modelId: string,
  surface: GatewayReadinessSurface,
): Promise<ModelActivationFailure | undefined> {
  try {
    return (await activateChatModelFromSurface(modelId, surface)) ? undefined : "check-failed";
  } catch (error) {
    // Body-free: the failure class and the failed request's own correlation id, never the model.
    reportClientDiagnostic("[keiko] model activation request failed", {
      correlationId: correlationIdOf(error),
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return "request-failed";
  }
}
