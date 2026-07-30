import { gatewayVerificationContradictsReadiness } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeResearchGrant,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
  GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import type {
  CodingWorkbenchResourceStatus,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";

export type CodingWorkbenchTone = "neutral" | "success" | "warning" | "danger";

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

/**
 * F-01: the source row used to read "Keiko Gateway · Available" from stored configuration alone.
 * This names what a live probe actually said, so an unprobed gateway reads as unconfirmed instead of
 * healthy, and a failed probe is visible rather than hidden behind a configured source.
 */
export function sourceVerificationLabel(
  verification: GatewayVerificationState,
  t: CodingWorkbenchTranslate,
): string {
  return t(`codingWorkbench.source.verification.${verification}`);
}

export function runStateLabel(
  state: CodingWorkbenchRuntimeStateName,
  t: CodingWorkbenchTranslate,
): string {
  return t(`codingWorkbench.runState.${state}`);
}

export function resourceStatusLabel(
  status: CodingWorkbenchResourceStatus,
  t: CodingWorkbenchTranslate,
): string {
  return t(`codingWorkbench.resourceStatus.${status}`);
}

export function resourceStatusSymbol(status: CodingWorkbenchResourceStatus): string {
  if (status === "ready") return "✓";
  if (status === "loading") return "↻";
  if (status === "error" || status === "unavailable") return "!";
  return "○";
}

export function resourceTone(status: CodingWorkbenchResourceStatus): CodingWorkbenchTone {
  if (status === "ready") return "success";
  if (status === "error") return "danger";
  if (status === "unavailable") return "warning";
  return "neutral";
}

function runAnnouncement(state: CodingWorkbenchRuntimeState, t: CodingWorkbenchTranslate): string {
  if (state.run.status === "loading") return t("codingWorkbench.announcement.runChecking");
  const snapshot = state.run.value;
  if (snapshot === null) return t("codingWorkbench.announcement.noActiveRun");
  return t("codingWorkbench.announcement.runRevision", {
    state: runStateLabel(snapshot.state, t),
    revision: snapshot.revision,
  });
}

function setupAnnouncement(
  status: CodingWorkbenchResourceStatus,
  t: CodingWorkbenchTranslate,
): string {
  if (status === "ready") return t("codingWorkbench.announcement.setupReady");
  if (status === "loading") return t("codingWorkbench.announcement.setupChecking");
  if (status === "unavailable") return t("codingWorkbench.announcement.setupUnavailable");
  return "";
}

function researchAnnouncement(
  grant: CodingWorkbenchRuntimeResearchGrant | null,
  t: CodingWorkbenchTranslate,
): string {
  return grant === null ? "" : t("codingWorkbench.announcement.researchActive");
}

export function lifecycleAnnouncement(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  researchGrant: CodingWorkbenchRuntimeResearchGrant | null = null,
): string {
  const snapshot = state.run.value;
  // F-01: the spoken readiness must match the projected one — a source whose last probe failed is
  // announced as unavailable, not ready, exactly as `projectReadiness` treats it.
  const sourceAvailable =
    state.source.value?.runtimePreference === state.runtimePreference &&
    state.source.value.available &&
    !gatewayVerificationContradictsReadiness(state.source.value.verification);
  const workspaceAvailable = state.workspace.value?.health === "healthy";
  const runtimeAvailable = state.runtime.value?.runtimeAvailable === true;
  const recovery =
    snapshot?.state === "recovery-required" && snapshot.recoveryAcknowledged === true
      ? t("codingWorkbench.announcement.recoveryComplete")
      : "";
  return [
    runAnnouncement(state, t),
    pairingAnnouncement(state, t),
    readinessAnnouncement("modelSource", state.source.status, sourceAvailable, t),
    authenticationAnnouncement(state, t),
    readinessAnnouncement("workspace", state.workspace.status, workspaceAvailable, t),
    readinessAnnouncement("runtime", state.runtime.status, runtimeAvailable, t),
    recovery,
    researchAnnouncement(researchGrant, t),
    setupAnnouncement(state.codexSetup.status, t),
  ]
    .filter((announcement) => announcement.length > 0)
    .join(" ");
}

// Release-audit F-08/RG-12: an unpaired window's run start is guaranteed to fail authority
// resolution (ADR-0141), so the narration must name pairing as the missing input instead of
// narrating "Workspace ready. Runtime ready." over a start that can never succeed. Silent while
// pairing is unconfirmed — the narration never claims a truth the workspaces read has not answered.
function pairingAnnouncement(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  return state.pairing === "unpaired" ? t("codingWorkbench.pairing.unpaired") : "";
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

function readinessAnnouncement(
  resource: "modelSource" | "workspace" | "runtime",
  status: CodingWorkbenchResourceStatus,
  available: boolean,
  t: CodingWorkbenchTranslate,
): string {
  const state = readinessAnnouncementState(status, available);
  return t(`codingWorkbench.announcement.${resource}.${state}`);
}

function authenticationAnnouncement(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  if (state.runtimePreference !== "codex-subscription") {
    return t("codingWorkbench.announcement.authenticationNotSelected");
  }
  if (state.profile.status === "loading")
    return t("codingWorkbench.announcement.authenticationChecking");
  if (state.profile.status === "error" || state.profile.status === "unavailable") {
    return t("codingWorkbench.announcement.authenticationUnavailable");
  }
  const profile = state.profile.value;
  if (profile?.status === "connected") return t("codingWorkbench.announcement.authenticationReady");
  if (profile?.status === "missing")
    return t("codingWorkbench.announcement.authenticationRequired");
  if (profile !== null) return t("codingWorkbench.announcement.authenticationUnavailable");
  return t("codingWorkbench.announcement.authenticationNotChecked");
}

export function activeRunState(state: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    state === "starting" ||
    state === "ready" ||
    state === "running" ||
    state === "awaiting-approval" ||
    state === "stopping"
  );
}

export function eventTitle(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  if (event.kind === "status") return runStateLabel(event.state, t);
  return t(`codingWorkbench.event.${event.eventKind}`);
}

export function eventDetail(
  event: CodingWorkbenchRuntimeSseEvent,
  t: CodingWorkbenchTranslate,
): string {
  const base = event.failureCode
    ? t("codingWorkbench.event.detailFailure", {
        sequence: event.sequence,
        revision: event.revision,
        failure: event.failureCode,
      })
    : t("codingWorkbench.event.detail", { sequence: event.sequence, revision: event.revision });
  return [base, eventOutcomeDetail(event, t), eventContentTrustDetail(event, t)]
    .filter((part) => part.length > 0)
    .join(" ");
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
  readonly code: string;
  readonly correlationId?: string | undefined;
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
  const summary = t(summaryKey, { code: failure.code });
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

export function visibleAlert(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
  setupVisible: boolean,
): string | null {
  if (state.mutation.error) {
    return actionFailureAlert("codingWorkbench.alert.actionFailedCode", state.mutation.error, t);
  }
  for (const [resource, value] of [
    ["authentication", state.profile],
    ["authenticationSetup", state.codexSetup],
    ["modelSource", state.source],
    ["runtime", state.runtime],
    ["workspace", state.workspace],
    ["run", state.run],
    ["eventStream", state.stream],
  ] as const) {
    if (value.status === "error") return t(`codingWorkbench.alert.${resource}RefreshFailed`);
  }
  // Standing conditions come after actionable refresh failures (one alert at a time — reporting a
  // standing condition first would swallow the recoverable error). The unpaired window (F-08/
  // RG-12) precedes the unqualified runtime: without a paired app session no run can start at all.
  if (state.pairing === "unpaired") return t("codingWorkbench.pairing.unpaired");
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
