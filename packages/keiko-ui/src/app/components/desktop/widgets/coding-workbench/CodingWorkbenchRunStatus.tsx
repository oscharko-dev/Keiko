"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/i18n";
import type {
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import {
  activeRunState,
  readinessFacts,
  runPhaseIsAnnounced,
  runStatusAnnouncement,
} from "./codingWorkbenchLabels";
import {
  formatRunDuration,
  nativeRunRetry,
  runSettledAt,
  runStartedAt,
  type CodingWorkbenchRunPhase,
} from "./codingWorkbenchRunFacts";
import styles from "./CodingWorkbenchRunStatus.module.css";

const ELAPSED_TICK_MS = 1_000;

interface RunElapsed {
  readonly milliseconds: number;
  readonly settled: boolean;
}

interface RememberedStart {
  readonly runId: string;
  readonly at: number;
}

// The client keeps a bounded event window, so a long run can evict its `starting` event. The start
// is remembered per run once seen, and is never guessed from a later event.
function useRunStart(
  runId: string | undefined,
  events: readonly CodingWorkbenchRuntimeSseEvent[],
): number | null {
  const observed = runId === undefined ? null : runStartedAt(events, runId);
  const [remembered, setRemembered] = useState<RememberedStart | null>(null);
  useEffect(() => {
    if (runId === undefined || observed === null || remembered?.runId === runId) return;
    setRemembered({ runId, at: observed });
  }, [observed, remembered?.runId, runId]);
  if (observed !== null) return observed;
  return remembered !== null && remembered.runId === runId ? remembered.at : null;
}

// Ticks at most once per second, and only while `active`: a settled run's clock stops.
function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return (): void => clearInterval(timer);
  }, [active]);
  return now;
}

function useRunElapsed(state: CodingWorkbenchRuntimeState): RunElapsed | null {
  const snapshot = state.run.value;
  const startedAt = useRunStart(snapshot?.runId, state.events);
  const settledAt = runSettledAt(snapshot, state.events);
  const live = activeRunState(snapshot?.state);
  const now = useSecondClock(startedAt !== null && settledAt === null && live);
  if (startedAt === null) return null;
  if (settledAt !== null) return { milliseconds: settledAt - startedAt, settled: true };
  return live ? { milliseconds: now - startedAt, settled: false } : null;
}

function ElapsedTime({
  elapsed,
  t,
}: {
  readonly elapsed: RunElapsed | null;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (elapsed === null) return null;
  const duration = formatRunDuration(elapsed.milliseconds, t);
  return (
    <span className={styles.cmpRunStatusFact} role="timer" data-testid="coding-runtime-elapsed">
      {t(
        elapsed.settled
          ? "codingWorkbench.runStatus.duration"
          : "codingWorkbench.runStatus.elapsed",
        { duration },
      )}
    </span>
  );
}

// A phase the live status sentence already states (the model gateway outage) is not shown a second
// time beside it: the sentence is the visible text as well as the announcement.
function RunPhase({
  phase,
  t,
}: {
  readonly phase: CodingWorkbenchRunPhase | null;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (phase === null || runPhaseIsAnnounced(phase)) return null;
  return (
    <span className={styles.cmpRunStatusFact} data-testid="coding-runtime-phase">
      {t(`codingWorkbench.runStatus.phase.${phase}`)}
    </span>
  );
}

function NativeRetry({
  state,
  t,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const locale = useLocale();
  const retry = nativeRunRetry(state.run.value, state.events);
  if (retry === null) return null;
  return (
    <span className={styles.cmpRunStatusFact} data-testid="coding-runtime-native-retry">
      {t("codingWorkbench.runStatus.nativeRetry", {
        attempt: String(retry.attempt),
        scheduledAt: new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(retry.scheduledAt)),
      })}
    </span>
  );
}

function ReadinessDetails({
  state,
  t,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const facts = readinessFacts(state, t);
  if (facts.length === 0) return null;
  return (
    <details className={styles.cmpRunStatusReadiness}>
      <summary>{t("codingWorkbench.runStatus.readiness")}</summary>
      <p data-testid="coding-runtime-readiness">{facts}</p>
    </details>
  );
}

export interface CodingWorkbenchRunStatusProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly researchGrant: CodingWorkbenchRuntimeResearchGrant | null;
  readonly phase: CodingWorkbenchRunPhase | null;
}

/**
 * The run status line (#3873 live review). The run's own state, how long it has been running, its
 * revision and, when known, its current phase come first; the technical readiness facts that used
 * to lead the status region sit in a collapsed disclosure an assistive technology can still open.
 * The exceptions are the facts that say a part of the Workbench is missing or failing (an
 * unavailable runtime, an unpaired window — `readinessAttentionFacts`): they follow the run
 * sentence inside the live region, so they are announced and visible without opening anything
 * (#3873 review). Only the state sentence is a live region: the elapsed time is a timer, which
 * ticks silently. The phase is a fact beside that sentence, except the one the operator must hear
 * whether or not the line is in view: a model gateway that is unavailable and being retried joins
 * the sentence itself (`runPhaseIsAnnounced`; review thread 6pydza). It used to sit in its own span
 * outside the region, so a screen reader announced "Running" for the whole outage. The other
 * phases change with every tool call and would make the region chatter.
 */
export function CodingWorkbenchRunStatus({
  state,
  researchGrant,
  phase,
}: CodingWorkbenchRunStatusProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const elapsed = useRunElapsed(state);
  return (
    <div className={styles.cmpRunStatus} data-testid="coding-runtime-status">
      <p className={styles.cmpRunStatusLine}>
        <span
          className={styles.cmpRunStatusSummary}
          role="status"
          data-testid="coding-runtime-announcement"
          aria-live="polite"
          aria-atomic="true"
        >
          {runStatusAnnouncement(state, t, researchGrant, phase)}
        </span>
        <ElapsedTime elapsed={elapsed} t={t} />
        <RunPhase phase={phase} t={t} />
        <NativeRetry state={state} t={t} />
      </p>
      <ReadinessDetails state={state} t={t} />
    </div>
  );
}

/**
 * The same run status for assistive technology alone, where no status line is laid out: the setup
 * card centred before a repository is chosen has no run to time and states its own readiness.
 */
export function CodingWorkbenchRunAnnouncement({
  state,
  researchGrant,
}: Omit<CodingWorkbenchRunStatusProps, "phase">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <p
      className="sr-only"
      role="status"
      data-testid="coding-runtime-announcement"
      aria-live="polite"
      aria-atomic="true"
    >
      {runStatusAnnouncement(state, t, researchGrant)}
    </p>
  );
}
