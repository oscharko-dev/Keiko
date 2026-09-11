"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CodingWorkbenchRuntimeSkillsChannelPayload,
  SkillDiscoveryResultV1,
} from "@oscharko-dev/keiko-contracts";

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import { getCodingWorkbenchRuntimeSkills } from "./coding-workbench-runtime-api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";

export type CodingWorkbenchSkillsStatus = "idle" | "loading" | "ready" | "unavailable";

export interface CodingWorkbenchSkillsState {
  readonly status: CodingWorkbenchSkillsStatus;
  readonly skills: SkillDiscoveryResultV1 | null;
}

export interface UseCodingWorkbenchSkillsResult extends CodingWorkbenchSkillsState {
  /** Re-reads the channel on demand, the operator's recourse after a transient failure. */
  readonly retry: () => void;
}

export interface UseCodingWorkbenchSkillsInput {
  readonly runId: string | undefined;
  /** The runtime revision: a catalog the server changed reaches the operator on the next one. */
  readonly revision: number | undefined;
}

const IDLE: CodingWorkbenchSkillsState = { status: "idle", skills: null };
const LOADING: CodingWorkbenchSkillsState = { status: "loading", skills: null };
const UNAVAILABLE: CodingWorkbenchSkillsState = { status: "unavailable", skills: null };

interface ScopedSkillsState extends UseCodingWorkbenchSkillsInput {
  readonly value: CodingWorkbenchSkillsState;
}

interface ActiveSkillsInput extends UseCodingWorkbenchSkillsInput {
  readonly runId: string;
}

/**
 * Reads the approved skills of a run from its one authenticated channel (#3417). The listing is the
 * closed, body-free record the model's discovery reports; the general runtime snapshot carries none
 * of it.
 */
export function useCodingWorkbenchSkills(
  input: UseCodingWorkbenchSkillsInput,
): UseCodingWorkbenchSkillsResult {
  const { runId, revision } = input;
  const [scoped, setScoped] = useState<ScopedSkillsState>(() =>
    scopeSkillsState(runId, revision, inputState(input)),
  );
  // Bumped only by `retry()`; its sole job is to re-run the effect below, including its loading
  // state, without any input having changed.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);
  // A re-pair without a page load reads the channel again (F65).
  const redemptions = useCodingAppSessionRedemptions();

  useEffect(() => {
    if (runId === undefined) {
      setScoped(scopeSkillsState(runId, revision, IDLE));
      return;
    }
    setScoped(scopeSkillsState(runId, revision, LOADING));
    return startSkillsRead({ runId, revision }, setScoped);
  }, [runId, revision, epoch, redemptions]);

  const value = sameSkillsInput(scoped, input) ? scoped.value : inputState(input);
  return { ...value, retry };
}

function startSkillsRead(
  input: ActiveSkillsInput,
  publish: (state: ScopedSkillsState) => void,
): () => void {
  const controller = new AbortController();
  const pairingSettled = codingAppSessionPairingSettled();

  async function read(): Promise<void> {
    try {
      await pairingSettled;
      if (controller.signal.aborted) return;
      const payload = await getCodingWorkbenchRuntimeSkills(input.runId, controller.signal);
      if (controller.signal.aborted) return;
      publish(scopeSkillsState(input.runId, input.revision, projectSkillsState(payload)));
    } catch (error) {
      if (controller.signal.aborted) return;
      // The rendered state stays the content-free "unavailable", while the refresh failure itself
      // stays diagnosable through the client diagnostic sink.
      reportClientDiagnostic(`[keiko] skills channel read failed: ${clientErrorSummary(error)}`, {
        correlationId: correlationIdOf(error),
      });
      publish(scopeSkillsState(input.runId, input.revision, UNAVAILABLE));
    }
  }

  void read();
  return (): void => {
    controller.abort();
  };
}

/** An unpaired window has no answer to show; a paired one shows the listing the run carries. */
function projectSkillsState(
  payload: CodingWorkbenchRuntimeSkillsChannelPayload,
): CodingWorkbenchSkillsState {
  if (payload.session === "unpaired") return UNAVAILABLE;
  return { status: "ready", skills: payload.skills ?? null };
}

function inputState(input: UseCodingWorkbenchSkillsInput): CodingWorkbenchSkillsState {
  return input.runId === undefined ? IDLE : LOADING;
}

function scopeSkillsState(
  runId: string | undefined,
  revision: number | undefined,
  value: CodingWorkbenchSkillsState,
): ScopedSkillsState {
  return { runId, revision, value };
}

function sameSkillsInput(
  left: UseCodingWorkbenchSkillsInput,
  right: UseCodingWorkbenchSkillsInput,
): boolean {
  return left.runId === right.runId && left.revision === right.revision;
}
