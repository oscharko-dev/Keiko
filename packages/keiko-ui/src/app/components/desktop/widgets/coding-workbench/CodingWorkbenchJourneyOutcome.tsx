"use client";

import { useEffect, type ReactNode } from "react";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { isSafeGitRefName } from "@oscharko-dev/keiko-contracts/runtime/git-repository";
import { ApiError, proposePrMarkReady, type GitDeliveryPrMarkReadyInput } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { JourneyDetails } from "./_JourneyDetails";
import {
  canProposeJourneyReady,
  matchesJourneySnapshot,
  journeyDisplayState,
} from "./_journeyPresentation";
import { useJourneyActions, type JourneyActionFailure } from "./_useJourneyActions";
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
   * The narrow `pr-mark-ready` approval/execute path (#3389 AC3) is now live: `POST
   * /api/git-delivery/pr/mark-ready/approve` mints the one-use claim and `POST
   * /api/git-delivery/pr/mark-ready/execute` redeems it (prMarkReadyExecution.ts). The Coding
   * Workbench window builds `onProposeReady` and `markReadyAvailable` from
   * `createPrMarkReadyProposeHandler` below, computed from this same `outcome`, rather than
   * re-deriving the request shape. Until the caller passes `true` here — meaning a genuine request
   * could be built AND `onProposeReady` is backed by it — the ready-for-review control renders
   * visibly but stays a closed, non-clickable "approval path pending" state, never a click that
   * silently does nothing or reaches a generic command with no approval bound to it (the generic
   * `pr-update` transition must not be presented as this approval path — epic #3384 correction 1).
   */
  readonly markReadyAvailable?: boolean;
}

// The server's mint route requires `baseRef` to be a base branch NAME, never a fully-qualified ref
// (`isBaseBranchName`, prMarkReadyExecution.ts): the same `isSafeGitRefName` + "not refs/-prefixed"
// composition `GitPullRequestIdentity`'s own `baseRef` field is validated with at the wire boundary
// (git-pull-request-identity.ts's `validBranch`), reused here rather than restated so a value this
// helper accepts can never fail the server's stricter-in-spirit, format-compatible check.
function isKnownBaseRef(value: string | undefined): value is string {
  return value !== undefined && isSafeGitRefName(value) && !value.startsWith("refs/");
}

/**
 * Derives the exact pr-mark-ready mint/execute request from a JourneyOutcome's own observed remote
 * identity and CI readiness snapshot — undefined when any bound fact, including the PR's base
 * branch name, is missing or unusable. An incomplete or stale observation can never be proposed as
 * ready: every field this binds is a fact the journey read actually observed, never guessed or
 * defaulted (AC3's "base/head SHAs, a readiness digest, the current draft state" binding; #3389
 * repair: `baseRef` must come from the observed identity, never a default, or the control stays
 * unavailable rather than sending a request the server's mint route unconditionally rejects).
 */
export function prMarkReadyProposalRequestFor(
  outcome: JourneyOutcome,
  projectId: string,
): Omit<GitDeliveryPrMarkReadyInput, "approval"> | undefined {
  const identity = outcome.remote?.identity;
  const readinessDigest = outcome.readiness?.requirementsDigest ?? undefined;
  if (identity === undefined || readinessDigest === undefined) return undefined;
  const baseRef = identity.baseRef;
  if (!isKnownBaseRef(baseRef)) return undefined;
  return {
    projectId,
    ownerAndRepo: identity.repository,
    prExternalId: String(identity.number),
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    baseRef,
    readinessDigest,
  };
}

/**
 * Builds the genuine `onProposeReady` handler for the Coding Workbench window to pass through:
 * mints then immediately redeems the one-use pr-mark-ready approval via the governed BFF routes
 * (`proposePrMarkReady`, api.ts). Returns undefined when the outcome does not yet carry the facts
 * the approval must bind — the caller gates `markReadyAvailable` on that same `undefined` check, so
 * the control is never offered as clickable without a handler genuinely backed by a real request.
 */
export function createPrMarkReadyProposeHandler(
  outcome: JourneyOutcome,
  projectId: string,
): (() => Promise<void>) | undefined {
  const request = prMarkReadyProposalRequestFor(outcome, projectId);
  if (request === undefined) return undefined;
  return async (): Promise<void> => {
    const result = await proposePrMarkReady(request);
    if (result.status === "succeeded") return;
    // B5-2 (epic #3384 audit): carry the already-observed closed-vocabulary reason
    // (`executionErrorCode`, falling back to the outcome `status` itself — both body-free per
    // GitDeliveryPrMarkReadyExecuteResponse) as an `ApiError.code` rather than folding it only into
    // the message string, so `useJourneyActions`' catch block can surface it instead of the
    // undifferentiated "Error" class every plain-thrown `Error` reduces to.
    throw new ApiError(
      result.executionErrorCode ?? result.status,
      `pr-mark-ready-${result.status}`,
      0,
    );
  };
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
  if (summary?.status !== "ready") return null;
  return (
    <p className={common.helpText}>
      {t("codingWorkbench.journey.changedFiles", { count: summary.fileCount })}
      {summary.truncated ? ` ${t("codingWorkbench.journey.changedFilesTruncated")}` : ""}
    </p>
  );
}
interface JourneyProposeState {
  readonly canPropose: boolean;
  readonly pending: boolean;
  readonly propose: () => void;
}

function useJourneyProposeState(
  props: CodingWorkbenchJourneyOutcomeProps & {
    readonly outcome: JourneyOutcome;
    readonly ready: boolean;
  },
  busy: boolean,
  invoke: ReturnType<typeof useJourneyActions>["invoke"],
): JourneyProposeState {
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
    if (ready !== undefined) void invoke("propose-ready", ready);
  };
  return { canPropose, pending, propose };
}

function RefreshButton({
  onClick,
  busy,
}: {
  readonly onClick: () => void;
  readonly busy: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <button type="button" className={common.button} disabled={busy} onClick={onClick}>
      {t("codingWorkbench.journey.refresh")}
    </button>
  );
}

function ProposeReadyButton({
  busy,
  state,
}: {
  readonly busy: boolean;
  readonly state: JourneyProposeState;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <button
      type="button"
      className={common.button}
      disabled={busy || !state.canPropose}
      aria-describedby={state.pending ? "journey-propose-ready-pending" : undefined}
      onClick={state.propose}
    >
      {t("codingWorkbench.journey.proposeReady")}
    </button>
  );
}

function JourneyControls(
  props: CodingWorkbenchJourneyOutcomeProps & {
    readonly outcome: JourneyOutcome;
    readonly ready: boolean;
  },
): ReactNode {
  const action = useJourneyActions(props.outcome.binding.runId);
  const busy = props.busy === true || action.busy;
  const refresh = props.onRefresh;
  const state = useJourneyProposeState(props, busy, action.invoke);
  return (
    <div aria-busy={busy}>
      <div className={styles["cmp-journey-actions"]}>
        {refresh !== undefined && (
          <RefreshButton
            busy={busy}
            onClick={() => {
              if (!busy) void action.invoke("refresh", refresh);
            }}
          />
        )}
        {props.ready && <ProposeReadyButton busy={busy} state={state} />}
      </div>
      <JourneyActionFeedback
        busy={busy}
        failure={action.failure}
        ready={state.canPropose}
        pending={state.pending}
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
  readonly failure: JourneyActionFailure | null;
  readonly ready: boolean;
  readonly pending: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <>
      {ready && <p className={common.helpText}>{t("codingWorkbench.journey.readyHelp")}</p>}
      {pending && (
        <output id="journey-propose-ready-pending" aria-live="polite" className={common.helpText}>
          {t("codingWorkbench.journey.proposeReadyPending")}
        </output>
      )}
      {busy && (
        <output aria-live="polite" className={common.helpText}>
          {t("codingWorkbench.journey.busy")}
        </output>
      )}
      {failure !== null && (
        <p role="alert" className={styles["cmp-journey-error"]}>
          {t(`codingWorkbench.journey.actionError.${failure.action}`, { reason: failure.reason })}
        </p>
      )}
    </>
  );
}
