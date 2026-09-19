"use client";
import { useEffect, type ReactNode } from "react";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchProgress.module.css";

type CodingProgressState =
  "working" | "approval" | "question" | "paused" | "done" | "failed" | "stopped" | "ready";

function codingProgressState(
  state: CodingWorkbenchRuntimeStateName | undefined,
  review: boolean,
  questions: number,
): CodingProgressState {
  if (review || state === "awaiting-approval") return "approval";
  if (questions > 0) return "question";
  return runtimeProgressState(state);
}

function runtimeProgressState(
  state: CodingWorkbenchRuntimeStateName | undefined,
): CodingProgressState {
  if (state === "paused") return "paused";
  if (state === "succeeded") return "done";
  if (state === "failed" || state === "recovery-required") return "failed";
  if (state === "cancelled" || state === "taken-over") return "stopped";
  return state === "running" || state === "starting" || state === "stopping" ? "working" : "ready";
}

function focusDecision(id: string): void {
  const heading = document.getElementById(id);
  heading?.scrollIntoView({ block: "start" });
  heading?.focus({ preventScroll: true });
  reportClientDiagnostic("[keiko] coding workbench pending decision focused");
}

function progressDecisionId(status: CodingProgressState, review: boolean): string {
  if (review) return "changeset-review-title";
  return status === "question" ? "coding-workbench-questions-title" : "permission-title";
}

function progressMark(status: CodingProgressState): string {
  if (status === "done") return "✓";
  return status === "approval" || status === "question" ? "!" : "";
}

export function CodingWorkbenchProgress({
  state,
  review,
  questions,
  starting,
}: {
  readonly state: CodingWorkbenchRuntimeStateName | undefined;
  readonly review: boolean;
  readonly questions: number;
  readonly starting: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const status = codingProgressState(starting ? "starting" : state, review, questions);
  const decisionId = progressDecisionId(status, review);
  const mark = progressMark(status);
  useEffect(() => {
    reportClientDiagnostic(`[keiko] coding workbench progress state: ${status}`);
  }, [status]);
  return (
    <div className={styles.cmpBar} data-status={status}>
      <span className={styles.cmpIndicator} aria-hidden="true">
        {mark}
      </span>
      <div className={styles.cmpCopy} role="status" aria-live="polite" aria-atomic="true">
        <strong>{t(`codingWorkbench.progress.${status}`)}</strong>
        <span>{t(`codingWorkbench.progress.${status}Help`)}</span>
      </div>
      {status === "approval" || status === "question" ? (
        <button
          type="button"
          className={styles.cmpAction}
          onClick={() => focusDecision(decisionId)}
        >
          {t(
            status === "question"
              ? "codingWorkbench.progress.answer"
              : "codingWorkbench.progress.review",
          )}
        </button>
      ) : null}
    </div>
  );
}
