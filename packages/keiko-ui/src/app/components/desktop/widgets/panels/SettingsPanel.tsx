"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fetchConfig, fetchModels } from "@/lib/api";
import type { ModelCapability } from "@/lib/types";
import { Icons } from "../../Icons";
import { GatewaySetupDialog } from "../../modals/GatewaySetupDialog";

function kindLabel(kind: ModelCapability["kind"]): string {
  if (kind === "ocr-vision") return "OCR";
  return kind;
}

function ModelCapabilityRow({ model }: { readonly model: ModelCapability }): ReactNode {
  return (
    <div className="ml-row">
      <span className="ml-ico">
        <Icons.cube size={16} />
      </span>
      <div className="ml-info">
        <div className="ml-top">
          <span className="ml-name">{model.id}</span>
          <span className="ml-type mono">{kindLabel(model.kind)}</span>
        </div>
        <div className="ml-url mono">
          tools {model.toolCalling ? "yes" : "no"} · structured{" "}
          {model.structuredOutput ? "yes" : "no"} · {model.costClass}/{model.latencyClass}
        </div>
      </div>
      <span className={"ml-status " + (model.kind === "chat" ? "connected" : "untested")} title={model.kind} />
    </div>
  );
}

const WALLPAPER_OPACITY_KEY = "keiko.wallpaper.opacity";

function readWallpaperOpacity(): number {
  if (typeof window === "undefined") return 100;
  const raw = window.localStorage.getItem(WALLPAPER_OPACITY_KEY);
  if (raw === null) return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(0, Math.min(100, parsed));
}

function GeneralPrefs(): ReactNode {
  const [wp, setWp] = useState<number>(readWallpaperOpacity);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(WALLPAPER_OPACITY_KEY, String(wp));
    } catch {
      /* ignore quota / private mode */
    }
    window.dispatchEvent(new CustomEvent("keiko:wallpaper-opacity", { detail: wp }));
  }, [wp]);
  // CSS uses --p to fill the track; React's CSSProperties doesn't know custom props.
  const fill: CSSProperties = { ["--p"]: `${String(wp)}%` } as CSSProperties;
  return (
    <>
      <div className="set-sec-h">
        <div>
          <div className="set-sec-t">Workspace wallpaper</div>
          <div className="set-sec-d">
            Liquid Chrome — a subtle metallic flow behind the grid that reacts to your cursor and clicks. Set to 0 % for the plain workspace background.
          </div>
        </div>
      </div>
      <div className="gpref">
        <div className="gpref-row">
          <label className="gpref-label" htmlFor="wp-op">Wallpaper opacity</label>
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
          onChange={(e) => setWp(Number.parseInt(e.target.value, 10))}
          style={fill}
          aria-label="Wallpaper opacity"
        />
        <div className="gpref-scale"><span>Off</span><span>Full</span></div>
      </div>
    </>
  );
}

type Tab = "models" | "general" | "security";

export function SettingsPanel(): ReactNode {
  const [tab, setTab] = useState<Tab>("models");
  const [models, setModels] = useState<readonly ModelCapability[]>([]);
  const [configPresent, setConfigPresent] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelError, setModelError] = useState<string | undefined>();
  const [setupOpen, setSetupOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setLoadingModels(true);
      setModelError(undefined);
      try {
        const [configPayload, modelPayload] = await Promise.all([fetchConfig(), fetchModels()]);
        if (cancelled) return;
        setConfigPresent(configPayload.configPresent);
        setModels(modelPayload.models);
      } catch (error) {
        if (cancelled) return;
        setModelError(error instanceof Error ? error.message : "Could not load gateway settings.");
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const chatCount = models.filter((model) => model.kind === "chat").length;
  const connected = configPresent && models.length > 0;

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
            onClick={() => setTab(id)}
          >
            {id === "models" ? "Local Models" : id === "general" ? "General" : "Security"}
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
                  Credentials are stored locally by the Keiko loopback server; secrets are never returned to the browser.
                </div>
              </div>
              <button type="button" className="set-add" onClick={() => setSetupOpen(true)}>
                <Icons.plus size={14} />
                {connected ? "Update credentials" : "Connect gateway"}
              </button>
            </div>

            <div className="ml-row">
              <span className="ml-ico">
                <Icons.cube size={16} />
              </span>
              <div className="ml-info">
                <div className="ml-top">
                  <span className="ml-name">{connected ? "Gateway connected" : "Gateway setup required"}</span>
                  <span className="ml-type mono">{models.length.toString()} models</span>
                  <span className="ml-type mono">{chatCount.toString()} chat</span>
                </div>
                <div className="ml-url mono">
                  {connected
                    ? "Keiko can use the configured gateway models for chat and agent workflows."
                    : "Enter the gateway base URL and API token before using chat or agent workflows."}
                </div>
              </div>
              <span className={"ml-status " + (connected ? "connected" : "untested")} title={connected ? "connected" : "setup required"} />
            </div>

            {modelError !== undefined ? <div className="gw-error">{modelError}</div> : null}

            {loadingModels ? (
              <div className="set-placeholder">Loading gateway models...</div>
            ) : models.length === 0 ? (
              <div className="set-placeholder">
                No models are configured yet. Connect the gateway to load configured model capabilities.
              </div>
            ) : (
              <div className="set-list">
                {models.map((model) => (
                  <ModelCapabilityRow key={model.id} model={model} />
                ))}
              </div>
            )}

            {setupOpen ? <GatewaySetupDialog onCancel={() => setSetupOpen(false)} /> : null}
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
