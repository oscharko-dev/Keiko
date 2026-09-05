"use client";

import { useEffect, type ReactNode } from "react";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { JourneyDetails } from "./_JourneyDetails";
import {
  canProposeJourneyReady,
  matchesJourneySnapshot,
  journeyDisplayState,
} from "./_journeyPresentation";
import { useJourneyActions } from "./_useJourneyActions";
import { useJourneyClock } from "./_useJourneyClock";
import common from "./CodingWorkbenchWindow.module.css";
import styles from "./CodingWorkbenchJourneyOutcome.module.css";

/** A bounded, content-free join of `CodingWorkbenchChanges`' own live data (AC2) — a count and a
 * truncation flag only, never a path or diff body. */
export interface CodingWorkbenchJourneyChangedFilesSummary {
  readonly status: "loading" | "ready" | "unavailable";
  readonly fileCount: number;
  readonly truncated: boolean;
}
export interface CodingWorkbenchJourneyOutcomeProps {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | undefined;
  readonly outcome: JourneyOutcome | undefined;
  readonly onRefresh?: () => void | Promise<void>;
  readonly onProposeReady?: () => void | Promise<void>;
  readonly busy?: boolean;
  readonly changedFiles?: CodingWorkbenchJourneyChangedFilesSummary;
  /**
   * The narrow `pr-mark-ready` approval/execute path (#3389 AC3) is a separate slice landing in a
   * later wave; this route/UI change wires observation only. Until a caller passes `true` — meaning
   * the mint route actually exists and `onProposeReady` is genuinely backed by it — the ready-for-
   * review control renders visibly but stays a closed, non-clickable "approval path pending" state,
   * never a click that silently does nothing or reaches a generic command with no approval bound to
   * it (see the corrected #3389 contract: the generic `pr-update` transition must not be presented
   * as this approval path).
   */
  readonly markReadyAvailable?: boolean;
}
/** A historical outcome never reconstructs a grant or completes a provider mutation. */
export function CodingWorkbenchJourneyOutcome(
  props: CodingWorkbenchJourneyOutcomeProps,
): ReactNode {
  const valid = matchesJourneySnapshot(props.outcome, props.snapshot);
  const present = props.outcome !== undefined;
  useEffect(() => {
    if (present && !valid) reportClientDiagnostic("[keiko] journey unavailable: binding-mismatch");
  }, [valid, present]);
  if (!valid || props.outcome === undefined) return null;
  return <JourneyCard key={props.outcome.binding.runId} {...props} outcome={props.outcome} />;
}
function JourneyCard(
  props: CodingWorkbenchJourneyOutcomeProps & { readonly outcome: JourneyOutcome },
): ReactNode {
  const { outcome, snapshot } = props;
  const t = useCodingWorkbenchTranslate();
  const now = useJourneyClock(outcome);
  const state = journeyDisplayState(outcome, now);
  useEffect(() => {
    reportClientDiagnostic(
      `[keiko] journey displayed: ${state} head ${outcome.binding.headSha.slice(0, 12)}`,
      {
        correlationId: outcome.binding.runId,
      },
    );
  }, [state, outcome.binding.runId, outcome.binding.headSha]);
  return (
    <section className={common.card} aria-label={t("codingWorkbench.journey.title")}>
      <h3 className={common.approvalResearchTitle}>{t("codingWorkbench.journey.title")}</h3>
      <output className={styles["cmp-journey-state"]} data-state={state}>
        {t(`codingWorkbench.journey.state.${state}`)}
      </output>
      <p className={common.helpText}>{t(`codingWorkbench.journey.reason.${outcome.reason}`)}</p>
      {state === "stale" && (
        <p className={common.helpText}>{t("codingWorkbench.journey.staleHelp")}</p>
      )}
      <JourneyDetails outcome={outcome} now={now} />
      <ChangedFilesSummary summary={props.changedFiles} />
      <JourneyControls {...props} ready={canProposeJourneyReady(outcome, snapshot?.state, now)} />
    </section>
  );
}
function ChangedFilesSummary({
  summary,
}: {
  readonly summary: CodingWorkbenchJourneyChangedFilesSummary | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (summary === undefined || summary.status !== "ready") return null;
  return (
    <p className={common.helpText}>
      {t("codingWorkbench.journey.changedFiles", { count: summary.fileCount })}
      {summary.truncated ? ` ${t("codingWorkbench.journey.changedFilesTruncated")}` : ""}
    </p>
  );
}
function JourneyControls(
  props: CodingWorkbenchJourneyOutcomeProps & {
    readonly outcome: JourneyOutcome;
    readonly ready: boolean;
  },
): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const action = useJourneyActions(props.outcome.binding.runId);
  const busy = props.busy === true || action.busy;
  const refresh = props.onRefresh;
  const ready = props.onProposeReady;
  const markReadyAvailable = props.markReadyAvailable === true;
  const canPropose = props.ready && ready !== undefined && markReadyAvailable;
  const pending = props.ready && !markReadyAvailable;
  const propose = (): void => {
    if (
      busy ||
      !canPropose ||
      !canProposeJourneyReady(props.outcome, props.snapshot?.state, Date.now())
    )
      return;
    if (ready !== undefined) void action.invoke("propose-ready", ready);
  };
  return (
    <div aria-busy={busy}>
      <div className={styles["cmp-journey-actions"]}>
        {refresh !== undefined && (
          <button
            type="button"
            className={common.button}
            disabled={busy}
            onClick={() => {
              if (!busy) void action.invoke("refresh", refresh);
            }}
          >
            {t("codingWorkbench.journey.refresh")}
          </button>
        )}
        {props.ready && (
          <button
            type="button"
            className={common.button}
            disabled={busy || !canPropose}
            aria-describedby={pending ? "journey-propose-ready-pending" : undefined}
            onClick={propose}
          >
            {t("codingWorkbench.journey.proposeReady")}
          </button>
        )}
      </div>
      <JourneyActionFeedback
        busy={busy}
        failure={action.failure}
        ready={canPropose}
        pending={pending}
      />
    </div>
  );
}
function JourneyActionFeedback({
  busy,
  failure,
  ready,
  pending,
}: {
  readonly busy: boolean;
  readonly failure: "refresh" | "propose-ready" | null;
  readonly ready: boolean;
  readonly pending: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      {ready && <p className={common.helpText}>{t("codingWorkbench.journey.readyHelp")}</p>}
      {pending && (
        <p id="journey-propose-ready-pending" role="status" className={common.helpText}>
          {t("codingWorkbench.journey.proposeReadyPending")}
        </p>
      )}
      {busy && (
        <p role="status" className={common.helpText}>
          {t("codingWorkbench.journey.busy")}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className={styles["cmp-journey-error"]}>
          {t(`codingWorkbench.journey.actionError.${failure}`)}
        </p>
      )}
    </>
  );
}
