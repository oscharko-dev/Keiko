"use client";

import type { ReactNode } from "react";
import type { ChatProcessingStep, ChatProcessingState } from "./chat-processing-pipeline";
import { CHAT_PROCESSING_STATE_LABELS } from "./chat-processing-pipeline";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { Icons } from "./Icons";
import styles from "./ChatProcessingPipeline.module.css";

const {
  check: CheckIcon,
  close: CloseIcon,
  info: InfoIcon,
  lock: LockIcon,
  dots: DotsIcon,
} = Icons;

function StepIcon({ state }: { readonly state: ChatProcessingState }): ReactNode {
  if (state === "done") return <CheckIcon size={14} />;
  if (state === "failed" || state === "cancelled" || state === "blocked")
    return <CloseIcon size={14} />;
  if (state === "attention") return <InfoIcon size={14} />;
  if (state === "approval") return <LockIcon size={14} />;
  return <DotsIcon size={14} />;
}

function pipelineSummary(steps: readonly ChatProcessingStep[], t: OptionalWidgetTranslate): string {
  const current = steps.filter((step) => step.state === "active" || step.state === "approval");
  if (current.length > 0)
    return t("chat.processing.current", { steps: current.map((step) => t(step.label)).join(", ") });
  if (steps.some((step) => step.state === "attention")) return t("chat.processing.checkOutcome");
  const terminal = ["failed", "blocked", "cancelled"] as const;
  const issueState = terminal.find((candidate) => steps.some((step) => step.state === candidate));
  const responseState = steps.find((step) => step.id === "response")?.state;
  if (responseState === "done" && issueState !== undefined)
    return t("chat.processing.summary", { state: t("chat.processing.doneWithIssues") });
  const state = responseState ?? issueState ?? steps.at(-1)?.state ?? "attention";
  return t("chat.processing.summary", { state: t(CHAT_PROCESSING_STATE_LABELS[state]) });
}

function ProcessingStep({
  step,
  index,
}: {
  readonly step: ChatProcessingStep;
  readonly index: number;
}): ReactNode {
  const t = useTranslate();
  const current = step.state === "active" || step.state === "approval";
  const label = t(step.label);
  const state = t(CHAT_PROCESSING_STATE_LABELS[step.state]);
  return (
    <li
      className={styles.cmpStep}
      data-state={step.state}
      aria-current={current ? "step" : undefined}
      aria-label={t("chat.processing.step", { step: index + 1, label, state })}
    >
      <span className={styles.cmpIcon} aria-hidden="true">
        <StepIcon state={step.state} />
      </span>
      <span className={styles.cmpCopy}>
        <span>{t("chat.processing.numberedStep", { step: index + 1, label })}</span>
        <small className={styles.cmpState}>{state}</small>
      </span>
    </li>
  );
}

/** A transcript projection, not an execution plan or a second progress producer. */
export function ChatProcessingPipeline({
  steps,
}: {
  readonly steps: readonly ChatProcessingStep[];
}): ReactNode {
  const t = useTranslate();
  if (steps.length === 0) return null;
  return (
    <section className={styles.cmpPipeline} aria-label={t("chat.processing.title")}>
      <strong className={styles.cmpTitle}>{t("chat.processing.title")}</strong>
      <ol className={styles.cmpSteps}>
        {steps.map((step, index) => (
          <ProcessingStep key={step.id} step={step} index={index} />
        ))}
      </ol>
      <output className={styles.cmpAnnouncement} aria-live="polite" aria-atomic="true">
        {pipelineSummary(steps, t)}
      </output>
    </section>
  );
}
