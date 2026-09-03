"use client";

import { useCallback, useEffect, useState } from "react";
import type { CodingWorkbenchRuntimePendingApprovalReview } from "@oscharko-dev/keiko-contracts";

import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { getCodingWorkbenchRuntimeApprovalReview } from "./coding-workbench-runtime-api";
import { clientErrorSummary, correlationIdOf } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";

export type CodingWorkbenchApprovalReviewStatus = "idle" | "loading" | "ready" | "unavailable";

export interface CodingWorkbenchApprovalReviewState {
  readonly status: CodingWorkbenchApprovalReviewStatus;
  readonly review: CodingWorkbenchRuntimePendingApprovalReview | null;
}

export interface UseCodingWorkbenchApprovalReviewResult extends CodingWorkbenchApprovalReviewState {
  /**
   * Re-reads the approval-review channel on demand, without waiting for `runId`/
   * `permissionRequestId` to change (workbench audit, 2026-09-03) — the operator's only recourse after a
   * transient failure while a `file-edit` approval decision is still open, mirroring
   * `useCodingWorkbenchChanges`/`useCodingWorkbenchQuestions`.
   */
  readonly retry: () => void;
}

export interface UseCodingWorkbenchApprovalReviewInput {
  readonly runId: string | undefined;
  /** The pending permission the operator is deciding about; absent means nothing to review. */
  readonly permissionRequestId: string | undefined;
}

const IDLE: CodingWorkbenchApprovalReviewState = { status: "idle", review: null };
const LOADING: CodingWorkbenchApprovalReviewState = { status: "loading", review: null };
const UNAVAILABLE: CodingWorkbenchApprovalReviewState = { status: "unavailable", review: null };

interface ScopedApprovalReviewState extends UseCodingWorkbenchApprovalReviewInput {
  readonly value: CodingWorkbenchApprovalReviewState;
}

/**
 * Reads the reviewable changeset facts of the pending approval from their one authenticated channel
 * (#2802). A human cannot exercise control over a change they are not shown (ADR-0129 D1), and the
 * paths are model-selected, so the general runtime snapshot remains structurally unable to carry
 * them (#2644). An unpaired or failing channel renders an honest "unavailable" — never an empty
 * list that would read as "this change touches nothing".
 */
export function useCodingWorkbenchApprovalReview(
  input: UseCodingWorkbenchApprovalReviewInput,
): UseCodingWorkbenchApprovalReviewResult {
  const { runId, permissionRequestId } = input;
  const [scoped, setScoped] = useState<ScopedApprovalReviewState>(() =>
    scopeState(runId, permissionRequestId, inputState(input)),
  );
  // Bumped only by `retry()`; not read inside the effect. Its sole job is to force the effect
  // below to re-run — including its `setScoped(...LOADING)` — on demand.
  const [epoch, setEpoch] = useState(0);
  const retry = useCallback((): void => setEpoch((value) => value + 1), []);

  useEffect(() => {
    if (runId === undefined || permissionRequestId === undefined) {
      setScoped(scopeState(runId, permissionRequestId, IDLE));
      return;
    }
    setScoped(scopeState(runId, permissionRequestId, LOADING));
    return startApprovalReviewSync(runId, permissionRequestId, setScoped);
  }, [runId, permissionRequestId, epoch]);

  const value = sameInput(scoped, input) ? scoped.value : inputState(input);
  return { ...value, retry };
}

function startApprovalReviewSync(
  runId: string,
  permissionRequestId: string,
  publish: (state: ScopedApprovalReviewState) => void,
): () => void {
  const controller = new AbortController();

  async function refresh(): Promise<void> {
    try {
      await codingAppSessionPairingSettled();
      if (controller.signal.aborted) return;
      const payload = await getCodingWorkbenchRuntimeApprovalReview(runId, controller.signal);
      if (controller.signal.aborted) return;
      publish(scopeState(runId, permissionRequestId, project(payload.session, payload.pending)));
    } catch (error) {
      if (controller.signal.aborted) return;
      // Same bounded console idiom as the research channel: the rendered state stays the honest
      // content-free "unavailable", but the underlying refresh failure remains diagnosable.
      reportClientDiagnostic(
        `[keiko] approval review channel refresh failed: ${clientErrorSummary(error)}`,
        { correlationId: correlationIdOf(error) },
      );
      publish(scopeState(runId, permissionRequestId, UNAVAILABLE));
    }
  }

  void refresh();
  return (): void => {
    controller.abort();
  };
}

/**
 * A review is rendered only when it binds to the very request the card is deciding about. A
 * mismatched or absent review is `unavailable`, never a silently empty change summary.
 */
function project(
  session: "active" | "unpaired",
  pending: CodingWorkbenchRuntimePendingApprovalReview | undefined,
): CodingWorkbenchApprovalReviewState {
  if (session === "unpaired" || pending === undefined) return UNAVAILABLE;
  return { status: "ready", review: pending };
}

function inputState(
  input: UseCodingWorkbenchApprovalReviewInput,
): CodingWorkbenchApprovalReviewState {
  return input.runId === undefined || input.permissionRequestId === undefined ? IDLE : LOADING;
}

function scopeState(
  runId: string | undefined,
  permissionRequestId: string | undefined,
  value: CodingWorkbenchApprovalReviewState,
): ScopedApprovalReviewState {
  return { runId, permissionRequestId, value };
}

function sameInput(
  left: UseCodingWorkbenchApprovalReviewInput,
  right: UseCodingWorkbenchApprovalReviewInput,
): boolean {
  return left.runId === right.runId && left.permissionRequestId === right.permissionRequestId;
}
