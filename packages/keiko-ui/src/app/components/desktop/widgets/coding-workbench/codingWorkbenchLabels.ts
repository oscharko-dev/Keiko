import { gatewayVerificationContradictsReadiness } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import type {
  CodingWorkbenchIssueBindingFailure,
  CodingWorkbenchMode,
  CodingWorkbenchModelRefusalReason,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import type { CodingWorkbenchRunPhase } from "./codingWorkbenchRunFacts";
import type {
  CodingWorkbenchResourceStatus,
  CodingWorkbenchClientError,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";

export function cx(...classes: readonly (string | undefined | false)[]): string {
  return classes.filter((value): value is string => typeof value === "string").join(" ");
}

export function modeLabel(mode: CodingWorkbenchMode, t: CodingWorkbenchTranslate): string {
  return t(`codingWorkbench.mode.${mode}.label`);
}

export function modelSourceLabel(
  source: CodingWorkbenchModelSource,
  t: CodingWorkbenchTranslate,
): string {
  if (source === "keiko-model-gateway") return t("codingWorkbench.modelSource.gateway");
  if (source === "openai-api-key-through-gateway")
    return t("codingWorkbench.modelSource.openaiGateway");
  return t("codingWorkbench.modelSource.codexSubscription");
}

// The sidecar gateway's closed unavailable reasons (coding-workbench-provider-api.ts allow-list),
// each with the operator's next step. "Model source unavailable." alone left the operator with no
// way to learn that a readiness check would have fixed it (workbench end-to-end run, 2026-09-03).
const SOURCE_UNAVAILABLE_REASON_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  "missing-config": "codingWorkbench.source.unavailableReason.missing-config",
  "missing-provider": "codingWorkbench.source.unavailableReason.missing-provider",
  "missing-credentials": "codingWorkbench.source.unavailableReason.missing-credentials",
  "non-chat": "codingWorkbench.source.unavailableReason.non-chat",
  "no-tool-calling": "codingWorkbench.source.unavailableReason.no-tool-calling",
  "non-workflow-eligible": "codingWorkbench.source.unavailableReason.non-workflow-eligible",
  "non-coding-capable": "codingWorkbench.source.unavailableReason.non-coding-capable",
  "deployment-policy-disabled":
    "codingWorkbench.source.unavailableReason.deployment-policy-disabled",
  "subscription-source": "codingWorkbench.source.unavailableReason.subscription-source",
  // #3390 closeout: the source reported "available" with a context window too small for one
  // real request to survive (readiness gap, epic #3384). Appended, never renumbered.
  "model-context-window-insufficient":
    "codingWorkbench.source.unavailableReason.model-context-window-insufficient",
  // #3591 (1.1.7): transient — the Workbench re-reads the profile until the probe settles.
  "model-verification-pending":
    "codingWorkbench.source.unavailableReason.model-verification-pending",
  // PR #3452 (F73): the coding model's forced tool-call proof is missing or older than 24 h.
  "tool-calling-unverified": "codingWorkbench.source.unavailableReason.tool-calling-unverified",
};

function sourceUnavailableReasonKey(
  source: CodingWorkbenchRuntimeState["source"]["value"],
): CodingWorkbenchMessageKey | undefined {
  if (source === null || source.available || source.unavailableReason === undefined) {
    return undefined;
  }
  return SOURCE_UNAVAILABLE_REASON_KEYS[source.unavailableReason];
}

/** The operator-facing sentence for an unavailable source's reason, or null when it has none. */
function sourceUnavailableReasonText(
  source: CodingWorkbenchRuntimeState["source"]["value"],
  t: CodingWorkbenchTranslate,
): string | null {
  const key = sourceUnavailableReasonKey(source);
  return key === undefined ? null : t(key);
}

function runStateLabel(
  state: CodingWorkbenchRuntimeStateName,
  t: CodingWorkbenchTranslate,
): string {
  return t(`codingWorkbench.runState.${state}`);
}

function runAnnouncement(state: CodingWorkbenchRuntimeState, t: CodingWorkbenchTranslate): string {
  if (state.run.status === "loading") return t("codingWorkbench.announcement.runChecking");
  const snapshot = state.run.value;
  if (snapshot === null) return t("codingWorkbench.announcement.noActiveRun");
  if (snapshot.state === "idle" && !state.canStart) {
    return t("codingWorkbench.header.notReady");
  }
  if (
    snapshot.state === "idle" &&
    state.runtime.value?.runtimeEvidenceClass === "functional-not-platform-qualified"
  ) {
    return t("codingWorkbench.header.readyEvaluation");
  }
  // #3873: a revision belongs to a run; with no run yet the state alone is the status.
  if (snapshot.runId === undefined) return runStateLabel(snapshot.state, t);
  return t("codingWorkbench.announcement.runRevision", {
    state: runStateLabel(snapshot.state, t),
    revision: snapshot.revision,
  });
}

function setupKey(status: CodingWorkbenchResourceStatus): CodingWorkbenchMessageKey | undefined {
  if (status === "ready") return "codingWorkbench.announcement.setupReady";
  if (status === "loading") return "codingWorkbench.announcement.setupChecking";
  if (status === "unavailable") return "codingWorkbench.announcement.setupUnavailable";
  return undefined;
}

function researchAnnouncement(
  grant: CodingWorkbenchRuntimeResearchGrant | null,
  t: CodingWorkbenchTranslate,
): string {
  return grant === null ? "" : t("codingWorkbench.announcement.researchActive");
}

function withClosingPunctuation(sentence: string): string {
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

// Sentences read one after another: a part that lacks its closing punctuation (the header's "Not
// ready to start") gets a full stop, so the facts that follow it never run into it.
function joinedAnnouncements(announcements: readonly string[]): string {
  return announcements
    .filter((announcement) => announcement.length > 0)
    .reduce(
      (joined, announcement) =>
        joined.length === 0 ? announcement : `${withClosingPunctuation(joined)} ${announcement}`,
      "",
    );
}

// The run phases the live status sentence states. A model gateway that is unavailable and being
// retried rides on for minutes, and the run state beside it ("Running") reads the same as a healthy
// run, so a reader who cannot see the status line would hear nothing of the outage (review thread
// 6pydza). The other phases change with every tool call: announcing them would make the polite
// region chatter, so they are shown beside the sentence and not in it.
const ANNOUNCED_PHASES: ReadonlySet<CodingWorkbenchRunPhase> = new Set(["gateway"]);

/**
 * True for a run phase that the live status sentence states (`runStatusAnnouncement`). That sentence
 * is also the visible text of the status line, so the line must not show such a phase a second time
 * beside it.
 */
export function runPhaseIsAnnounced(phase: CodingWorkbenchRunPhase | null): boolean {
  return phase !== null && ANNOUNCED_PHASES.has(phase);
}

function phaseAnnouncement(
  phase: CodingWorkbenchRunPhase | null,
  t: CodingWorkbenchTranslate,
): string {
  if (phase === null || !ANNOUNCED_PHASES.has(phase)) return "";
  return withClosingPunctuation(t(`codingWorkbench.runStatus.phase.${phase}`));
}

/**
 * What the run itself is doing, for the live run status region: its state and revision, its phase
 * when that is one the operator must hear (`runPhaseIsAnnounced`: a model gateway that is being
 * retried), a completed recovery acknowledgement and an active research grant, then — only when
 * there are any — the readiness facts that need attention (`readinessAttentionFacts`). #3873 live
 * review: the region used to open with all the readiness facts, so a reader heard "Model source
 * ready. …" before learning whether the run was still working; the healthy facts now live in the
 * readiness details. #3873 review: moving every fact there also left an unavailable runtime or an
 * unpaired window announced to no one, so a fact that says the Workbench cannot start stays in this
 * polite, atomic sentence, where it is also visible text, and the setup layout announces it as
 * well. The setup layout has no run and so no phase to pass.
 */
export function runStatusAnnouncement(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  researchGrant: CodingWorkbenchRuntimeResearchGrant | null = null,
  phase: CodingWorkbenchRunPhase | null = null,
): string {
  const snapshot = state.run.value;
  const recovery =
    snapshot?.state === "recovery-required" && snapshot.recoveryAcknowledged === true
      ? t("codingWorkbench.announcement.recoveryComplete")
      : "";
  return joinedAnnouncements([
    runAnnouncement(state, t),
    phaseAnnouncement(phase, t),
    recovery,
    researchAnnouncement(researchGrant, t),
    readinessAttentionFacts(state, t),
  ]);
}

// The readiness announcements that say a part of the Workbench is missing or failing. They — and
// only they — join the live run status sentence. A fact that states what is not selected, not yet
// checked or still being checked is not on this list, and neither is the unverified evaluation
// runtime, which the readiness details state plainly (ADR-0163 D9, audit F-01): nothing here claims
// a plain "Runtime ready." over it, and a healthy Workbench keeps the run's own state first.
const ATTENTION_ANNOUNCEMENT_KEYS: ReadonlySet<CodingWorkbenchMessageKey> =
  new Set<CodingWorkbenchMessageKey>([
    "codingWorkbench.pairing.unpaired",
    "codingWorkbench.announcement.modelSource.unavailable",
    "codingWorkbench.announcement.modelSource.refreshFailed",
    "codingWorkbench.announcement.authenticationUnavailable",
    "codingWorkbench.announcement.authenticationRequired",
    "codingWorkbench.announcement.workspace.unavailable",
    "codingWorkbench.announcement.workspace.refreshFailed",
    "codingWorkbench.announcement.runtime.unavailable",
    "codingWorkbench.announcement.runtime.refreshFailed",
    "codingWorkbench.announcement.setupUnavailable",
  ]);

function readinessKeys(state: CodingWorkbenchRuntimeState): readonly CodingWorkbenchMessageKey[] {
  // F-01: the stated readiness must match the projected one — a source whose last probe failed is
  // stated as unavailable, not ready, exactly as `projectReadiness` treats it.
  const sourceAvailable =
    state.source.value?.runtimePreference === state.runtimePreference &&
    state.source.value.available &&
    !gatewayVerificationContradictsReadiness(state.source.value.verification);
  const workspaceAvailable = state.workspace.value?.health === "healthy";
  const runtimeAvailable = state.runtime.value?.runtimeAvailable === true;
  return [
    pairingKey(state),
    readinessKey("modelSource", state.source.status, sourceAvailable),
    sourceUnavailableReasonKey(state.source.value),
    authenticationKey(state),
    readinessKey("workspace", state.workspace.status, workspaceAvailable),
    runtimeAssuranceKey(state, runtimeAvailable),
    setupKey(state.codexSetup.status),
  ].filter((key): key is CodingWorkbenchMessageKey => key !== undefined);
}

/** The technical readiness facts behind a start, shown in the collapsed readiness details. */
export function readinessFacts(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  return joinedAnnouncements(readinessKeys(state).map((key) => t(key)));
}

/**
 * The readiness facts that need attention: the subset of `readinessFacts` that says a part of the
 * Workbench is missing or failing (an unpaired window, an unavailable source, workspace or runtime,
 * a failed refresh, a missing authentication). It is empty for a healthy Workbench, and it never
 * holds the facts that merely state what is not selected or not yet checked.
 */
export function readinessAttentionFacts(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  return joinedAnnouncements(
    readinessKeys(state)
      .filter((key) => ATTENTION_ANNOUNCEMENT_KEYS.has(key))
      .map((key) => t(key)),
  );
}

// Release-audit F-08/RG-12: an unpaired window's run start is guaranteed to fail authority
// resolution (ADR-0141), so the narration must name pairing as the missing input instead of
// narrating "Workspace ready. Runtime ready." over a start that can never succeed. Silent while
// pairing is unconfirmed — the narration never claims a truth the workspaces read has not answered.
function pairingKey(state: CodingWorkbenchRuntimeState): CodingWorkbenchMessageKey | undefined {
  return state.pairing === "unpaired" ? "codingWorkbench.pairing.unpaired" : undefined;
}

type ReadinessAnnouncementState =
  "checking" | "refreshFailed" | "unavailable" | "ready" | "notSelected" | "notChecked";

function readinessAnnouncementState(
  status: CodingWorkbenchResourceStatus,
  available: boolean,
): ReadinessAnnouncementState {
  if (status === "loading") return "checking";
  if (status === "error") return "refreshFailed";
  if (status === "unavailable") return "unavailable";
  if (status === "ready") return available ? "ready" : "unavailable";
  if (status === "empty") return "notSelected";
  return "notChecked";
}

/**
 * SUBSTITUTES the generic runtime readiness line — never appends to it. "Runtime ready." spoken
 * over an unverified evaluation runtime is the same false green in the assistive-technology
 * channel that the pill's plain "Ready to start" is on screen (audit F-01, ADR-0163 D9).
 *
 * It is a dedicated helper rather than a new `ReadinessAnnouncementState` member because
 * `readinessKey` builds its key as a template literal typed against
 * `CodingWorkbenchMessageKey`: adding a state would force `modelSource.evaluation` and
 * `workspace.evaluation` keys to exist for resources that can never have that state.
 */
function runtimeAssuranceKey(
  state: CodingWorkbenchRuntimeState,
  runtimeAvailable: boolean,
): CodingWorkbenchMessageKey {
  if (
    runtimeAvailable &&
    state.runtime.status === "ready" &&
    state.runtime.value?.runtimeEvidenceClass === "functional-not-platform-qualified"
  ) {
    return "codingWorkbench.announcement.runtime.evaluation";
  }
  return readinessKey("runtime", state.runtime.status, runtimeAvailable);
}

function readinessKey(
  resource: "modelSource" | "workspace" | "runtime",
  status: CodingWorkbenchResourceStatus,
  available: boolean,
): CodingWorkbenchMessageKey {
  return `codingWorkbench.announcement.${resource}.${readinessAnnouncementState(status, available)}`;
}

function authenticationKey(state: CodingWorkbenchRuntimeState): CodingWorkbenchMessageKey {
  if (state.runtimePreference !== "codex-subscription") {
    return "codingWorkbench.announcement.authenticationNotSelected";
  }
  if (state.profile.status === "loading") {
    return "codingWorkbench.announcement.authenticationChecking";
  }
  if (state.profile.status === "error" || state.profile.status === "unavailable") {
    return "codingWorkbench.announcement.authenticationUnavailable";
  }
  const profile = state.profile.value;
  if (profile?.status === "connected") return "codingWorkbench.announcement.authenticationReady";
  if (profile?.status === "missing") return "codingWorkbench.announcement.authenticationRequired";
  if (profile !== null) return "codingWorkbench.announcement.authenticationUnavailable";
  return "codingWorkbench.announcement.authenticationNotChecked";
}

/**
 * True while a run is still live enough for the operator's end controls to reach it — exactly the
 * states from which the server's transition table still admits `taken-over` or `cancelled`
 * (pinned against that table in codingWorkbenchLabels.test.ts).
 *
 * `paused` belongs here. The server accepts stop and takeover from a paused run, the run keeps the
 * Authority Envelope minted for it, and its headless editor-bridge session must stay leased: a
 * changeset review that is already pending when the operator pauses can only be delivered over a
 * live bridge lease, so dropping `paused` silently discarded the operator's Approve/Deny.
 */
export function activeRunState(state: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    state === "starting" ||
    state === "ready" ||
    state === "running" ||
    state === "awaiting-approval" ||
    state === "paused" ||
    state === "stopping"
  );
}

/**
 * True while the run's model may still be producing text: before its first turn, while it runs and
 * while it is paused. An `awaiting-approval` run has finished its turn and waits for the operator
 * and a `stopping` run is ending, so an answer shown then is finished and keeps its code
 * highlighting and Copy button (#3873 review).
 *
 * A `paused` run's answer is not finished. Review thread 6pyds7 inverted the earlier pins that
 * treated it as finished: pausing refuses new work — an approval, a child tool mutation, a new
 * model-call admission — but aborts nothing, so the call the run had already admitted keeps
 * streaming into its message, and the safe-activity feed keeps delivering it while the run reads
 * `paused`. Offering Copy on that message would copy a partial code block and re-highlight it on
 * every batch. The cost is deliberate: the last text of a paused run that really is finished cannot
 * be told from one still being written, so it stays in its streaming form (no Copy button, no
 * highlighting) until the run settles or a tool call that began after it closes the message.
 *
 * Narrower than `activeRunState`, which keeps the end controls and the bridge lease for the whole
 * live run.
 */
export function generatingRunState(state: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return state === "starting" || state === "ready" || state === "running" || state === "paused";
}

export function eventTitle(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  if (event.kind === "status")
    return event.state === "failed"
      ? t("codingWorkbench.event.runFailed")
      : runStateLabel(event.state, t);
  return t(`codingWorkbench.event.${event.eventKind}`);
}

export function eventDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  const failure = eventFailureDetail(event, t);
  return [
    failure,
    eventStoppedDetail(event, t),
    eventOutcomeDetail(event, t),
    eventContentTrustDetail(event, t),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

// The run failures with a sentence of their own. F9 (#3873): the internal-error sentence belongs
// to `runtime-failed` alone; a run that ended on one of its bounds or on a model call names that
// cause instead. F5 (#3873): a run whose edits were refused again and again names its refusal
// class and the next step, never the generic sentence.
const RUN_FAILURE_MESSAGES: ReadonlyMap<string, CodingWorkbenchMessageKey> = new Map<
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchMessageKey
>([
  ["runtime-failed", "codingWorkbench.event.failure.runtime"],
  ["prompt-allowance-exhausted", "codingWorkbench.event.failure.prompt-allowance-exhausted"],
  ["envelope-duration-exhausted", "codingWorkbench.event.failure.envelope-duration-exhausted"],
  ["output-exhausted-repeated", "codingWorkbench.event.failure.output-exhausted-repeated"],
  ["provider-unavailable", "codingWorkbench.event.failure.provider-unavailable"],
  ["model-turn-failed", "codingWorkbench.event.failure.model-turn-failed"],
  ["verification-not-evidenced", "codingWorkbench.event.failure.verification-not-evidenced"],
  ["edits-blocked", "codingWorkbench.event.failure.edits-blocked"],
  ["edit-retries-exhausted", "codingWorkbench.event.failure.edit-retries-exhausted"],
]);

// F9 (#3873): a run that settles `cancelled` was stopped, which is not a failure, so its terminal
// entry says so instead of leaving a bare "Stopped" a reader could take for one. It never says WHO
// stopped it: the operator's Stop and `CodingRuntimeOrchestrator.shutdown()` (an update, a restart
// or a machine shutdown) take the same stop path, and the settled snapshot and its terminal status
// event are identical for both — only `coding-runtime.run.shutdown` in the server's Activity Log
// names a shutdown. An attribution here would blame the operator for a stop they never asked for
// (#3873 review).
function eventStoppedDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  return event.kind === "status" && event.state === "cancelled"
    ? t("codingWorkbench.event.stopped")
    : "";
}

function eventFailureDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  const turnFailure = turnFailureDetail(event, t);
  if (turnFailure.length > 0) return turnFailure;
  if (event.failureCode === undefined) return "";
  return t(RUN_FAILURE_MESSAGES.get(event.failureCode) ?? "codingWorkbench.event.failure.generic");
}

function turnFailureDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  if (event.kind !== "runtime-event" || event.eventKind !== "failure-redacted") return "";
  if (event.failureCode === "provider-failed")
    return t("codingWorkbench.event.turnFailure.provider-failed");
  if (event.failureCode === "stream-incomplete")
    return t("codingWorkbench.event.turnFailure.stream-incomplete");
  if (event.failureCode === "turn-rejected")
    return t("codingWorkbench.event.turnFailure.turn-rejected");
  if (event.failureCode === "output-exhausted")
    return t("codingWorkbench.event.turnFailure.output-exhausted");
  if (event.failureCode === "empty-answer")
    return t("codingWorkbench.event.turnFailure.empty-answer");
  if (event.failureCode === "invalid-tool-call")
    return t("codingWorkbench.event.turnFailure.invalid-tool-call");
  return "";
}

// #2637: an accepted research read handed quarantined public-page text to the run. The operator has
// to be able to SEE that a turn took in third-party content, not just that a fetch succeeded — the
// approval covered the destination, never what the page would say. Content-free: it reports the
// trust classification the runtime asserted, never a byte of the page.
function eventContentTrustDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  if (event.kind !== "runtime-event" || event.contentTrust !== "untrusted") return "";
  return t("codingWorkbench.event.detailUntrustedContent");
}

// #2387: research-performed / skill-invoked / child-run-* frames carry a normalized outcome. It is
// appended as a content-free sentence so an exhausted budget or a cascaded stop is never mislabeled
// as a hard failure. Absent for every other event kind.
function eventOutcomeDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  if (event.kind !== "runtime-event" || event.auxiliaryOutcome === undefined) return "";
  return t("codingWorkbench.event.detailOutcome", {
    outcome: t(`codingWorkbench.outcomeLabel.${event.auxiliaryOutcome}`),
  });
}

/**
 * The machine facts every rejected workbench action carries. Structural on purpose: the runtime
 * mutation error, a refused runtime question, and an undelivered changeset decision are produced by
 * three different layers and all three get the identical treatment.
 */
export interface CodingWorkbenchFailureFacts {
  readonly issueBindingFailure?: CodingWorkbenchIssueBindingFailure;
  readonly code: string;
  readonly correlationId?: string;
}

// F-09a: a rejected action (any non-ok result — never only one status code) must surface as a
// visible, actionable alert naming the machine error code and, when the transport carried one, the
// correlation id that ties this exact failure to its redacted server-side diagnostic. A generic
// sentence alone left the operator with a dead button and nothing to report. `summaryKey` is the
// caller's sentence saying WHICH action failed: "the requested runtime action", "sending your
// answer" and "confirming this decision" are three different truths and must not share one.
export function actionFailureAlert(
  summaryKey: CodingWorkbenchMessageKey,
  failure: CodingWorkbenchFailureFacts,
  t: CodingWorkbenchTranslate,
): string {
  const generic = t(summaryKey, { code: failure.code });
  const issueSummary =
    failure.issueBindingFailure === undefined
      ? ""
      : t(`codingWorkbench.issue.error.${failure.issueBindingFailure}`);
  const summary =
    failure.issueBindingFailure === undefined ? generic : `${issueSummary} ${generic}`;
  return failure.correlationId === undefined
    ? summary
    : `${summary} ${t("codingWorkbench.alert.actionFailedSupportId", {
        correlationId: failure.correlationId,
      })}`;
}

/**
 * F-09a: an editor-changeset approve/deny that never reached the run must name the code that stopped
 * it — the run's file write is blocked until this decision lands, so "it failed" is not enough to
 * act on. `null` is only reachable if a delivery failure is ever flagged without facts; the generic
 * sentence keeps that path honest rather than rendering an empty alert.
 */
export function changesetDeliveryAlert(
  failure: CodingWorkbenchFailureFacts | null,
  t: CodingWorkbenchTranslate,
): string {
  return failure === null
    ? t("codingWorkbench.changesetReview.deliveryFailed")
    : actionFailureAlert("codingWorkbench.changesetReview.deliveryFailedCode", failure, t);
}

const REFRESH_FAILURE_ALERTS = [
  ["profile", "codingWorkbench.alert.authenticationRefreshFailed"],
  ["codexSetup", "codingWorkbench.alert.authenticationSetupRefreshFailed"],
  ["source", "codingWorkbench.alert.modelSourceRefreshFailed"],
  ["runtime", "codingWorkbench.alert.runtimeRefreshFailed"],
  ["workspace", "codingWorkbench.alert.workspaceRefreshFailed"],
  ["run", "codingWorkbench.alert.runRefreshFailed"],
  ["stream", "codingWorkbench.alert.eventStreamRefreshFailed"],
] as const;

function refreshFailureResource(
  state: CodingWorkbenchRuntimeState,
): (typeof REFRESH_FAILURE_ALERTS)[number] | undefined {
  return REFRESH_FAILURE_ALERTS.find(([resource]) => state[resource].status === "error");
}

function refreshFailureAlert(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string | null {
  const failure = refreshFailureResource(state);
  return failure === undefined ? null : t(failure[1]);
}

/** The error selected by visibleAlert; never report another resource's concurrent failure. */
export function visibleAlertFailure(
  state: CodingWorkbenchRuntimeState,
): CodingWorkbenchClientError | null {
  if (state.mutation.error !== null) return state.mutation.error;
  const failure = refreshFailureResource(state);
  return failure === undefined ? null : state[failure[0]].error;
}

type StartReadinessResource = "modelSource" | "workspace" | "runtime" | "run";

const START_BLOCKED_KEYS: Readonly<Record<StartReadinessResource, CodingWorkbenchMessageKey>> = {
  modelSource: "codingWorkbench.composer.blocked.modelSource",
  workspace: "codingWorkbench.composer.blocked.workspace",
  runtime: "codingWorkbench.composer.blocked.runtime",
  run: "codingWorkbench.composer.blocked.run",
};

// `startBlockedReason` calls this only after `visibleAlert` returned null, and `visibleAlert`
// already reports every `status === "error"` case through `refreshFailureAlert` — so the "error"
// branch of this helper would be unreachable here. Keep it to two states: ready → null,
// everything else → the blocked sentence.
function resourceStartBlocker(
  resource: StartReadinessResource,
  status: CodingWorkbenchResourceStatus,
  t: CodingWorkbenchTranslate,
): string | null {
  if (status === "ready") return null;
  return t(START_BLOCKED_KEYS[resource]);
}

function sourceStartBlocker(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string | null {
  const blocked = resourceStartBlocker("modelSource", state.source.status, t);
  if (blocked !== null) return blocked;
  const source = state.source.value;
  const sourceReady =
    source?.runtimePreference === state.runtimePreference &&
    source.available &&
    !gatewayVerificationContradictsReadiness(source.verification);
  return sourceReady
    ? null
    : (sourceUnavailableReasonText(source, t) ?? t("codingWorkbench.composer.blocked.modelSource"));
}

function workspaceStartBlocker(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string | null {
  const blocked = resourceStartBlocker("workspace", state.workspace.status, t);
  if (blocked !== null) return blocked;
  const workspace = state.workspace.value;
  return workspace?.health === "healthy" && workspace.switching !== true
    ? null
    : t("codingWorkbench.composer.blocked.workspace");
}

function runtimeStartBlocker(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string | null {
  const blocked = resourceStartBlocker("runtime", state.runtime.status, t);
  if (blocked !== null) return blocked;
  const runtime = state.runtime.value;
  return runtime?.runtimeAvailable === true && runtime.requestedMode === state.requestedMode
    ? null
    : t("codingWorkbench.composer.blocked.runtime");
}

function runStartBlocker(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string | null {
  return resourceStartBlocker("run", state.run.status, t);
}

function readinessStartBlocker(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  return (
    sourceStartBlocker(state, t) ??
    workspaceStartBlocker(state, t) ??
    runtimeStartBlocker(state, t) ??
    runStartBlocker(state, t) ??
    t("codingWorkbench.composer.blocked.notReady")
  );
}

// The standing conditions: properties of the selected source or of this installation, not a failed
// action. They come after actionable refresh failures (one alert at a time — reporting a standing
// condition first would swallow the recoverable error). Pairing remains in the lifecycle narration,
// but it is not useful enough to take over the workbench as a banner.
function standingConditionAlert(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  setupVisible: boolean,
): string | null {
  // The source's own unavailability reason and next step. It reaches a SIGHTED operator only here:
  // the header chip renders "<label> — unavailable" with no reason, and the only other renderer of
  // `sourceUnavailableReasonText` is the source panel, which nothing mounts — so before this branch
  // the remedy existed for the sr-only live region alone (#3381 review). Ungated by `setupVisible`,
  // unlike the runtime note below: the bootstrap setup card states the runtime posture itself but
  // says nothing about the model source, so there is nothing to duplicate.
  const sourceReason = sourceUnavailableReasonText(state.source.value, t);
  if (sourceReason !== null) return sourceReason;
  // Last: the unqualified runtime, and only while the bootstrap setup section is off screen — it
  // states the same condition itself, and duplicating it would announce it twice to assistive
  // technology. This wording is its own: the setup copy invites binding a workspace, which is
  // already done here.
  if (
    !setupVisible &&
    state.runtime.status === "ready" &&
    state.runtime.value?.runtimeAvailable === false
  ) {
    return t("codingWorkbench.alert.runtimeUnqualified");
  }
  return null;
}

// #3565 Observation 17: a start the server refused for a nameable cause gets the sentence that
// tells the operator what to do, not the generic "review the live state and retry". #3603: a model
// whose window cannot hold a coding run's prompt, or whose window is still being verified, says so.
function startRefusalSummaryKey(
  code: string,
  modelRefusalReason?: CodingWorkbenchModelRefusalReason,
): CodingWorkbenchMessageKey {
  if (code === "CODING_RUNTIME_MODEL_UNAVAILABLE") {
    if (modelRefusalReason === "model-context-window-insufficient")
      return "codingWorkbench.alert.startRefusedModelWindow";
    if (modelRefusalReason === "model-verification-pending")
      return "codingWorkbench.alert.startRefusedModelVerificationPending";
    return "codingWorkbench.alert.startRefusedModelUnavailable";
  }
  if (code === "CODING_RUNTIME_WORKSPACE_UNQUALIFIED") {
    return "codingWorkbench.alert.startRefusedWorkspaceUnqualified";
  }
  return "codingWorkbench.alert.actionFailedCode";
}

export function visibleAlert(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  setupVisible: boolean,
  authorityError: string | null = null,
): string | null {
  if (state.mutation.error) {
    return actionFailureAlert(
      startRefusalSummaryKey(state.mutation.error.code, state.mutation.error.modelRefusalReason),
      state.mutation.error,
      t,
    );
  }
  const refreshAlert = refreshFailureAlert(state, t);
  if (refreshAlert !== null) return refreshAlert;
  if (!setupVisible && authorityError !== null) return authorityError;
  return standingConditionAlert(state, t, setupVisible);
}

export function startBlockedReason(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  setupVisible: boolean,
  authorityError: string | null = null,
): string | null {
  if (state.canStart) return null;
  if (state.mutation.status === "pending") return t("codingWorkbench.composer.blocked.busy");
  const alert = visibleAlert(state, t, setupVisible, authorityError);
  if (alert !== null) return alert;
  if (state.pairing === "unknown") return t("codingWorkbench.composer.blocked.pairing");
  if (state.pairing === "unpaired") return t("codingWorkbench.composer.blocked.unpaired");
  return readinessStartBlocker(state, t);
}
