"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fetchConfig, fetchModels } from "@/lib/api";
import type {
  ConversationIneligibilityReason,
  ModelCapability,
  SafeGatewayConfig,
} from "@/lib/types";
import { explainConversationIneligibility, isConversationEligibleModel } from "@/lib/types";
import { Icons } from "../../Icons";
import { GatewaySetupDialog } from "../../modals/GatewaySetupDialog";
import { Toggle } from "../shared/Toggle";
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

function ModelCapabilityRow({ model }: { readonly model: ModelCapability }): ReactNode {
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
      </div>
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
  const [frameInnerGlowStrength, setFrameInnerGlowStrength] =
    useState<number>(readFrameInnerGlowStrength);

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
  const [setupOpen, setSetupOpen] = useState(false);
  // uiux-fix C287: bumping the tick re-runs the load effect (Retry button).
  const [reloadTick, setReloadTick] = useState(0);

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
                  <ModelCapabilityRow key={model.id} model={model} />
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
