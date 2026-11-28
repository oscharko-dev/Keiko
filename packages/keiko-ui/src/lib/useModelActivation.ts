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

// The server lets the interactive check wait for the gateway's initial silence floor (900 s, the
// `GATEWAY_SILENCE_FLOOR_MS` of the Model Gateway, which the UI cannot import) before it records a
// verdict. The request carries the same deadline plus a margin for the server's own answer, so a
// POST that never settles cannot hold the button on "Checking" for good.
export const MODEL_ACTIVATION_DEADLINE_MS = 960_000;

export function useModelActivation(surface: GatewayReadinessSurface): ModelActivation {
  const [state, setState] = useState<ModelActivationState>(IDLE);
  const running = useRef(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      // Closing the window ends the request, so the server stops a check nobody waits for.
      request.current?.abort();
    };
  }, []);
  const activate = useCallback(
    (modelId: string): void => {
      if (running.current) return;
      running.current = true;
      setState({ status: "running", modelId });
      const controller = new AbortController();
      request.current = controller;
      void runActivation(modelId, surface, controller).then((failure) => {
        running.current = false;
        request.current = null;
        // The server owns the activation state and recorded a verdict even for an unclear answer
        // (a deadline, a closed request): the catalog and the Workbench re-read that state now.
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
  controller: AbortController,
): Promise<ModelActivationFailure | undefined> {
  const deadline = setTimeout((): void => {
    controller.abort(
      new DOMException("The model activation did not answer in time.", "TimeoutError"),
    );
  }, MODEL_ACTIVATION_DEADLINE_MS);
  try {
    const verdict = await activateChatModelFromSurface(modelId, surface, controller.signal);
    // An inconclusive probe is not a failure: back to idle, so the catalog decides and Activate stays.
    return verdict === "failed" ? "check-failed" : undefined;
  } catch (error) {
    // Body-free: the failure class and the failed request's own correlation id, never the model.
    reportClientDiagnostic("[keiko] model activation request failed", {
      correlationId: correlationIdOf(error),
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return "request-failed";
  } finally {
    clearTimeout(deadline);
  }
}
