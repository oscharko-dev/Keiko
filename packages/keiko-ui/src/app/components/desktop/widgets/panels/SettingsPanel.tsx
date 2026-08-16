"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  gatewayVerificationContradictsReadiness,
  gatewayVerificationFromProbeOutcome,
  UNVERIFIED_GATEWAY,
  VOICE_PERSONAS,
  type GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import {
  applyGatewayVerifiedCapabilities,
  fetchConfig,
  fetchModels,
  runGatewayReadiness,
  type VerifiedGatewayCapabilityFields,
} from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  LOCALE_LABELS,
  useLocale,
  useSetLocale,
  useTranslate as useGlobalTranslate,
} from "@/lib/i18n";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import { DynamicChunkLoadFailure } from "../../DynamicChunkLoadFailure";
import { DebuggingSettings } from "./DebuggingSettings";
import { EditorSettingsPanel } from "./EditorSettingsPanel";
import { ManagedLanguageSettings } from "./ManagedLanguageSettings";
import { AutonomySettings } from "./AutonomySettings";
import { OPEN_EDITOR_SETTINGS_EVENT } from "./settingsPanelEvents";
import type {
  ConversationIneligibilityReason,
  GatewayReadinessProbeResult,
  GatewayReadinessReport,
  ModelCapability,
  SafeGatewayConfig,
  VoicePersona,
} from "@/lib/types";
import {
  describeVoiceProviderAvailability,
  explainConversationIneligibility,
  isConfiguredVoiceProvider,
  isConversationEligibleModel,
} from "@/lib/types";
import { Icons } from "../../Icons";

import KeikoSelect from "../../KeikoSelect";
import { personaLabel } from "../../VoiceDialogMode";
import {
  readVoicePersonaPreference,
  VOICE_PERSONA_CHANGED_EVENT,
  VOICE_PERSONA_STORAGE_KEY,
  writeVoicePersonaPreference,
} from "../../hooks/useVoiceDialogMode";
import { Toggle } from "../shared/Toggle";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  GATEWAY_SETUP_REQUEST_EVENT,
  consumePendingGatewaySetup,
  notifyGatewayConfigUpdated,
  notifyGatewayModelReadinessUpdated,
} from "../shared/gatewaySetupBus";
import {
  WALLPAPER_ENABLED_EVENT,
  WALLPAPER_ENABLED_KEY,
  WALLPAPER_OPACITY_EVENT,
  WALLPAPER_OPACITY_KEY,
  FRAME_INNER_GLOW_STRENGTH_EVENT,
  FRAME_INNER_GLOW_STRENGTH_KEY,
  FRAME_BORDER_STRENGTH_EVENT,
  FRAME_BORDER_STRENGTH_KEY,
  applyFrameInnerGlowStrength,
  WORKSPACE_BACKGROUND_BRIGHTNESS_EVENT,
  WORKSPACE_BACKGROUND_BRIGHTNESS_KEY,
  WORKSPACE_GRID_STRENGTH_EVENT,
  WORKSPACE_GRID_STRENGTH_KEY,
  WORKSPACE_CAMERA_SMOOTHNESS_EVENT,
  WORKSPACE_CAMERA_SMOOTHNESS_KEY,
  applyFrameBorderStrength,
  applyWorkspaceBackgroundBrightness,
  applyWorkspaceGridStrength,
  readFrameBorderStrength,
  readFrameInnerGlowStrength,
  readWallpaperEnabled,
  readWallpaperOpacity,
  readWorkspaceBackgroundBrightness,
  readWorkspaceCameraSmoothness,
  readWorkspaceGridStrength,
} from "../../workspace-appearance";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import editorStyles from "./EditorSettingsPanel.module.css";

// The gateway setup dialog is reached only by an explicit gesture (`setupOpen`), exactly like the
// shell's own gesture-only modals (ADR-0042 D3.6) — a static import here pulled the whole dialog
// (and the config-upload import surface behind it) into the first-load chunk. A failed chunk load
// must not leave `setupOpen` true with nothing on screen — the shared fallback surfaces the
// redacted error and a retry (review finding on #3031).
const GatewaySetupDialog = dynamic(
  () => import("../../modals/GatewaySetupDialog").then((mod) => mod.GatewaySetupDialog),
  { ssr: false, loading: DynamicChunkLoadFailure },
);

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CopyIcon = Icons.copy;
const ActivityIcon = Icons.activity;
const BrowserIcon = Icons.browser;
const MicIcon = Icons.mic;
const PlusIcon = Icons.plus;
const CubeIcon = Icons.cube;

const SettingsIcon = Icons.settings;

function kindLabel(kind: ModelCapability["kind"]): string {
  if (kind === "ocr-vision") return "OCR";
  return kind;
}

// Issue #144 AC #3: returns the human-readable explanation for an
// ineligibility reason. Pure function of the typed reason — never reads
// model.baseUrl / model.apiKey / anything credential-shaped (those fields do
// not exist on ModelCapability by design; this comment pins the invariant).
function conversationIneligibilityLabel(
  reason: ConversationIneligibilityReason,
  t: I18nTranslate,
): string {
  if (reason === "embedding-only") return t("settings.models.ineligibleEmbedding");
  if (reason === "ocr-vision-only") return t("settings.models.ineligibleOcr");
  return t("settings.models.ineligibleGeneric");
}

function embeddingAvailabilityLabel(t: I18nTranslate): string {
  return t("settings.models.embeddingAvailable");
}

// Issue #1557 (AC4, ADR-0094 D5): a content-free, human-readable description of a configured voice
// provider's availability, so the model list presents it as available (with its voice capabilities
// and the personas it offers) rather than a chat-ineligibility warning. Reads only enum/boolean
// fields — never a base URL, credential, or provider voice id.
function voiceProviderAvailabilityLabel(model: ModelCapability, t: I18nTranslate): string {
  const availability = describeVoiceProviderAvailability(model);
  const capabilities: string[] = [];
  if (availability.speechToText)
    capabilities.push(t("settings.models.voiceCapabilitySpeechToText"));
  if (availability.speechOutput)
    capabilities.push(t("settings.models.voiceCapabilitySpeechOutput"));
  if (availability.realtimeVoice) {
    capabilities.push(t("settings.models.voiceCapabilityRealtimeDialogue"));
  }
  const capabilityText =
    capabilities.length > 0 ? capabilities.join(", ") : t("settings.models.voiceCapabilityVoice");
  const personaText =
    availability.personas.length > 0
      ? t("settings.models.voicePersonas", { personas: availability.personas.join(", ") })
      : "";
  return t("settings.models.voiceProviderAvailable", {
    capabilities: capabilityText,
    personas: personaText,
  });
}

// Short visible badge copy for a configured voice provider (the long form stays in aria-label/title).
function voiceProviderShortLabel(model: ModelCapability, t: I18nTranslate): string {
  const availability = describeVoiceProviderAvailability(model);
  if (availability.realtimeVoice) return t("settings.models.voiceCapabilityRealtimeDialogue");
  if (availability.speechOutput) return t("settings.models.voiceCapabilitySpeechOutput");
  if (availability.speechToText) return t("settings.models.voiceCapabilitySpeechToText");
  return t("settings.models.voiceCapabilityVoice");
}

function voicePersonasFromModels(models: readonly ModelCapability[]): readonly VoicePersona[] {
  const present = new Set<VoicePersona>();
  for (const model of models) {
    for (const persona of describeVoiceProviderAvailability(model).personas) {
      present.add(persona);
    }
  }
  return VOICE_PERSONAS.filter((persona) => present.has(persona));
}

// uiux-fix C359/C057: short visible badge copy — the long form stays in
// aria-label/title so the model list does not read like a transport warning.
function conversationIneligibilityShortLabel(
  reason: ConversationIneligibilityReason,
  t: I18nTranslate,
): string {
  if (reason === "ocr-vision-only") return t("settings.models.ineligibleShortOcr");
  return t("settings.models.ineligibleShortGeneric");
}

function ConversationEligibilityBadge({ model }: { readonly model: ModelCapability }): ReactNode {
  const t = useTranslate();
  const reason = explainConversationIneligibility(model);
  // Issue #1557 (AC4): a correctly configured voice provider is available for its voice purpose, not a
  // chat-ineligibility warning. `isConversationEligibleModel` stays unchanged (voice is genuinely not
  // a chat model) — only the presentation differs.
  if (isConfiguredVoiceProvider(model)) {
    const label = voiceProviderAvailabilityLabel(model, t);
    return (
      <output
        className="ml-elig ml-elig-voice"
        data-testid="voice-elig-ok"
        aria-label={t("settings.models.eligibilityPrefix", { label })}
        title={label}
      >
        {t("settings.models.voiceProviderBadge", { label: voiceProviderShortLabel(model, t) })}
      </output>
    );
  }
  if (reason === undefined) {
    return (
      <output
        className="ml-elig ml-elig-ok"
        data-testid="conv-elig-ok"
        aria-label={t("settings.models.eligibilityOkAria")}
      >
        {t("settings.models.eligibilityOk")}
      </output>
    );
  }
  if (reason === "embedding-only") {
    const label = embeddingAvailabilityLabel(t);
    return (
      <output
        className="ml-elig ml-elig-embed"
        data-testid="embedding-elig-ok"
        aria-label={t("settings.models.eligibilityPrefix", { label })}
        title={label}
      >
        {t("settings.models.embeddingLabel")}
      </output>
    );
  }
  const label = conversationIneligibilityLabel(reason, t);
  return (
    <output
      className="ml-elig ml-elig-no"
      data-testid="conv-elig-no"
      aria-label={t("settings.models.eligibilityPrefix", { label })}
      title={label}
    >
      {t("settings.models.notSelectable", {
        reason: conversationIneligibilityShortLabel(reason, t),
      })}
    </output>
  );
}

type ReadinessRunState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly deep: boolean }
  | { readonly status: "done"; readonly report: GatewayReadinessReport }
  | { readonly status: "error"; readonly message: string };

type ReportCopyState = "idle" | "copied" | "failed";

/**
 * F-02 (review of #2847): a readiness run is live evidence about ONE gateway configuration, so the
 * panel remembers runs together with the configuration generation they measured instead of in a bare
 * model-keyed map. This mirrors the server holder that owns `verification()`: there, replacing the
 * config through `set()` structurally invalidates the recorded verdict, and a verdict whose observed
 * generation is stale is dropped rather than recorded. The panel needs the identical two guards —
 * a superseded generation never reaches the display, and a run that started before a configuration
 * change never overwrites what the current configuration measured.
 */
interface ReadinessLedger {
  readonly generation: number;
  readonly runs: Record<string, ReadinessRunState>;
}

const NO_READINESS_RUNS: Record<string, ReadinessRunState> = {};
const INITIAL_READINESS_LEDGER: ReadinessLedger = { generation: 0, runs: NO_READINESS_RUNS };

/**
 * The remembered runs that describe the CURRENT configuration. A ledger left behind by a superseded
 * generation contributes nothing: neither the gateway verification badge nor a per-model readiness
 * summary may outlive the configuration it was measured against.
 */
function readinessRunsForGeneration(
  ledger: ReadinessLedger,
  generation: number,
): Record<string, ReadinessRunState> {
  return ledger.generation === generation ? ledger.runs : NO_READINESS_RUNS;
}

/**
 * Records one run under the generation it observed. A verdict that resolves after the configuration
 * changed keeps its own (older) generation and therefore stays out of the display, and it may never
 * clobber a ledger a newer configuration has already written.
 */
function recordReadinessRun(
  ledger: ReadinessLedger,
  observedGeneration: number,
  modelId: string,
  state: ReadinessRunState,
): ReadinessLedger {
  if (observedGeneration < ledger.generation) return ledger;
  const runs = observedGeneration === ledger.generation ? ledger.runs : NO_READINESS_RUNS;
  return { generation: observedGeneration, runs: { ...runs, [modelId]: state } };
}

function clearReadinessRun(
  ledger: ReadinessLedger,
  generation: number,
  modelId: string,
): ReadinessLedger {
  if (ledger.generation !== generation || ledger.runs[modelId] === undefined) return ledger;
  const runs = { ...ledger.runs };
  Reflect.deleteProperty(runs, modelId);
  return { generation, runs };
}

/**
 * A value identity for the configuration the panel currently holds. Credential-free by construction
 * (the safe projection carries no key or base URL), so a rotated credential is invisible here and
 * arrives as GATEWAY_CONFIG_UPDATED_EVENT instead; this catches the replacements that ARE visible —
 * a different provider/model set, or the configuration disappearing entirely.
 */
function gatewayConfigIdentity(config: SafeGatewayConfig | null, present: boolean): string {
  if (!present) return "absent";
  if (config === null) return "present";
  return `present:${JSON.stringify(config.providers)}`;
}

function readinessErrorMessage(error: unknown, t: I18nTranslate): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return t("settings.models.readinessError");
}

function capabilityLine(report: GatewayReadinessReport): string {
  const capabilities = report.verifiedCapabilities;
  const values = [
    ["streaming", capabilities.streaming],
    ["toolCalling", capabilities.toolCalling],
    ["structuredOutput", capabilities.structuredOutput],
    ["reasoningOutput", capabilities.reasoningOutput],
    ["imageInput", capabilities.imageInput],
    ["documentInput", capabilities.documentInput],
  ] as const;
  const rendered = values.map(([name, enabled]) => `${name}=${enabled === true ? "yes" : "no"}`);
  if (capabilities.testedContextTokens !== undefined) {
    rendered.push(`testedContextTokens=${capabilities.testedContextTokens.toString()}`);
  }
  return rendered.join(", ");
}

function probeLine(probe: GatewayReadinessProbeResult): string {
  const warning = probe.warning === undefined ? "" : ` Warning: ${probe.warning}`;
  return `- ${probe.name}: ${probe.status} (${probe.latencyMs.toString()} ms) ${probe.evidence}${warning}`;
}

export function formatGatewayReadinessReport(report: GatewayReadinessReport): string {
  return [
    "Keiko Gateway Readiness Report",
    `Model: ${report.modelId}`,
    `Checked at: ${report.checkedAt}`,
    `Overall status: ${report.overallStatus}`,
    `Verified capabilities: ${capabilityLine(report)}`,
    "",
    "Probes:",
    ...report.probes.map(probeLine),
    "",
    "Raw JSON:",
    JSON.stringify(report, null, 2),
  ].join("\n");
}

function probePassed(report: GatewayReadinessReport, name: string): boolean {
  return report.probes.some((probe) => probe.name === name && probe.status === "passed");
}

function firstActionableProbeMessage(report: GatewayReadinessReport): string | undefined {
  const issue = report.probes.find(
    (probe) => probe.status !== "passed" && probe.status !== "skipped",
  );
  return issue?.warning ?? issue?.evidence;
}

type ObservableCapabilityField = keyof VerifiedGatewayCapabilityFields;

interface CapabilityDisagreement {
  readonly field: ObservableCapabilityField;
  readonly configured: boolean | number;
  readonly observed: boolean | number;
}

const BOOLEAN_CAPABILITY_PROBES = [
  ["streaming", "streaming"],
  ["toolCalling", "tool_calling"],
  ["structuredOutput", "json_schema"],
  ["supportsImageInput", "image_input"],
  ["supportsDocumentInput", "document_input"],
] as const satisfies readonly (readonly [ObservableCapabilityField, string])[];

function observedProbeValue(
  report: GatewayReadinessReport,
  probeName: string,
): boolean | undefined {
  const probe = report.probes.find((candidate) => candidate.name === probeName);
  if (probe?.status === "passed") return true;
  return probe?.capabilityObservation;
}

function capabilityDisagreements(
  model: ModelCapability,
  report: GatewayReadinessReport,
): readonly CapabilityDisagreement[] {
  const disagreements: CapabilityDisagreement[] = [];
  for (const [field, probe] of BOOLEAN_CAPABILITY_PROBES) {
    const observed = observedProbeValue(report, probe);
    const configured = model[field];
    if (observed !== undefined && configured !== observed) {
      disagreements.push({ field, configured, observed });
    }
  }
  return disagreements;
}

function capabilityFieldLabel(field: ObservableCapabilityField, t: I18nTranslate): string {
  if (field === "toolCalling") return t("settings.models.capabilityTools");
  if (field === "structuredOutput") return t("settings.models.capabilityJson");
  if (field === "supportsImageInput") return t("settings.models.capabilityImage");
  if (field === "supportsDocumentInput") return t("settings.models.capabilityPdf");
  return t("settings.models.capabilityStreaming");
}

function displayCapabilityValue(value: boolean | number, t: I18nTranslate): string {
  if (typeof value === "number") return value.toLocaleString();
  return value ? t("settings.models.yes") : t("settings.models.no");
}

function CapabilityApplyConfirmDialog({
  onAccept,
  onDecline,
}: {
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}): ReactNode {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const decline = useEffectEvent(onDecline);
  useDialogTabTrap(dialogRef);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") decline();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);
  return (
    <div className={editorStyles.confirmBackdrop}>
      <div
        ref={dialogRef}
        className={editorStyles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="capability-apply-confirm-title"
        aria-describedby="capability-apply-confirm-body"
        tabIndex={-1}
      >
        <h4 className={editorStyles.confirmTitle} id="capability-apply-confirm-title">
          {t("settings.models.applyVerifiedConfirmTitle")}
        </h4>
        <p className={editorStyles.confirmBody} id="capability-apply-confirm-body">
          {t("settings.models.applyVerifiedConfirm")}
        </p>
        <div className={editorStyles.confirmActions}>
          <button type="button" className={editorStyles.button} onClick={onDecline}>
            {t("settings.models.applyVerifiedDecline")}
          </button>
          <button type="button" className={editorStyles.button} onClick={onAccept}>
            {t("settings.models.applyVerifiedAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CapabilityDisagreementActions({
  model,
  report,
  observedGeneration,
  onApplied,
}: {
  readonly model: ModelCapability;
  readonly report: GatewayReadinessReport;
  readonly observedGeneration: number;
  readonly onApplied: (model: ModelCapability, observedGeneration: number) => void;
}): ReactNode {
  const t = useTranslate();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const disagreements = capabilityDisagreements(model, report);
  if (disagreements.length === 0) return null;
  const apply = async (): Promise<void> => {
    setApplying(true);
    setApplyError(undefined);
    try {
      const fields = Object.fromEntries(
        disagreements.map(({ field, observed }) => [field, observed]),
      ) as VerifiedGatewayCapabilityFields;
      const response = await applyGatewayVerifiedCapabilities(model.id, fields);
      onApplied(response.model, observedGeneration);
    } catch (error) {
      setApplyError(readinessErrorMessage(error, t));
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="ml-rwarn" data-testid="capability-disagreements">
      <div>{t("settings.models.capabilityDisagreement")}</div>
      {disagreements.map(({ field, configured, observed }) => (
        <div className="mono" key={field}>
          {t("settings.models.capabilityDifference", {
            field: capabilityFieldLabel(field, t),
            configured: displayCapabilityValue(configured, t),
            observed: displayCapabilityValue(observed, t),
          })}
        </div>
      ))}
      <button
        type="button"
        className="ml-check secondary"
        disabled={applying}
        onClick={() => setConfirmOpen(true)}
      >
        {applying
          ? t("settings.models.applyingVerified")
          : t("settings.models.applyVerifiedValues")}
      </button>
      {applyError === undefined ? null : (
        <div role="alert">
          {t("settings.models.applyVerifiedFailed")} {applyError}
        </div>
      )}
      {confirmOpen ? (
        <CapabilityApplyConfirmDialog
          onAccept={() => {
            setConfirmOpen(false);
            void apply();
          }}
          onDecline={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ReadinessReportCopyButton({
  report,
}: {
  readonly report: GatewayReadinessReport;
}): ReactNode {
  const t = useTranslate();
  const [copyState, setCopyState] = useState<ReportCopyState>("idle");
  const [status, setStatus] = useState("");

  async function handleCopy(): Promise<void> {
    try {
      await copyTextToClipboard(formatGatewayReadinessReport(report));
      setCopyState("copied");
      setStatus(t("settings.models.reportCopied"));
    } catch {
      setCopyState("failed");
      setStatus(t("settings.models.reportCopyFailed"));
    }
  }

  return (
    <>
      <button
        type="button"
        className="ml-check secondary"
        data-copied={copyState === "copied" ? "true" : "false"}
        data-failed={copyState === "failed" ? "true" : "false"}
        onClick={() => {
          void handleCopy();
        }}
      >
        <CopyIcon size={12} aria-hidden="true" />
        {copyState === "copied" ? t("settings.models.copied") : t("settings.models.copyReport")}
      </button>
      {/* <output> already carries role=status; only the failure branch overrides it. role=alert
          is implicitly assertive, so aria-live is dropped on that branch — the two together are
          a conflicting live-region declaration that screen readers resolve inconsistently. */}
      <output
        className="ml-url mono"
        role={copyState === "failed" ? "alert" : undefined}
        aria-live={copyState === "failed" ? undefined : "polite"}
      >
        {status}
      </output>
    </>
  );
}

function ReadinessSummary({
  model,
  state,
  observedGeneration,
  onCapabilityApplied,
}: {
  readonly model: ModelCapability;
  readonly state: ReadinessRunState | undefined;
  readonly observedGeneration: number;
  readonly onCapabilityApplied: (model: ModelCapability, observedGeneration: number) => void;
}): ReactNode {
  const t = useTranslate();
  if (state === undefined || state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <output className="ml-readiness" style={NATIVE_BLOCK_STYLE}>
        {t("settings.models.checkingReadiness", {
          mode: state.deep
            ? t("settings.models.readinessModeDeep")
            : t("settings.models.readinessModeBasic"),
        })}
      </output>
    );
  }
  if (state.status === "error") {
    return (
      <div className="ml-readiness ml-readiness-error" role="alert">
        {state.message}
      </div>
    );
  }
  const report = state.report;
  const workingToday = probePassed(report, "chat");
  const warning = firstActionableProbeMessage(report);
  return (
    <div className="ml-readiness">
      <div className="ml-rrow">
        <div className="ml-rsummary">
          <div className="ml-rhead">
            {/* The live region is the concise status line, not the summary subtree around it:
                <output> is phrasing content and cannot wrap these blocks, and announcing every
                badge on each re-check floods the reader. <output> already carries role=status;
                only the failure branch overrides it (#2721). */}
            <output
              className={"ml-rstatus " + report.overallStatus}
              role={report.overallStatus === "failed" ? "alert" : undefined}
            >
              {workingToday ? t("settings.models.workingToday") : t("settings.models.notVerified")}
            </output>
            <span className="ml-rtime mono">{new Date(report.checkedAt).toLocaleTimeString()}</span>
          </div>
          <div className="ml-rbadges" aria-label={t("settings.models.verifiedCapabilities")}>
            {probePassed(report, "streaming") ? (
              <span>{t("settings.models.capabilityStreaming")}</span>
            ) : null}
            {probePassed(report, "tool_calling") ? (
              <span>{t("settings.models.capabilityTools")}</span>
            ) : null}
            {probePassed(report, "json_schema") ? (
              <span>{t("settings.models.capabilityJson")}</span>
            ) : null}
            {probePassed(report, "reasoning") ? (
              <span>{t("settings.models.capabilityReasoning")}</span>
            ) : null}
            {probePassed(report, "image_input") ? (
              <span>{t("settings.models.capabilityImage")}</span>
            ) : null}
            {probePassed(report, "document_input") ? (
              <span>{t("settings.models.capabilityPdf")}</span>
            ) : null}
            {report.verifiedCapabilities.testedContextTokens !== undefined ? (
              <span>
                {t("settings.models.contextTokensShort", {
                  count: report.verifiedCapabilities.testedContextTokens.toLocaleString(),
                })}
              </span>
            ) : null}
          </div>
          {warning !== undefined ? <div className="ml-rwarn">{warning}</div> : null}
          <CapabilityDisagreementActions
            model={model}
            report={report}
            observedGeneration={observedGeneration}
            onApplied={onCapabilityApplied}
          />
        </div>
      </div>
    </div>
  );
}

// #2723 (S3358): the row status title was a nested ternary (conversationEligible ? … :
// embeddingReady ? … : voiceReady ? … : …); extracted to a named if/else-if chain.
function modelStatusTitle(
  model: ModelCapability,
  conversationEligible: boolean,
  embeddingReady: boolean,
  voiceReady: boolean,
  t: I18nTranslate,
): string {
  if (conversationEligible) return t("settings.models.statusConversationEligible");
  if (embeddingReady) return t("settings.models.statusEmbedding");
  if (voiceReady) return voiceProviderAvailabilityLabel(model, t);
  return t("settings.models.statusNotSelectable");
}

function ModelCapabilityRow({
  model,
  readiness,
  observedGeneration,
  onRunReadiness,
  onCapabilityApplied,
}: {
  readonly model: ModelCapability;
  readonly readiness: ReadinessRunState | undefined;
  readonly observedGeneration: number;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
  readonly onCapabilityApplied: (model: ModelCapability, observedGeneration: number) => void;
}): ReactNode {
  const t = useTranslate();
  const conversationEligible = isConversationEligibleModel(model);
  const embeddingReady = model.kind === "embedding";
  const voiceReady = isConfiguredVoiceProvider(model);
  const statusClass =
    conversationEligible || embeddingReady || voiceReady ? "connected" : "ineligible";
  const statusTitle = modelStatusTitle(model, conversationEligible, embeddingReady, voiceReady, t);
  const RowIcon = model.kind === "voice" ? Icons.mic : Icons.cube;
  return (
    <div className="ml-row">
      <span className="ml-ico">
        <RowIcon size={16} />
      </span>
      <div className="ml-info">
        <div className="ml-top">
          <span className="ml-name">{model.id}</span>
          <span className="ml-type mono">{kindLabel(model.kind)}</span>
          <ConversationEligibilityBadge model={model} />
        </div>
        <div className="ml-url mono">
          {t("settings.models.capabilitySummary", {
            tools: model.toolCalling ? t("settings.models.yes") : t("settings.models.no"),
            structured: model.structuredOutput ? t("settings.models.yes") : t("settings.models.no"),
            costClass: model.costClass,
            latencyClass: model.latencyClass,
          })}
        </div>
        <ReadinessSummary
          model={model}
          state={readiness}
          observedGeneration={observedGeneration}
          onCapabilityApplied={onCapabilityApplied}
        />
      </div>
      {conversationEligible ? (
        <div className="ml-actions">
          <button
            type="button"
            className="ml-check"
            disabled={readiness?.status === "running"}
            onClick={() => onRunReadiness(model.id, false)}
          >
            <ActivityIcon size={13} />
            {t("settings.models.runReadiness")}
          </button>
          <button
            type="button"
            className="ml-check secondary"
            disabled={readiness?.status === "running"}
            onClick={() => onRunReadiness(model.id, true)}
          >
            {t("settings.models.deepProbes")}
          </button>
          {readiness?.status === "done" ? (
            <ReadinessReportCopyButton report={readiness.report} />
          ) : null}
        </div>
      ) : null}
      <span className={"ml-status " + statusClass} title={statusTitle} aria-hidden="true" />
    </div>
  );
}

interface GeneralPrefsProps {
  readonly voicePersonas: readonly VoicePersona[];
  readonly openUpdatesWindow?: (() => void) | undefined;
}

function GeneralPrefs({ voicePersonas, openUpdatesWindow }: GeneralPrefsProps): ReactNode {
  const locale = useLocale();
  const setLocale = useSetLocale();
  const t = useTranslate();
  const voicePersonaOptions = useMemo(
    () => (voicePersonas.length > 0 ? voicePersonas : VOICE_PERSONAS),
    [voicePersonas],
  );
  const [voicePersona, setVoicePersona] = useState<VoicePersona>(
    () => readVoicePersonaPreference(voicePersonaOptions) ?? voicePersonaOptions[0]!,
  );
  const [wallpaperEnabled, setWallpaperEnabled] = useState<boolean>(readWallpaperEnabled);
  const [wp, setWp] = useState<number>(readWallpaperOpacity);
  const [bgBrightness, setBgBrightness] = useState<number>(readWorkspaceBackgroundBrightness);
  const [gridStrength, setGridStrength] = useState<number>(readWorkspaceGridStrength);
  const [cameraSmoothness, setCameraSmoothness] = useState<number>(readWorkspaceCameraSmoothness);
  const [frameBorderStrength, setFrameBorderStrength] = useState<number>(readFrameBorderStrength);
  const [frameInnerGlowStrength, setFrameInnerGlowStrength] = useState<number>(
    readFrameInnerGlowStrength,
  );

  useEffect(() => {
    setVoicePersona(readVoicePersonaPreference(voicePersonaOptions) ?? voicePersonaOptions[0]!);
  }, [voicePersonaOptions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const applyStoredPreference = (): void => {
      setVoicePersona(readVoicePersonaPreference(voicePersonaOptions) ?? voicePersonaOptions[0]!);
    };
    const applyStoragePreference = (event: StorageEvent): void => {
      if (event.key === VOICE_PERSONA_STORAGE_KEY) {
        applyStoredPreference();
      }
    };
    window.addEventListener(VOICE_PERSONA_CHANGED_EVENT, applyStoredPreference);
    window.addEventListener("storage", applyStoragePreference);
    return () => {
      window.removeEventListener(VOICE_PERSONA_CHANGED_EVENT, applyStoredPreference);
      window.removeEventListener("storage", applyStoragePreference);
    };
  }, [voicePersonaOptions]);

  const voiceSections = [
    {
      options: voicePersonaOptions.map((persona) => ({
        value: persona,
        label: personaLabel(persona),
      })),
    },
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WALLPAPER_ENABLED_KEY, wallpaperEnabled ? "true" : "false");
    } catch {
      /* ignore quota / private mode */
    }
    window.dispatchEvent(new CustomEvent(WALLPAPER_ENABLED_EVENT, { detail: wallpaperEnabled }));
  }, [wallpaperEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WALLPAPER_OPACITY_KEY, String(wp));
    } catch {
      /* ignore quota / private mode */
    }
    window.dispatchEvent(new CustomEvent(WALLPAPER_OPACITY_EVENT, { detail: wp }));
  }, [wp]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKSPACE_BACKGROUND_BRIGHTNESS_KEY, String(bgBrightness));
    } catch {
      /* ignore quota / private mode */
    }
    applyWorkspaceBackgroundBrightness(bgBrightness);
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_BACKGROUND_BRIGHTNESS_EVENT, { detail: bgBrightness }),
    );
  }, [bgBrightness]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKSPACE_GRID_STRENGTH_KEY, String(gridStrength));
    } catch {
      /* ignore quota / private mode */
    }
    applyWorkspaceGridStrength(gridStrength);
    window.dispatchEvent(new CustomEvent(WORKSPACE_GRID_STRENGTH_EVENT, { detail: gridStrength }));
  }, [gridStrength]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WORKSPACE_CAMERA_SMOOTHNESS_KEY, String(cameraSmoothness));
    } catch {
      /* ignore quota / private mode */
    }
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_CAMERA_SMOOTHNESS_EVENT, { detail: cameraSmoothness }),
    );
  }, [cameraSmoothness]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(FRAME_BORDER_STRENGTH_KEY, String(frameBorderStrength));
    } catch {
      /* ignore quota / private mode */
    }
    applyFrameBorderStrength(frameBorderStrength);
    window.dispatchEvent(
      new CustomEvent(FRAME_BORDER_STRENGTH_EVENT, { detail: frameBorderStrength }),
    );
  }, [frameBorderStrength]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(FRAME_INNER_GLOW_STRENGTH_KEY, String(frameInnerGlowStrength));
    } catch {
      /* ignore quota / private mode */
    }
    applyFrameInnerGlowStrength(frameInnerGlowStrength);
    window.dispatchEvent(
      new CustomEvent(FRAME_INNER_GLOW_STRENGTH_EVENT, { detail: frameInnerGlowStrength }),
    );
  }, [frameInnerGlowStrength]);

  // CSS uses --p to fill the track; React's CSSProperties doesn't know custom props.
  const fill: CSSProperties = { ["--p"]: `${String(wp)}%` } as CSSProperties;
  const bgFill: CSSProperties = { ["--p"]: `${String(bgBrightness)}%` } as CSSProperties;
  const gridFill: CSSProperties = { ["--p"]: `${String(gridStrength)}%` } as CSSProperties;
  const cameraSmoothnessFill: CSSProperties = {
    ["--p"]: `${String(cameraSmoothness)}%`,
  } as CSSProperties;
  const frameBorderFill: CSSProperties = {
    ["--p"]: `${String(frameBorderStrength)}%`,
  } as CSSProperties;
  const frameInnerGlowFill: CSSProperties = {
    ["--p"]: `${String(frameInnerGlowStrength)}%`,
  } as CSSProperties;
  const languageHelpId = "settings-language-help";
  const languageSections = [
    {
      options: [
        { value: "en", label: LOCALE_LABELS.en },
        { value: "de", label: LOCALE_LABELS.de },
      ],
    },
  ] as const;
  return (
    <>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">{t("settings.language.title")}</div>
          <div className="set-sec-d">{t("settings.language.description")}</div>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <span className="gpref-label">{t("settings.language.label")}</span>
          <KeikoSelect
            ariaLabel={t("settings.language.label")}
            ariaDescribedBy={languageHelpId}
            attached={false}
            leadingVisual={<BrowserIcon size={15} />}
            menuMinWidth={172}
            onValueChange={(next) => {
              if (next === "en" || next === "de") setLocale(next);
            }}
            sections={languageSections}
            showMenuHeader={false}
            triggerClassName="settings-language-select"
            value={locale}
          />
        </div>
        <div id={languageHelpId} className="gpref-help">
          {t("settings.language.help")}
        </div>
      </div>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">{t("settings.updates.title")}</div>
          <div className="set-sec-d" id="settings-updates-help">
            {t("settings.updates.description")}
          </div>
        </div>
        <div className="set-sec-actions">
          <button
            type="button"
            className="set-add"
            aria-describedby="settings-updates-help"
            disabled={openUpdatesWindow === undefined}
            onClick={openUpdatesWindow}
          >
            <ActivityIcon size={14} />
            {t("settings.updates.open")}
          </button>
        </div>
      </div>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">{t("settings.voice.title")}</div>
          <div className="set-sec-d">{t("settings.voice.description")}</div>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <span className="gpref-label">{t("settings.voice.label")}</span>
          <KeikoSelect
            ariaLabel={t("settings.voice.label")}
            ariaDescribedBy="settings-voice-help"
            attached={false}
            leadingVisual={<MicIcon size={15} />}
            menuMinWidth={172}
            onValueChange={(next) => {
              if ((voicePersonaOptions as readonly string[]).includes(next)) {
                const selected = next as VoicePersona;
                setVoicePersona(selected);
                writeVoicePersonaPreference(selected);
              }
            }}
            sections={voiceSections}
            showMenuHeader={false}
            triggerClassName="settings-language-select"
            value={voicePersona}
          />
        </div>
        <div id="settings-voice-help" className="gpref-help">
          {voicePersonas.length > 0 ? t("settings.voice.help") : t("settings.voice.unavailable")}
        </div>
      </div>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">{t("settings.wallpaper.title")}</div>
          <div className="set-sec-d">{t("settings.wallpaper.description")}</div>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <div>
            <div className="gpref-label">{t("settings.wallpaper.toggle")}</div>
            <div className="gpref-help">
              {wallpaperEnabled ? t("settings.wallpaper.running") : t("settings.wallpaper.stopped")}
            </div>
          </div>
          <Toggle
            on={wallpaperEnabled}
            onChange={setWallpaperEnabled}
            label={t("settings.wallpaper.toggle")}
          />
        </div>
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="wp-op">
            {t("settings.wallpaper.opacity")}
          </label>
          <span className="gpref-val mono">{wp}%</span>
        </div>
        <input
          id="wp-op"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={wp}
          disabled={!wallpaperEnabled}
          onChange={(e) => setWp(Number.parseInt(e.target.value, 10))}
          style={fill}
          aria-label={t("settings.wallpaper.opacity")}
        />
        <div className="gpref-scale">
          <span>{t("settings.scale.off")}</span>
          <span>{t("settings.scale.full")}</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="ws-bg-bright">
            {t("settings.workspace.backgroundBrightness")}
          </label>
          <span className="gpref-val mono">{bgBrightness}%</span>
        </div>
        <input
          id="ws-bg-bright"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={bgBrightness}
          onChange={(e) => setBgBrightness(Number.parseInt(e.target.value, 10))}
          style={bgFill}
          aria-label={t("settings.workspace.backgroundBrightness")}
        />
        <div className="gpref-scale">
          <span>{t("settings.scale.base")}</span>
          <span>{t("settings.scale.lighter")}</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="ws-grid-strength">
            {t("settings.workspace.gridStrength")}
          </label>
          <span className="gpref-val mono">{gridStrength}%</span>
        </div>
        <input
          id="ws-grid-strength"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={gridStrength}
          onChange={(e) => setGridStrength(Number.parseInt(e.target.value, 10))}
          style={gridFill}
          aria-label={t("settings.workspace.gridStrength")}
        />
        <div className="gpref-scale">
          <span>{t("settings.scale.subtle")}</span>
          <span>{t("settings.scale.strong")}</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="ws-camera-smoothness">
            {t("settings.workspace.cameraAnimation")}
          </label>
          <span className="gpref-val mono">{cameraSmoothness}%</span>
        </div>
        <input
          id="ws-camera-smoothness"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={cameraSmoothness}
          onChange={(e) => setCameraSmoothness(Number.parseInt(e.target.value, 10))}
          style={cameraSmoothnessFill}
          aria-label={t("settings.workspace.cameraAnimation")}
        />
        <div className="gpref-scale">
          <span>{t("settings.workspace.cameraAnimationMinimal")}</span>
          <span>{t("settings.workspace.cameraAnimationSmooth")}</span>
        </div>
        <div className="gpref-help">{t("settings.workspace.cameraAnimationHelp")}</div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="frame-border-strength">
            {t("settings.workspace.borderStrength")}
          </label>
          <span className="gpref-val mono">{frameBorderStrength}%</span>
        </div>
        <input
          id="frame-border-strength"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={frameBorderStrength}
          onChange={(e) => setFrameBorderStrength(Number.parseInt(e.target.value, 10))}
          style={frameBorderFill}
          aria-label={t("settings.workspace.borderStrength")}
        />
        <div className="gpref-scale">
          <span>{t("settings.scale.subtle")}</span>
          <span>{t("settings.scale.strong")}</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="frame-inner-glow-strength">
            {t("settings.workspace.innerGlow")}
          </label>
          <span className="gpref-val mono">{frameInnerGlowStrength}%</span>
        </div>
        <input
          id="frame-inner-glow-strength"
          className="gpref-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={frameInnerGlowStrength}
          onChange={(e) => setFrameInnerGlowStrength(Number.parseInt(e.target.value, 10))}
          style={frameInnerGlowFill}
          aria-label={t("settings.workspace.innerGlow")}
        />
        <div className="gpref-scale">
          <span>{t("settings.scale.off")}</span>
          <span>{t("settings.scale.strong")}</span>
        </div>
      </div>
    </>
  );
}

type Tab = "models" | "general" | "editor" | "languages" | "debugging" | "security";

// uiux-fix C287: raw transport strings ("HTTP 500", "Failed to fetch") are
// codes, not explanations — map them to a human-readable message. Messages
// from the BFF error envelope (anything else) pass through unchanged.
function describeSettingsLoadError(error: unknown, t: I18nTranslate): string {
  const fallback = t("settings.models.loadError");
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (message.length === 0 || /^HTTP \d+$/u.test(message)) return fallback;
  // Browser-native fetch failure strings (Chrome / Safari / Firefox).
  if (
    message === "Failed to fetch" ||
    message === "Load failed" ||
    message === "NetworkError when attempting to fetch a resource."
  ) {
    return fallback;
  }
  return message;
}

const FAILED_VERIFICATION: GatewayVerificationState = "failed";
const PARTIAL_VERIFICATION: GatewayVerificationState = "partial";
const VERIFIED_GATEWAY: GatewayVerificationState = "verified";

/**
 * F-01: the gateway summary is the panel's own verdict, and "connected" used to mean nothing more
 * than "a config file parsed". The readiness runs this panel already performs are the only live
 * evidence about the gateway, so the summary is derived from them: a probe that failed (or a run
 * whose transport threw) demotes the summary, a passing one promotes it, and a gateway nobody has
 * checked reads as unverified. The worst outcome across the checked models wins — one reachable
 * model does not make a gateway whose other model just failed a healthy one.
 */
function gatewayVerificationFromRuns(
  runs: Record<string, ReadinessRunState>,
): GatewayVerificationState {
  let best: GatewayVerificationState = UNVERIFIED_GATEWAY;
  for (const run of Object.values(runs)) {
    if (run.status === "error") return FAILED_VERIFICATION;
    if (run.status !== "done") continue;
    const state = gatewayVerificationFromProbeOutcome(run.report.overallStatus);
    if (gatewayVerificationContradictsReadiness(state)) return FAILED_VERIFICATION;
    if (state === PARTIAL_VERIFICATION || best === UNVERIFIED_GATEWAY) best = state;
  }
  return best;
}

function computeGatewayStatusLabel(
  gatewayConfigured: boolean,
  hasDiscoveredModels: boolean,
  verification: GatewayVerificationState,
  t: I18nTranslate,
): string {
  if (!gatewayConfigured) return t("settings.models.setupRequired");
  if (gatewayVerificationContradictsReadiness(verification)) {
    return t("settings.models.probeFailed");
  }
  // A gateway with no discovered models keeps saying so: there is nothing for a probe to confirm,
  // and "configured" already withholds the connection claim (uiux-fix C286's distinction).
  if (!hasDiscoveredModels) return t("settings.models.configured");
  // "connected" is a claim about reaching the gateway, so only a passing probe earns it.
  if (verification === UNVERIFIED_GATEWAY) return t("settings.models.notVerified");
  return t("settings.models.connected");
}

// uiux-fix C286: with models discovered but zero conversation-eligible ones
// (e.g. embedding/OCR-only gateways) the detail must not claim chat works.
function computeGatewayStatusDetail(
  gatewayConfigured: boolean,
  hasDiscoveredModels: boolean,
  chatCount: number,
  verification: GatewayVerificationState,
  t: I18nTranslate,
): string {
  if (!gatewayConfigured) return t("settings.models.detailSetup");
  if (!hasDiscoveredModels) return t("settings.models.detailNoModels");
  if (chatCount === 0) return t("settings.models.detailNoChat");
  if (gatewayVerificationContradictsReadiness(verification)) {
    return t("settings.models.detailProbeFailed");
  }
  if (verification === UNVERIFIED_GATEWAY) return t("settings.models.detailNotVerified");
  return t("settings.models.detailReady");
}

function gatewayStatusTone(
  gatewayConfigured: boolean,
  verification: GatewayVerificationState,
): string {
  if (!gatewayConfigured) return "untested";
  if (gatewayVerificationContradictsReadiness(verification)) return "error";
  if (verification === PARTIAL_VERIFICATION) return "ineligible";
  return verification === VERIFIED_GATEWAY ? "connected" : "untested";
}

function gatewayStatusTitle(
  gatewayConfigured: boolean,
  verification: GatewayVerificationState,
  t: I18nTranslate,
): string {
  if (!gatewayConfigured) return t("settings.models.statusSetupRequired");
  if (gatewayVerificationContradictsReadiness(verification)) {
    return t("settings.models.statusProbeFailed");
  }
  if (verification === UNVERIFIED_GATEWAY) return t("settings.models.statusNotVerified");
  return t("settings.models.statusConfigured");
}

// Issue #1399: receive gateway-setup deep-link requests. The latch covers "Settings was just
// opened" (read on mount), the event covers "Settings already open" (live listener). Both paths
// gate on consuming the latch so exactly ONE of them claims a given request (the bus invariant).
// Named module-scope helper (not a closure over the whole component) so the effect body stays flat.
function bindGatewaySetupRequestListener(claim: () => void): () => void {
  if (consumePendingGatewaySetup()) claim();
  const onRequest = (): void => {
    if (consumePendingGatewaySetup()) claim();
  };
  window.addEventListener(GATEWAY_SETUP_REQUEST_EVENT, onRequest);
  return () => {
    window.removeEventListener(GATEWAY_SETUP_REQUEST_EVENT, onRequest);
  };
}

interface SettingsLoadHandlers {
  // F-02: config + presence + the generation they belong to are applied as ONE step. Splitting them
  // is what let a readiness run started in the same commit be attributed to the previous generation.
  readonly applyConfig: (config: SafeGatewayConfig | null, present: boolean) => void;
  readonly setModels: (models: readonly ModelCapability[]) => void;
  readonly setModelError: (message: string | undefined) => void;
  readonly setLoadingModels: (loading: boolean) => void;
  readonly isCancelled: () => boolean;
}

// uiux-fix C287: explicit-params helper (not a closure over the whole component) so the load
// effect stays a single call instead of an inline async function with its own try/catch/finally.
async function loadSettingsData(handlers: SettingsLoadHandlers, t: I18nTranslate): Promise<void> {
  handlers.setLoadingModels(true);
  handlers.setModelError(undefined);
  try {
    const [configPayload, modelPayload] = await Promise.all([fetchConfig(), fetchModels()]);
    if (handlers.isCancelled()) return;
    handlers.applyConfig(configPayload.config, configPayload.configPresent);
    handlers.setModels(modelPayload.models);
  } catch (error) {
    if (handlers.isCancelled()) return;
    handlers.setModelError(describeSettingsLoadError(error, t));
  } finally {
    if (!handlers.isCancelled()) handlers.setLoadingModels(false);
  }
}

// F-02: `generation` is the configuration this run measures, captured before the request leaves. It
// travels with every recorded state so a late verdict is attributed to the configuration it actually
// observed — never to whichever one happens to be current when the response lands.
async function runModelReadinessCheck(
  modelId: string,
  deep: boolean,
  generation: number,
  setLedger: (updater: (current: ReadinessLedger) => ReadinessLedger) => void,
  t: I18nTranslate,
): Promise<void> {
  const record = (state: ReadinessRunState): void => {
    setLedger((current) => recordReadinessRun(current, generation, modelId, state));
  };
  record({ status: "running", deep });
  try {
    const report = await runGatewayReadiness(
      modelId,
      deep ? { includeDeepProbes: true } : undefined,
    );
    record({ status: "done", report });
    notifyGatewayModelReadinessUpdated();
  } catch (error) {
    record({ status: "error", message: readinessErrorMessage(error, t) });
  }
}

interface ModelsTabContentProps {
  readonly gatewayConfigured: boolean;
  readonly models: readonly ModelCapability[];
  readonly modelError: string | undefined;
  readonly loadingModels: boolean;
  readonly readiness: Record<string, ReadinessRunState>;
  readonly configGeneration: number;
  readonly setupOpen: boolean;
  readonly config: SafeGatewayConfig | null;
  readonly onOpenSetup: () => void;
  readonly onCloseSetup: () => void;
  readonly onRetry: () => void;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
  readonly onCapabilityApplied: (model: ModelCapability, observedGeneration: number) => void;
}

// #2723 (S3358): the models-list body was a nested ternary (loadingModels ? … :
// models.length === 0 ? … : …); extracted to a named render function with early returns.
function renderModelsListBody({
  loadingModels,
  models,
  gatewayConfigured,
  readiness,
  configGeneration,
  onRunReadiness,
  onCapabilityApplied,
  t,
}: {
  readonly loadingModels: boolean;
  readonly models: readonly ModelCapability[];
  readonly gatewayConfigured: boolean;
  readonly readiness: Record<string, ReadinessRunState>;
  readonly configGeneration: number;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
  readonly onCapabilityApplied: (model: ModelCapability, observedGeneration: number) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (loadingModels) {
    return (
      <output className="set-placeholder" style={NATIVE_BLOCK_STYLE}>
        {t("settings.models.loading")}
      </output>
    );
  }
  if (models.length === 0) {
    return (
      <output className="set-placeholder" style={NATIVE_BLOCK_STYLE}>
        {gatewayConfigured
          ? t("settings.models.emptyConfigured")
          : t("settings.models.emptyUnconfigured")}
      </output>
    );
  }
  return (
    <div className="set-list">
      {models.map((model) => (
        <ModelCapabilityRow
          key={model.id}
          model={model}
          readiness={readiness[model.id]}
          observedGeneration={configGeneration}
          onRunReadiness={onRunReadiness}
          onCapabilityApplied={onCapabilityApplied}
        />
      ))}
    </div>
  );
}

// uiux-fix C147/C285/C287: the "models" tab body, mirrored after GeneralPrefs — its own
// component instead of an inline nested-ternary block in SettingsPanel's return.
function ModelsTabContent({
  gatewayConfigured,
  models,
  modelError,
  loadingModels,
  readiness,
  configGeneration,
  setupOpen,
  config,
  onOpenSetup,
  onCloseSetup,
  onRetry,
  onRunReadiness,
  onCapabilityApplied,
}: ModelsTabContentProps): ReactNode {
  const t = useTranslate();
  // Issue #144: source of truth is the helper, not an inline kind check.
  const chatCount = models.filter(isConversationEligibleModel).length;
  const hasDiscoveredModels = models.length > 0;
  const verification = gatewayVerificationFromRuns(readiness);
  const gatewayStatusLabel = computeGatewayStatusLabel(
    gatewayConfigured,
    hasDiscoveredModels,
    verification,
    t,
  );
  const gatewayStatusDetail = computeGatewayStatusDetail(
    gatewayConfigured,
    hasDiscoveredModels,
    chatCount,
    verification,
    t,
  );
  const statusTone = gatewayStatusTone(gatewayConfigured, verification);
  return (
    <>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">{t("settings.models.gatewayTitle")}</div>
          <div className="set-sec-d">{t("settings.models.gatewayDescription")}</div>
        </div>
        <div className="set-sec-actions">
          <button type="button" className="set-add" onClick={onOpenSetup}>
            <PlusIcon size={14} />
            {gatewayConfigured
              ? t("settings.models.updateCredentials")
              : t("settings.models.connectGateway")}
          </button>
          <span className="set-onprem set-onprem-gateway" title={t("settings.selfHostedTitle")}>
            <span className="dot" style={{ background: "var(--accent)" }} />{" "}
            {t("settings.selfHosted")}
          </span>
        </div>
      </div>

      <div className="ml-row">
        <span className="ml-ico">
          <CubeIcon size={16} />
        </span>
        <div className="ml-info">
          <div className="ml-top">
            <span className="ml-name">{gatewayStatusLabel}</span>
            <span className="ml-type mono">
              {t("settings.models.modelCount", { count: models.length })}
            </span>
            <span className="ml-type mono">
              {t("settings.models.chatCount", { count: chatCount })}
            </span>
          </div>
          <div className="ml-url mono">{gatewayStatusDetail}</div>
        </div>
        <span
          className={"ml-status " + statusTone}
          title={gatewayStatusTitle(gatewayConfigured, verification, t)}
          aria-hidden="true"
        />
      </div>

      {/* uiux-fix C285/C287: async failure is announced (role=alert) and
          recoverable in place via Retry — fetchModels drops its cached
          promise on rejection, so a retry really re-fetches. */}
      {modelError !== undefined ? (
        <div className="gw-error" role="alert">
          {modelError}
          <button type="button" className="gw-error-retry" onClick={onRetry}>
            {t("settings.models.retry")}
          </button>
        </div>
      ) : null}

      {/* uiux-fix C285: loading -> result transition is announced */}
      {renderModelsListBody({
        loadingModels,
        models,
        gatewayConfigured,
        readiness,
        configGeneration,
        onRunReadiness,
        onCapabilityApplied,
        t,
      })}

      {setupOpen ? (
        <GatewaySetupDialog
          onCancel={onCloseSetup}
          preserveExisting={gatewayConfigured}
          storedApiKeyHeaderName={config?.providers[0]?.credentialHeaderName}
          storedModels={models}
        />
      ) : null}
    </>
  );
}

export function SettingsPanel({
  openUpdatesWindow,
  openWorkspaceTrust,
  root,
}: {
  readonly openUpdatesWindow?: (() => void) | undefined;
  readonly openWorkspaceTrust?: (() => void) | undefined;
  readonly root?: string | undefined;
} = {}): ReactNode {
  const t = useTranslate();
  const workspaceT = useGlobalTranslate();
  const [tab, setTab] = useState<Tab>("models");
  const [models, setModels] = useState<readonly ModelCapability[]>([]);
  const [config, setConfig] = useState<SafeGatewayConfig | null>(null);
  const [configPresent, setConfigPresent] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelError, setModelError] = useState<string | undefined>();
  // F-02: readiness runs are remembered per configuration generation, never as a bare model-keyed
  // map — see ReadinessLedger. The generation is the panel's monotonic count of observed
  // configuration changes; a run tagged with an older one is evidence about a replaced gateway.
  const [readinessLedger, setReadinessLedger] = useState<ReadinessLedger>(INITIAL_READINESS_LEDGER);
  const [configGeneration, setConfigGeneration] = useState(0);
  const configGenerationRef = useRef(0);
  const measuredConfigIdentity = useRef(gatewayConfigIdentity(null, false));
  const [setupOpen, setSetupOpen] = useState(false);
  // Issue #1399: a PAT error in the Figma Snapshot window can deep-link here to open the
  // gateway-setup dialog on its Figma access-token section. The request is latched until config
  // has loaded so preserveExisting (and thus the focused field + copy) is settled before the
  // dialog mounts — opening it mid-load would flash first-run wording and focus the wrong input.
  const [pendingSetupRequest, setPendingSetupRequest] = useState(false);
  // uiux-fix C287: bumping the tick re-runs the load effect (Retry button).
  const [reloadTick, setReloadTick] = useState(0);

  // Issue #1399: receive gateway-setup deep-link requests. The latch covers "Settings was just
  // opened" (read on mount), the event covers "Settings already open" (live listener). Both paths
  // gate on consuming the latch so exactly ONE of them claims a given request (the bus invariant).
  useEffect(() => {
    const claim = (): void => {
      setTab("models");
      setPendingSetupRequest(true);
    };
    return bindGatewaySetupRequestListener(claim);
  }, []);

  useEffect(() => {
    const onOpenEditorSettings = (): void => {
      setTab("editor");
    };
    window.addEventListener(OPEN_EDITOR_SETTINGS_EVENT, onOpenEditorSettings);
    return () => {
      window.removeEventListener(OPEN_EDITOR_SETTINGS_EVENT, onOpenEditorSettings);
    };
  }, []);

  // Issue #1399: open the dialog only once config has RESOLVED (loaded without error) so
  // preserveExisting (edit-mode wording + Figma-token focus) is settled before the dialog mounts.
  // On a load failure the request stays latched — the panel shows its own error + Retry, and a
  // successful retry then opens the dialog correctly rather than in misleading first-run wording.
  useEffect(() => {
    if (pendingSetupRequest && !loadingModels && modelError === undefined) {
      setSetupOpen(true);
      setPendingSetupRequest(false);
    }
  }, [pendingSetupRequest, loadingModels, modelError]);

  // F-02: applying a loaded configuration also advances the generation when it is not the one the
  // remembered runs measured — a replacement performed anywhere else (another window, the CLI, the
  // first-run dialog) must not leave this panel presenting the old gateway's verdict as current
  // verification. It happens in the same commit as the config itself so that a readiness run started
  // from the very first render of that configuration is attributed to it, not to its predecessor.
  const advanceConfigGeneration = useCallback((): void => {
    configGenerationRef.current += 1;
    setConfigGeneration(configGenerationRef.current);
  }, []);

  const applyConfig = useCallback(
    (next: SafeGatewayConfig | null, present: boolean): void => {
      setConfig(next);
      setConfigPresent(present);
      const identity = gatewayConfigIdentity(next, present);
      if (measuredConfigIdentity.current === identity) return;
      measuredConfigIdentity.current = identity;
      advanceConfigGeneration();
    },
    [advanceConfigGeneration],
  );

  useEffect(() => {
    let cancelled = false;
    void loadSettingsData(
      {
        applyConfig,
        setModels,
        setModelError,
        setLoadingModels,
        isCancelled: () => cancelled,
      },
      t,
    );
    return () => {
      cancelled = true;
    };
  }, [applyConfig, reloadTick, t]);

  // F-02: a credential update replaces the configuration without changing anything the safe
  // projection can show, so the write is announced instead of inferred. Advancing the generation is
  // all it takes: every remembered run is tagged with the generation it measured.
  useEffect(() => {
    const onConfigUpdated = (): void => {
      advanceConfigGeneration();
    };
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, onConfigUpdated);
    return () => {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, onConfigUpdated);
    };
  }, [advanceConfigGeneration]);

  const voicePersonas = useMemo(() => voicePersonasFromModels(models), [models]);
  const gatewayConfigured = configPresent;
  const readiness = readinessRunsForGeneration(readinessLedger, configGeneration);

  async function handleRunReadiness(modelId: string, deep: boolean): Promise<void> {
    await runModelReadinessCheck(modelId, deep, configGeneration, setReadinessLedger, t);
  }

  return (
    <div className="set">
      <div className="set-tabs">
        {(
          ["models", "general", "editor", "languages", "debugging", "security"] as readonly Tab[]
        ).map((id) => (
          <button
            type="button"
            key={id}
            className="set-tab"
            data-on={tab === id}
            // uiux-fix C070: expose the active tab to assistive technology —
            // toggle-button pattern, same as the density buttons in
            // RelationshipListPanel (state was previously CSS-only via data-on).
            aria-pressed={tab === id}
            // GEN-UI-A11Y-010: onClick alone drives the tab switch — the extra
            // onPointerDown duplicated the state update (double setTab) without
            // adding keyboard reach, so it is removed.
            onClick={() => setTab(id)}
          >
            {/* uiux-fix C147: the tab shows the remote model gateway, not local models */}
            {settingsTabLabel(id, t)}
          </button>
        ))}
      </div>
      <div className="set-body">
        {tab === "models" && (
          <ModelsTabContent
            gatewayConfigured={gatewayConfigured}
            models={models}
            modelError={modelError}
            loadingModels={loadingModels}
            readiness={readiness}
            configGeneration={configGeneration}
            setupOpen={setupOpen}
            config={config}
            onOpenSetup={() => setSetupOpen(true)}
            onCloseSetup={() => setSetupOpen(false)}
            onRetry={() => setReloadTick((tick) => tick + 1)}
            onRunReadiness={(modelId, deep) => {
              void handleRunReadiness(modelId, deep);
            }}
            onCapabilityApplied={(updatedModel, observedGeneration) => {
              if (configGenerationRef.current !== observedGeneration) return;
              setModels((current) =>
                current.map((model) => (model.id === updatedModel.id ? updatedModel : model)),
              );
              setReadinessLedger((ledger) =>
                clearReadinessRun(ledger, observedGeneration, updatedModel.id),
              );
              notifyGatewayConfigUpdated();
              setReloadTick((tick) => tick + 1);
            }}
          />
        )}
        {tab === "general" && (
          <GeneralPrefs voicePersonas={voicePersonas} openUpdatesWindow={openUpdatesWindow} />
        )}
        {tab === "editor" && <EditorSettingsPanel root={root} />}
        {tab === "languages" && (
          <ManagedLanguageSettings root={root} onOpenWorkspaceTrust={openWorkspaceTrust} />
        )}
        {tab === "debugging" && <DebuggingSettings root={root} />}
        {tab === "security" && (
          <div className="set-list">
            <AutonomySettings />
            <div className="set-sec-h">
              <div>
                <div className="set-sec-t">{workspaceT("workspaceTrust.title")}</div>
                <div className="set-sec-d">{workspaceT("workspaceTrust.settings.description")}</div>
              </div>
              <button
                type="button"
                className="set-add"
                disabled={openWorkspaceTrust === undefined}
                onClick={openWorkspaceTrust}
              >
                <SettingsIcon size={14} />
                {workspaceT("workspaceTrust.settings.open")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function settingsTabLabel(tab: Tab, t: I18nTranslate): string {
  if (tab === "models") return t("settings.tabs.models");
  if (tab === "general") return t("settings.tabs.general");
  if (tab === "editor") return t("settings.tabs.editor");
  if (tab === "languages") return t("settings.tabs.languages");
  if (tab === "debugging") return t("settings.tabs.debugging");
  return t("settings.tabs.security");
}
