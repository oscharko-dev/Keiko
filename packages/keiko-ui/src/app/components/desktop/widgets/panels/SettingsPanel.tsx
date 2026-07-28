"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { VOICE_PERSONAS } from "@oscharko-dev/keiko-contracts";
import { fetchConfig, fetchModels, runGatewayReadiness } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  LOCALE_LABELS,
  useLocale,
  useSetLocale,
  useTranslate as useGlobalTranslate,
} from "@/lib/i18n";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
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
import { GatewaySetupDialog } from "../../modals/GatewaySetupDialog";
import { Toggle } from "../shared/Toggle";
import { GATEWAY_SETUP_REQUEST_EVENT, consumePendingGatewaySetup } from "../shared/gatewaySetupBus";
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

function ReadinessSummary({ state }: { readonly state: ReadinessRunState | undefined }): ReactNode {
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
  onRunReadiness,
}: {
  readonly model: ModelCapability;
  readonly readiness: ReadinessRunState | undefined;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
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
        <ReadinessSummary state={readiness} />
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

function computeGatewayStatusLabel(
  gatewayConfigured: boolean,
  hasDiscoveredModels: boolean,
  t: I18nTranslate,
): string {
  if (!gatewayConfigured) return t("settings.models.setupRequired");
  if (hasDiscoveredModels) return t("settings.models.connected");
  return t("settings.models.configured");
}

// uiux-fix C286: with models discovered but zero conversation-eligible ones
// (e.g. embedding/OCR-only gateways) the detail must not claim chat works.
function computeGatewayStatusDetail(
  gatewayConfigured: boolean,
  hasDiscoveredModels: boolean,
  chatCount: number,
  t: I18nTranslate,
): string {
  if (!gatewayConfigured) return t("settings.models.detailSetup");
  if (!hasDiscoveredModels) return t("settings.models.detailNoModels");
  if (chatCount === 0) return t("settings.models.detailNoChat");
  return t("settings.models.detailReady");
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
  readonly setConfig: (config: SafeGatewayConfig | null) => void;
  readonly setConfigPresent: (present: boolean) => void;
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
    handlers.setConfig(configPayload.config);
    handlers.setConfigPresent(configPayload.configPresent);
    handlers.setModels(modelPayload.models);
  } catch (error) {
    if (handlers.isCancelled()) return;
    handlers.setModelError(describeSettingsLoadError(error, t));
  } finally {
    if (!handlers.isCancelled()) handlers.setLoadingModels(false);
  }
}

async function runModelReadinessCheck(
  modelId: string,
  deep: boolean,
  setReadiness: (
    updater: (current: Record<string, ReadinessRunState>) => Record<string, ReadinessRunState>,
  ) => void,
  t: I18nTranslate,
): Promise<void> {
  setReadiness((current) => ({ ...current, [modelId]: { status: "running", deep } }));
  try {
    const report = await runGatewayReadiness(
      modelId,
      deep ? { includeDeepProbes: true } : undefined,
    );
    setReadiness((current) => ({ ...current, [modelId]: { status: "done", report } }));
  } catch (error) {
    setReadiness((current) => ({
      ...current,
      [modelId]: { status: "error", message: readinessErrorMessage(error, t) },
    }));
  }
}

interface ModelsTabContentProps {
  readonly gatewayConfigured: boolean;
  readonly models: readonly ModelCapability[];
  readonly modelError: string | undefined;
  readonly loadingModels: boolean;
  readonly readiness: Record<string, ReadinessRunState>;
  readonly setupOpen: boolean;
  readonly config: SafeGatewayConfig | null;
  readonly onOpenSetup: () => void;
  readonly onCloseSetup: () => void;
  readonly onRetry: () => void;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
}

// #2723 (S3358): the models-list body was a nested ternary (loadingModels ? … :
// models.length === 0 ? … : …); extracted to a named render function with early returns.
function renderModelsListBody({
  loadingModels,
  models,
  gatewayConfigured,
  readiness,
  onRunReadiness,
  t,
}: {
  readonly loadingModels: boolean;
  readonly models: readonly ModelCapability[];
  readonly gatewayConfigured: boolean;
  readonly readiness: Record<string, ReadinessRunState>;
  readonly onRunReadiness: (modelId: string, deep: boolean) => void;
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
          onRunReadiness={onRunReadiness}
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
  setupOpen,
  config,
  onOpenSetup,
  onCloseSetup,
  onRetry,
  onRunReadiness,
}: ModelsTabContentProps): ReactNode {
  const t = useTranslate();
  // Issue #144: source of truth is the helper, not an inline kind check.
  const chatCount = models.filter(isConversationEligibleModel).length;
  const hasDiscoveredModels = models.length > 0;
  const gatewayStatusLabel = computeGatewayStatusLabel(gatewayConfigured, hasDiscoveredModels, t);
  const gatewayStatusDetail = computeGatewayStatusDetail(
    gatewayConfigured,
    hasDiscoveredModels,
    chatCount,
    t,
  );
  const gatewayStatusTone = gatewayConfigured ? "connected" : "untested";
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
          className={"ml-status " + gatewayStatusTone}
          title={
            gatewayConfigured
              ? t("settings.models.statusConfigured")
              : t("settings.models.statusSetupRequired")
          }
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
        onRunReadiness,
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
  const [readiness, setReadiness] = useState<Record<string, ReadinessRunState>>({});
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

  useEffect(() => {
    let cancelled = false;
    void loadSettingsData(
      {
        setConfig,
        setConfigPresent,
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
  }, [reloadTick, t]);

  const voicePersonas = useMemo(() => voicePersonasFromModels(models), [models]);
  const gatewayConfigured = configPresent;

  async function handleRunReadiness(modelId: string, deep: boolean): Promise<void> {
    await runModelReadinessCheck(modelId, deep, setReadiness, t);
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
            setupOpen={setupOpen}
            config={config}
            onOpenSetup={() => setSetupOpen(true)}
            onCloseSetup={() => setSetupOpen(false)}
            onRetry={() => setReloadTick((tick) => tick + 1)}
            onRunReadiness={(modelId, deep) => {
              void handleRunReadiness(modelId, deep);
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
