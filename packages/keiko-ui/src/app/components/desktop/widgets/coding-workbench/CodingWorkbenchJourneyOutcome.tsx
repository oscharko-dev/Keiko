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

export interface CodingWorkbenchJourneyOutcomeProps {
  readonly snapshot: CodingWorkbenchRuntimeSnapshot | undefined;
  readonly outcome: JourneyOutcome | undefined;
  readonly onRefresh?: () => void | Promise<void>;
  readonly onProposeReady?: () => void | Promise<void>;
  readonly busy?: boolean;
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
      <JourneyControls {...props} ready={canProposeJourneyReady(outcome, snapshot?.state, now)} />
    </section>
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
  const propose = (): void => {
    if (
      busy ||
      ready === undefined ||
      !canProposeJourneyReady(props.outcome, props.snapshot?.state, Date.now())
    )
      return;
    void action.invoke("propose-ready", ready);
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
        {props.ready && ready !== undefined && (
          <button type="button" className={common.button} disabled={busy} onClick={propose}>
            {t("codingWorkbench.journey.proposeReady")}
          </button>
        )}
      </div>
      <JourneyActionFeedback
        busy={busy}
        failure={action.failure}
        ready={props.ready && ready !== undefined}
      />
    </div>
  );
}
function JourneyActionFeedback({
  busy,
  failure,
  ready,
}: {
  readonly busy: boolean;
  readonly failure: "refresh" | "propose-ready" | null;
  readonly ready: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      {ready && <p className={common.helpText}>{t("codingWorkbench.journey.readyHelp")}</p>}
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
