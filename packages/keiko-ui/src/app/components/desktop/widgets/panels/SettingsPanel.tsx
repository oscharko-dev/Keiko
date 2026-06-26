"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fetchConfig, fetchModels, runGatewayReadiness } from "@/lib/api";
import type {
  ConversationIneligibilityReason,
  GatewayReadinessProbeResult,
  GatewayReadinessReport,
  ModelCapability,
  SafeGatewayConfig,
} from "@/lib/types";
import {
  describeVoiceProviderAvailability,
  explainConversationIneligibility,
  isConfiguredVoiceProvider,
  isConversationEligibleModel,
} from "@/lib/types";
import { Icons } from "../../Icons";
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
  applyFrameBorderStrength,
  applyWorkspaceBackgroundBrightness,
  applyWorkspaceGridStrength,
  readFrameBorderStrength,
  readFrameInnerGlowStrength,
  readWallpaperEnabled,
  readWallpaperOpacity,
  readWorkspaceBackgroundBrightness,
  readWorkspaceGridStrength,
} from "../../workspace-appearance";

function kindLabel(kind: ModelCapability["kind"]): string {
  if (kind === "ocr-vision") return "OCR";
  return kind;
}

// Issue #144 AC #3: returns the human-readable explanation for an
// ineligibility reason. Pure function of the typed reason — never reads
// model.baseUrl / model.apiKey / anything credential-shaped (those fields do
// not exist on ModelCapability by design; this comment pins the invariant).
function conversationIneligibilityLabel(reason: ConversationIneligibilityReason): string {
  if (reason === "embedding-only") return "Embedding model — not selectable for text conversation";
  if (reason === "ocr-vision-only") return "OCR/vision-only — not selectable for text conversation";
  return "Not a chat model — not selectable for text conversation";
}

function embeddingAvailabilityLabel(): string {
  return "Available for embeddings; not shown in the chat model picker";
}

// Issue #1557 (AC4, ADR-0088 D5): a content-free, human-readable description of a configured voice
// provider's availability, so the model list presents it as available (with its voice capabilities
// and the personas it offers) rather than a chat-ineligibility warning. Reads only enum/boolean
// fields — never a base URL, credential, or provider voice id.
function voiceProviderAvailabilityLabel(model: ModelCapability): string {
  const availability = describeVoiceProviderAvailability(model);
  const capabilities: string[] = [];
  if (availability.speechToText) capabilities.push("speech-to-text");
  if (availability.speechOutput) capabilities.push("speech output");
  if (availability.realtimeVoice) capabilities.push("realtime dialogue");
  const capabilityText = capabilities.length > 0 ? capabilities.join(", ") : "voice";
  const personaText =
    availability.personas.length > 0 ? `; voices: ${availability.personas.join(", ")}` : "";
  return `Voice provider — available for ${capabilityText}${personaText}`;
}

// Short visible badge copy for a configured voice provider (the long form stays in aria-label/title).
function voiceProviderShortLabel(model: ModelCapability): string {
  const availability = describeVoiceProviderAvailability(model);
  if (availability.realtimeVoice) return "realtime dialogue";
  if (availability.speechOutput) return "speech output";
  if (availability.speechToText) return "speech-to-text";
  return "voice";
}

// uiux-fix C359/C057: short visible badge copy — the long form stays in
// aria-label/title so the model list does not read like a transport warning.
function conversationIneligibilityShortLabel(reason: ConversationIneligibilityReason): string {
  if (reason === "ocr-vision-only") return "OCR/vision-only";
  return "not a chat model";
}

function ConversationEligibilityBadge({ model }: { readonly model: ModelCapability }): ReactNode {
  const reason = explainConversationIneligibility(model);
  if (reason === undefined) {
    return (
      <span
        className="ml-elig ml-elig-ok"
        data-testid="conv-elig-ok"
        role="status"
        aria-label="Model eligibility: eligible for conversation"
      >
        Conversation-eligible
      </span>
    );
  }
  if (reason === "embedding-only") {
    return (
      <span
        className="ml-elig ml-elig-embed"
        data-testid="embedding-elig-ok"
        role="status"
        aria-label={"Model eligibility: " + embeddingAvailabilityLabel()}
        title={embeddingAvailabilityLabel()}
      >
        Embedding-ready
      </span>
    );
  }
  // Issue #1557 (AC4): a correctly configured voice provider is available for its voice purpose, not a
  // chat-ineligibility warning. `isConversationEligibleModel` stays unchanged (voice is genuinely not
  // a chat model) — only the presentation differs.
  if (isConfiguredVoiceProvider(model)) {
    return (
      <span
        className="ml-elig ml-elig-voice"
        data-testid="voice-elig-ok"
        role="status"
        aria-label={"Model eligibility: " + voiceProviderAvailabilityLabel(model)}
        title={voiceProviderAvailabilityLabel(model)}
      >
        Voice provider — {voiceProviderShortLabel(model)}
      </span>
    );
  }
  return (
    <span
      className="ml-elig ml-elig-no"
      data-testid="conv-elig-no"
      role="status"
      aria-label={"Model eligibility: " + conversationIneligibilityLabel(reason)}
      title={conversationIneligibilityLabel(reason)}
    >
      Not selectable — {conversationIneligibilityShortLabel(reason)}
    </span>
  );
}

type ReadinessRunState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly deep: boolean }
  | { readonly status: "done"; readonly report: GatewayReadinessReport }
  | { readonly status: "error"; readonly message: string };

type ReportCopyState = "idle" | "copied" | "failed";

function readinessErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Readiness check failed. The gateway configuration was not changed.";
}

async function writeTextWithFallback(text: string): Promise<void> {
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Try the selection-backed path below for restricted clipboard contexts.
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
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
  const [copyState, setCopyState] = useState<ReportCopyState>("idle");
  const [status, setStatus] = useState("");

  async function handleCopy(): Promise<void> {
    try {
      await writeTextWithFallback(formatGatewayReadinessReport(report));
      setCopyState("copied");
      setStatus("Readiness report copied.");
    } catch {
      setCopyState("failed");
      setStatus("Clipboard access failed. Select and copy the report details manually.");
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
        <Icons.copy size={12} aria-hidden="true" />
        {copyState === "copied" ? "Copied" : "Copy report"}
      </button>
      <span
        className="ml-url mono"
        role={copyState === "failed" ? "alert" : "status"}
        aria-live="polite"
      >
        {status}
      </span>
    </>
  );
}

function ReadinessSummary({ state }: { readonly state: ReadinessRunState | undefined }): ReactNode {
  if (state === undefined || state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <div className="ml-readiness" role="status">
        Checking {state.deep ? "deep" : "basic"} readiness…
      </div>
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
        <div className="ml-rsummary" role={report.overallStatus === "failed" ? "alert" : "status"}>
          <div className="ml-rhead">
            <span className={"ml-rstatus " + report.overallStatus}>
              {workingToday ? "Working today" : "Not verified"}
            </span>
            <span className="ml-rtime mono">{new Date(report.checkedAt).toLocaleTimeString()}</span>
          </div>
          <div className="ml-rbadges" aria-label="Verified capabilities">
            {probePassed(report, "streaming") ? <span>Streaming</span> : null}
            {probePassed(report, "tool_calling") ? <span>Tools</span> : null}
            {probePassed(report, "json_schema") ? <span>JSON</span> : null}
            {probePassed(report, "reasoning") ? <span>Reasoning</span> : null}
            {probePassed(report, "image_input") ? <span>Image</span> : null}
            {probePassed(report, "document_input") ? <span>PDF</span> : null}
            {report.verifiedCapabilities.testedContextTokens !== undefined ? (
              <span>{report.verifiedCapabilities.testedContextTokens.toLocaleString()} ctx</span>
            ) : null}
          </div>
          {warning !== undefined ? <div className="ml-rwarn">{warning}</div> : null}
        </div>
      </div>
    </div>
  );
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
  const conversationEligible = isConversationEligibleModel(model);
  const embeddingReady = model.kind === "embedding";
  const statusClass = conversationEligible || embeddingReady ? "connected" : "ineligible";
  const statusTitle = conversationEligible
    ? "conversation-eligible"
    : embeddingReady
      ? "available for embeddings"
      : "not selectable for conversation";
  return (
    <div className="ml-row">
      <span className="ml-ico">
        <Icons.cube size={16} />
      </span>
      <div className="ml-info">
        <div className="ml-top">
          <span className="ml-name">{model.id}</span>
          <span className="ml-type mono">{kindLabel(model.kind)}</span>
          <ConversationEligibilityBadge model={model} />
        </div>
        <div className="ml-url mono">
          tools {model.toolCalling ? "yes" : "no"} · structured{" "}
          {model.structuredOutput ? "yes" : "no"} · {model.costClass}/{model.latencyClass}
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
            <Icons.activity size={13} />
            Run readiness check
          </button>
          <button
            type="button"
            className="ml-check secondary"
            disabled={readiness?.status === "running"}
            onClick={() => onRunReadiness(model.id, true)}
          >
            Deep probes
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

function GeneralPrefs(): ReactNode {
  const [wallpaperEnabled, setWallpaperEnabled] = useState<boolean>(readWallpaperEnabled);
  const [wp, setWp] = useState<number>(readWallpaperOpacity);
  const [bgBrightness, setBgBrightness] = useState<number>(readWorkspaceBackgroundBrightness);
  const [gridStrength, setGridStrength] = useState<number>(readWorkspaceGridStrength);
  const [frameBorderStrength, setFrameBorderStrength] = useState<number>(readFrameBorderStrength);
  const [frameInnerGlowStrength, setFrameInnerGlowStrength] = useState<number>(
    readFrameInnerGlowStrength,
  );

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
  const frameBorderFill: CSSProperties = {
    ["--p"]: `${String(frameBorderStrength)}%`,
  } as CSSProperties;
  const frameInnerGlowFill: CSSProperties = {
    ["--p"]: `${String(frameInnerGlowStrength)}%`,
  } as CSSProperties;
  return (
    <>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">Workspace wallpaper</div>
          <div className="set-sec-d">
            Liquid Chrome — a subtle metallic flow behind the grid that reacts to your cursor and
            clicks. Turn it off to stop the WebGL animation completely.
          </div>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <div>
            <div className="gpref-label">Liquid wallpaper</div>
            <div className="gpref-help">{wallpaperEnabled ? "Running" : "Stopped"}</div>
          </div>
          <Toggle on={wallpaperEnabled} onChange={setWallpaperEnabled} label="Liquid wallpaper" />
        </div>
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="wp-op">
            Wallpaper opacity
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
          aria-label="Wallpaper opacity"
        />
        <div className="gpref-scale">
          <span>Off</span>
          <span>Full</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="ws-bg-bright">
            Workspace background brightness
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
          aria-label="Workspace background brightness"
        />
        <div className="gpref-scale">
          <span>Base</span>
          <span>Lighter</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="ws-grid-strength">
            Workspace grid strength
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
          aria-label="Workspace grid strength"
        />
        <div className="gpref-scale">
          <span>Subtle</span>
          <span>Strong</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="frame-border-strength">
            Workspace border strength
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
          aria-label="Workspace border strength"
        />
        <div className="gpref-scale">
          <span>Subtle</span>
          <span>Strong</span>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="frame-inner-glow-strength">
            Workspace inner glow
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
          aria-label="Workspace inner glow"
        />
        <div className="gpref-scale">
          <span>Off</span>
          <span>Strong</span>
        </div>
      </div>
    </>
  );
}

type Tab = "models" | "general" | "security";

// uiux-fix C287: raw transport strings ("HTTP 500", "Failed to fetch") are
// codes, not explanations — map them to a human-readable message. Messages
// from the BFF error envelope (anything else) pass through unchanged.
function describeSettingsLoadError(error: unknown): string {
  const fallback = "Could not load gateway settings — the local Keiko backend did not respond.";
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

export function SettingsPanel(): ReactNode {
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
    if (consumePendingGatewaySetup()) claim();
    const onRequest = (): void => {
      if (consumePendingGatewaySetup()) claim();
    };
    window.addEventListener(GATEWAY_SETUP_REQUEST_EVENT, onRequest);
    return () => {
      window.removeEventListener(GATEWAY_SETUP_REQUEST_EVENT, onRequest);
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

    async function load(): Promise<void> {
      setLoadingModels(true);
      setModelError(undefined);
      try {
        const [configPayload, modelPayload] = await Promise.all([fetchConfig(), fetchModels()]);
        if (cancelled) return;
        setConfig(configPayload.config);
        setConfigPresent(configPayload.configPresent);
        setModels(modelPayload.models);
      } catch (error) {
        if (cancelled) return;
        setModelError(describeSettingsLoadError(error));
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  // Issue #144: source of truth is the helper, not an inline kind check.
  const chatCount = models.filter(isConversationEligibleModel).length;
  const gatewayConfigured = configPresent;
  const hasDiscoveredModels = models.length > 0;
  const gatewayStatusLabel = !gatewayConfigured
    ? "Gateway setup required"
    : hasDiscoveredModels
      ? "Gateway connected"
      : "Gateway configured";
  // uiux-fix C286: with models discovered but zero conversation-eligible ones
  // (e.g. embedding/OCR-only gateways) the detail must not claim chat works.
  const gatewayStatusDetail = !gatewayConfigured
    ? "Enter the gateway base URL and API token before using chat or agent workflows."
    : !hasDiscoveredModels
      ? "The gateway is configured, but no conversation-capable models are currently available."
      : chatCount === 0
        ? "Gateway connected, but none of the discovered models can be used for conversation. Add a chat-capable deployment."
        : "Keiko can use the configured gateway models for chat and agent workflows.";
  const gatewayStatusTone = gatewayConfigured ? "connected" : "untested";

  async function handleRunReadiness(modelId: string, deep: boolean): Promise<void> {
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
        [modelId]: { status: "error", message: readinessErrorMessage(error) },
      }));
    }
  }

  return (
    <div className="set">
      <div className="set-hero">
        <Icons.settings size={18} />
        <span className="set-title">Settings</span>
        <span className="set-onprem" title="Runs inside your network">
          <span className="dot" style={{ background: "var(--accent)" }} /> Self-hosted
        </span>
      </div>
      <div className="set-tabs">
        {(["models", "general", "security"] as readonly Tab[]).map((id) => (
          <button
            type="button"
            key={id}
            className="set-tab"
            data-on={tab === id}
            // uiux-fix C070: expose the active tab to assistive technology —
            // toggle-button pattern, same as the density buttons in
            // RelationshipListPanel (state was previously CSS-only via data-on).
            aria-pressed={tab === id}
            onPointerDown={() => setTab(id)}
            onClick={() => setTab(id)}
          >
            {/* uiux-fix C147: the tab shows the remote model gateway, not local models */}
            {id === "models" ? "Models" : id === "general" ? "General" : "Security"}
          </button>
        ))}
      </div>
      <div className="set-body">
        {tab === "models" && (
          <>
            <div className="set-sec-h">
              <div>
                <div className="set-sec-t">Model gateway</div>
                <div className="set-sec-d">
                  Credentials are stored locally by the Keiko loopback server; secrets are never
                  returned to the browser.
                </div>
              </div>
              <button type="button" className="set-add" onClick={() => setSetupOpen(true)}>
                <Icons.plus size={14} />
                {gatewayConfigured ? "Update credentials" : "Connect gateway"}
              </button>
            </div>

            <div className="ml-row">
              <span className="ml-ico">
                <Icons.cube size={16} />
              </span>
              <div className="ml-info">
                <div className="ml-top">
                  <span className="ml-name">{gatewayStatusLabel}</span>
                  <span className="ml-type mono">{models.length.toString()} models</span>
                  <span className="ml-type mono">{chatCount.toString()} chat</span>
                </div>
                <div className="ml-url mono">{gatewayStatusDetail}</div>
              </div>
              <span
                className={"ml-status " + gatewayStatusTone}
                title={gatewayConfigured ? "gateway configured" : "setup required"}
                aria-hidden="true"
              />
            </div>

            {/* uiux-fix C285/C287: async failure is announced (role=alert) and
                recoverable in place via Retry — fetchModels drops its cached
                promise on rejection, so a retry really re-fetches. */}
            {modelError !== undefined ? (
              <div className="gw-error" role="alert">
                {modelError}
                <button
                  type="button"
                  className="gw-error-retry"
                  onClick={() => setReloadTick((tick) => tick + 1)}
                >
                  Retry
                </button>
              </div>
            ) : null}

            {/* uiux-fix C285: loading -> result transition is announced */}
            {loadingModels ? (
              <div className="set-placeholder" role="status">
                Loading gateway models…
              </div>
            ) : models.length === 0 ? (
              <div className="set-placeholder" role="status">
                {gatewayConfigured
                  ? "No conversation-capable models are currently available. Review the gateway configuration or discovered model set."
                  : "No models are configured yet. Connect the gateway to load configured model capabilities."}
              </div>
            ) : (
              <div className="set-list">
                {models.map((model) => (
                  <ModelCapabilityRow
                    key={model.id}
                    model={model}
                    readiness={readiness[model.id]}
                    onRunReadiness={(modelId, deep) => {
                      void handleRunReadiness(modelId, deep);
                    }}
                  />
                ))}
              </div>
            )}

            {setupOpen ? (
              <GatewaySetupDialog
                onCancel={() => setSetupOpen(false)}
                preserveExisting={gatewayConfigured}
                storedApiKeyHeaderName={config?.providers[0]?.credentialHeaderName}
                storedModels={models}
              />
            ) : null}
          </>
        )}
        {tab === "general" && <GeneralPrefs />}
        {tab === "security" && (
          <div className="set-placeholder">SSO · audit log · data residency — coming soon.</div>
        )}
      </div>
    </div>
  );
}
