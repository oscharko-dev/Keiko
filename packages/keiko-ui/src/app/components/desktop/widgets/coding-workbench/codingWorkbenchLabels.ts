import type {
  CodingWorkbenchMode,
  CodingWorkbenchModelSource,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { I18nTranslate } from "@/lib/i18n";
import type {
  CodingWorkbenchResourceStatus,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";

export type CodingWorkbenchTone = "neutral" | "success" | "warning" | "danger";

export function cx(...classes: readonly (string | undefined | false)[]): string {
  return classes.filter((value): value is string => typeof value === "string").join(" ");
}

export function modeLabel(mode: CodingWorkbenchMode, t: I18nTranslate): string {
  return t(`codingWorkbench.mode.${mode}.label`);
}

export function modeDescription(mode: CodingWorkbenchMode, t: I18nTranslate): string {
  return t(`codingWorkbench.mode.${mode}.description`);
}

export function modelSourceLabel(source: CodingWorkbenchModelSource, t: I18nTranslate): string {
  if (source === "keiko-model-gateway") return t("codingWorkbench.modelSource.gateway");
  if (source === "openai-api-key-through-gateway")
    return t("codingWorkbench.modelSource.openaiGateway");
  return t("codingWorkbench.modelSource.codexSubscription");
}

export function runStateLabel(state: CodingWorkbenchRuntimeStateName, t: I18nTranslate): string {
  return t(`codingWorkbench.runState.${state}`);
}

export function resourceStatusLabel(
  status: CodingWorkbenchResourceStatus,
  t: I18nTranslate,
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

export function lifecycleAnnouncement(
  state: CodingWorkbenchRuntimeState,
  t: I18nTranslate,
): string {
  const snapshot = state.run.value;
  const run =
    state.run.status === "loading"
      ? t("codingWorkbench.announcement.runChecking")
      : snapshot === null
        ? t("codingWorkbench.announcement.noActiveRun")
        : t("codingWorkbench.announcement.runRevision", {
            state: runStateLabel(snapshot.state, t),
            revision: snapshot.revision,
          });
  const sourceAvailable =
    state.source.value?.runtimePreference === state.runtimePreference &&
    state.source.value.available;
  const workspaceAvailable = state.workspace.value?.health === "healthy";
  const runtimeAvailable = state.runtime.value?.runtimeAvailable === true;
  const recovery =
    snapshot?.state === "recovery-required" && snapshot.recoveryAcknowledged === true
      ? t("codingWorkbench.announcement.recoveryComplete")
      : "";
  const setup =
    state.codexSetup.status === "ready"
      ? t("codingWorkbench.announcement.setupReady")
      : state.codexSetup.status === "loading"
        ? t("codingWorkbench.announcement.setupChecking")
        : state.codexSetup.status === "unavailable"
          ? t("codingWorkbench.announcement.setupUnavailable")
          : "";
  return [
    run,
    readinessAnnouncement("modelSource", state.source.status, sourceAvailable, t),
    authenticationAnnouncement(state, t),
    readinessAnnouncement("workspace", state.workspace.status, workspaceAvailable, t),
    readinessAnnouncement("runtime", state.runtime.status, runtimeAvailable, t),
    recovery,
    setup,
  ]
    .filter((announcement) => announcement.length > 0)
    .join(" ");
}

function readinessAnnouncement(
  resource: "modelSource" | "workspace" | "runtime",
  status: CodingWorkbenchResourceStatus,
  available: boolean,
  t: I18nTranslate,
): string {
  const state =
    status === "loading"
      ? "checking"
      : status === "error"
        ? "refreshFailed"
        : status === "unavailable" || (status === "ready" && !available)
          ? "unavailable"
          : status === "ready"
            ? "ready"
            : status === "empty"
              ? "notSelected"
              : "notChecked";
  return t(`codingWorkbench.announcement.${resource}.${state}`);
}

function authenticationAnnouncement(state: CodingWorkbenchRuntimeState, t: I18nTranslate): string {
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

export function eventTitle(event: CodingWorkbenchRuntimeSseEvent, t: I18nTranslate): string {
  if (event.kind === "status") return runStateLabel(event.state, t);
  return t(`codingWorkbench.event.${event.eventKind}`);
}

export function eventDetail(event: CodingWorkbenchRuntimeSseEvent, t: I18nTranslate): string {
  return event.failureCode
    ? t("codingWorkbench.event.detailFailure", {
        sequence: event.sequence,
        revision: event.revision,
        failure: event.failureCode,
      })
    : t("codingWorkbench.event.detail", { sequence: event.sequence, revision: event.revision });
}

export function visibleAlert(state: CodingWorkbenchRuntimeState, t: I18nTranslate): string | null {
  if (state.mutation.error) return t("codingWorkbench.alert.actionFailed");
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
  return null;
}
