"use client";

import { useId, useState, type ReactNode } from "react";
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
    return t("chat.processing.current", {
      steps: current
        .slice(-3)
        .map((step) => t(step.label))
        .join(", "),
    });
  if (steps.some((step) => step.state === "attention")) return t("chat.processing.checkOutcome");
  const terminal = ["failed", "blocked", "cancelled"] as const;
  const issueState = terminal.find((candidate) => steps.some((step) => step.state === candidate));
  const responseState = steps.find((step) => step.id === "response")?.state;
  if (responseState === "done" && issueState !== undefined)
    return t("chat.processing.summary", { state: t("chat.processing.doneWithIssues") });
  const state = responseState ?? issueState ?? steps.at(-1)?.state ?? "attention";
  return t("chat.processing.summary", { state: t(CHAT_PROCESSING_STATE_LABELS[state]) });
}

interface PresentedStep {
  readonly step: ChatProcessingStep;
  readonly index: number;
  readonly count: number;
}

function groupCompletedSteps(steps: readonly ChatProcessingStep[]): readonly PresentedStep[] {
  const groups: PresentedStep[] = [];
  for (const [index, step] of steps.entries()) {
    const previous = groups.at(-1);
    if (
      previous !== undefined &&
      step.toolName !== undefined &&
      step.toolName === previous.step.toolName &&
      step.state === "done" &&
      previous.step.state === "done" &&
      previous.step.label === step.label
    )
      groups[groups.length - 1] = { ...previous, count: previous.count + 1 };
    else groups.push({ step, index, count: 1 });
  }
  return groups;
}

function compactStepIndices(groups: readonly PresentedStep[]): ReadonlySet<number> {
  const current = groups.findLastIndex(
    ({ step }) => step.state === "active" || step.state === "approval",
  );
  const visible = new Set([0, groups.length - 1, current]);
  for (let index = Math.max(0, groups.length - 4); index < groups.length; index += 1)
    visible.add(index);
  return visible;
}

function ProcessingStep({ step, index, count }: PresentedStep): ReactNode {
  const t = useTranslate();
  const current = step.state === "active" || step.state === "approval";
  const stepLabel =
    step.progress === undefined ? t(step.label) : `${t(step.label)} · ${step.progress}`;
  const label =
    count === 1 ? stepLabel : t("chat.processing.repeated", { label: stepLabel, count });
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

function EarlierStepsToggle({
  hiddenCount,
  expanded,
  listId,
  onToggle,
}: {
  readonly hiddenCount: number;
  readonly expanded: boolean;
  readonly listId: string;
  readonly onToggle: () => void;
}): ReactNode {
  const t = useTranslate();
  if (hiddenCount === 0) return null;
  return (
    <button
      type="button"
      className={`lk-btn lk-btn-ghost ${styles.cmpMore}`}
      aria-controls={listId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? t("chat.processing.hideEarlier")
        : t("chat.processing.showEarlier", { count: hiddenCount })}
    </button>
  );
}

/** A transcript projection, not an execution plan or a second progress producer. */
export function ChatProcessingPipeline({
  steps,
}: {
  readonly steps: readonly ChatProcessingStep[];
}): ReactNode {
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const groups = groupCompletedSteps(steps);
  const compact = compactStepIndices(groups);
  const hiddenCount = groups.reduce(
    (count, group, index) => (compact.has(index) ? count : count + group.count),
    0,
  );
  const visible = expanded ? groups : groups.filter((_, index) => compact.has(index));
  if (steps.length === 0) return null;
  return (
    <section className={styles.cmpPipeline} aria-label={t("chat.processing.title")}>
      <strong className={styles.cmpTitle}>{t("chat.processing.title")}</strong>
      <ol className={styles.cmpSteps} id={listId}>
        {visible.map((group) => (
          <ProcessingStep key={group.step.id} {...group} />
        ))}
      </ol>
      <EarlierStepsToggle
        hiddenCount={hiddenCount}
        expanded={expanded}
        listId={listId}
        onToggle={() => setExpanded(!expanded)}
      />
      <output className={styles.cmpAnnouncement} aria-live="polite" aria-atomic="true">
        {pipelineSummary(steps, t)}
      </output>
    </section>
  );
}
