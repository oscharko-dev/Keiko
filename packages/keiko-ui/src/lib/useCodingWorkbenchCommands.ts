"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CodingWorkbenchCommand,
  CodingWorkbenchRuntimeCommandsChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  codingAppSessionPairingSettled,
  useCodingAppSessionRedemptions,
} from "./coding-app-session-client";
import { fetchCodingWorkbenchRuntimeCommands } from "./coding-workbench-runtime-api";
import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";

export type CodingWorkbenchCommandsStatus = "idle" | "loading" | "ready" | "error";

export interface UseCodingWorkbenchCommandsInput {
  /** The live run whose runtime lists the commands; none, nothing to read. */
  readonly runId: string | undefined;
  /**
   * True once the slash menu needs the listing. The read is lazy: it starts the first time this is
   * true for a run, is kept for that run, and is never started by a composer nobody typed `/` into.
   */
  readonly wanted: boolean;
}

export interface UseCodingWorkbenchCommandsResult {
  readonly status: CodingWorkbenchCommandsStatus;
  /** The run's own listing; empty unless `status` is `ready`, and then only if the run offers none. */
  readonly commands: readonly CodingWorkbenchCommand[];
  /** Reads the listing again, the operator's recourse after a failed read. */
  readonly retry: () => void;
}

interface CommandsState {
  readonly status: CodingWorkbenchCommandsStatus;
  readonly commands: readonly CodingWorkbenchCommand[];
}

const NO_COMMANDS: readonly CodingWorkbenchCommand[] = Object.freeze([]);
const IDLE: CommandsState = { status: "idle", commands: NO_COMMANDS };
const LOADING: CommandsState = { status: "loading", commands: NO_COMMANDS };
const FAILED: CommandsState = { status: "error", commands: NO_COMMANDS };

interface ScopedCommands {
  readonly runId: string;
  /** The retry generation this answer belongs to: an older read never shows after a retry. */
  readonly epoch: number;
  readonly value: CommandsState;
}

/**
 * The run the slash menu has asked for, kept once asked: the listing is read when the menu first
 * opens and not again every time the draft stops starting with `/`.
 */
function useAskedRun(runId: string | undefined, wanted: boolean): string | undefined {
  const [asked, setAsked] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (wanted && runId !== undefined) setAsked(runId);
  }, [runId, wanted]);
  return runId !== undefined && (wanted || asked === runId) ? runId : undefined;
}

/**
 * Lists a live run's slash commands from their one authenticated channel (ADR-0137 D10). A failed
 * or unpaired read is reported body-free and shown as a retryable error, never as an empty listing
 * that would pass for "this run has no commands"; a listing read for another run is never shown.
 */
export function useCodingWorkbenchCommands(
  input: UseCodingWorkbenchCommandsInput,
): UseCodingWorkbenchCommandsResult {
  const askedRun = useAskedRun(input.runId, input.wanted);
  const [scoped, setScoped] = useState<ScopedCommands | null>(null);
  // Bumped only by `retry()` to re-run the read below without any input having changed.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);
  // A re-pair without a page load reads the listing again.
  const redemptions = useCodingAppSessionRedemptions();

  useEffect(() => {
    if (askedRun === undefined) return;
    setScoped({ runId: askedRun, epoch, value: LOADING });
    return startCommandsRead(askedRun, (value) => setScoped({ runId: askedRun, epoch, value }));
  }, [askedRun, epoch, redemptions]);

  const current =
    scoped !== null && scoped.runId === askedRun && scoped.epoch === epoch ? scoped.value : null;
  return { ...(askedRun === undefined ? IDLE : (current ?? LOADING)), retry };
}

function startCommandsRead(runId: string, publish: (value: CommandsState) => void): () => void {
  const controller = new AbortController();

  async function read(): Promise<void> {
    try {
      await codingAppSessionPairingSettled();
      if (controller.signal.aborted) return;
      const payload = await fetchCodingWorkbenchRuntimeCommands(runId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      publish(projectCommands(payload));
    } catch (error) {
      if (controller.signal.aborted) return;
      // The menu shows the content-free retryable error; the failure itself stays diagnosable.
      reportClientDiagnostic(`[keiko] commands channel read failed: ${clientErrorSummary(error)}`, {
        correlationId: correlationIdOf(error),
      });
      publish(FAILED);
    }
  }

  void read();
  return (): void => {
    controller.abort();
  };
}

/** An unpaired window has no listing to show; a paired one shows what the run lists, maybe none. */
function projectCommands(payload: CodingWorkbenchRuntimeCommandsChannelPayload): CommandsState {
  if (payload.session === "unpaired") return FAILED;
  return { status: "ready", commands: payload.commands ?? NO_COMMANDS };
}
