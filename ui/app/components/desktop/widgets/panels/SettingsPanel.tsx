"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { Icons, type IconName } from "../../Icons";

type ModelType = "chat" | "coding" | "reasoning" | "embedding";
type ModelStatus = "untested" | "testing" | "connected" | "error";

interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly type: ModelType;
  readonly url: string;
  readonly key: string;
  readonly status: ModelStatus;
}

const MODEL_TYPES: readonly { readonly id: ModelType; readonly label: string; readonly icon: IconName }[] = [
  { id: "chat", label: "Chat", icon: "newChat" },
  { id: "coding", label: "Coding", icon: "editor" },
  { id: "reasoning", label: "Reasoning", icon: "spark" },
  { id: "embedding", label: "Embedding", icon: "cube" },
];

const DEFAULT_MODELS: readonly ModelRow[] = [
  { id: "m1", name: "orca-chat-5.4", type: "chat", url: "https://llm.corp.local/v1", key: "sk-int-••••", status: "connected" },
  { id: "m2", name: "orca-coder-5.4", type: "coding", url: "https://llm.corp.local/v1", key: "sk-int-••••", status: "connected" },
  { id: "m3", name: "orca-reason-xl", type: "reasoning", url: "https://reason.corp.local/v1", key: "", status: "untested" },
  { id: "m4", name: "bge-large-internal", type: "embedding", url: "https://embed.corp.local/v1", key: "sk-int-••••", status: "connected" },
];

const KEY = "keiko.models.v1";

const ALLOWED_TYPES = new Set<ModelType>(["chat", "coding", "reasoning", "embedding"]);
const ALLOWED_STATUSES = new Set<ModelStatus>(["connected", "error", "untested", "testing"]);

function isValidRow(row: unknown): row is ModelRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return false;
  if (typeof r.url !== "string" || typeof r.key !== "string") return false;
  if (typeof r.type !== "string" || !ALLOWED_TYPES.has(r.type as ModelType)) return false;
  if (typeof r.status !== "string" || !ALLOWED_STATUSES.has(r.status as ModelStatus)) return false;
  // url must be https://, http://, or empty — guards against javascript: XSS if url is ever rendered as an <a href>
  if (r.url.length > 0 && !r.url.startsWith("https://") && !r.url.startsWith("http://")) return false;
  return true;
}

function readModels(): readonly ModelRow[] {
  if (typeof window === "undefined") return DEFAULT_MODELS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_MODELS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isValidRow)) return DEFAULT_MODELS;
    return parsed;
  } catch {
    return DEFAULT_MODELS;
  }
}

function statusLabel(s: ModelStatus): string {
  if (s === "testing") return "Testing…";
  if (s === "connected") return "✓ Connected";
  if (s === "error") return "✕ Unreachable";
  return "Not tested";
}

function typeIcon(t: ModelType): IconName {
  return MODEL_TYPES.find((x) => x.id === t)?.icon ?? "cube";
}

type FormState = {
  readonly name: string;
  readonly type: ModelType;
  readonly url: string;
  readonly key: string;
  readonly status: ModelStatus;
};

function ModelForm({
  form,
  setForm,
  onTest,
  onSave,
  onCancel,
}: {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState | null>>;
  onTest: () => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactNode {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void =>
    setForm((f) => {
      if (f === null) return f;
      const nextStatus: ModelStatus = k === "url" || k === "key" ? "untested" : f.status;
      return { ...f, [k]: v, status: nextStatus };
    });
  return (
    <div className="mform">
      <div className="mform-grid">
        <label className="mfield">
          <span>Name</span>
          <input
            className="set-input"
            value={form.name}
            placeholder="orca-chat-5.4"
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label className="mfield">
          <span>Type</span>
          <span className="set-selwrap">
            <select
              className="set-input"
              value={form.type}
              onChange={(e) => set("type", e.target.value as ModelType)}
            >
              {MODEL_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <span className="set-chev"><Icons.chevron size={14} /></span>
          </span>
        </label>
      </div>
      <label className="mfield">
        <span>Base URL</span>
        <input
          className="set-input mono"
          value={form.url}
          placeholder="https://llm.corp.local/v1"
          onChange={(e) => set("url", e.target.value)}
        />
      </label>
      <label className="mfield">
        <span>API Key</span>
        <input
          className="set-input mono"
          type="password"
          value={form.key}
          placeholder="sk-…  ·  stored locally, never leaves your network"
          onChange={(e) => set("key", e.target.value)}
        />
      </label>
      <div className="mform-foot">
        <span className={"mform-status " + form.status}>{statusLabel(form.status)}</span>
        <span className="spacer" />
        <button type="button" className="set-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="set-btn" onClick={onTest}>Test</button>
        <button type="button" className="set-btn primary" onClick={onSave}>Save</button>
      </div>
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
  const [models, setModels] = useState<readonly ModelRow[]>(readModels);
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(models));
    } catch {
      /* ignore quota / private mode */
    }
  }, [models]);

  const startAdd = (): void =>
    setForm({ name: "", type: "chat", url: "", key: "", status: "untested" });

  const test = (): void => {
    setForm((f) => (f === null ? f : { ...f, status: "testing" }));
    setTimeout(() => {
      setForm((f) => {
        if (f === null) return f;
        return { ...f, status: f.url === "" ? "error" : "connected" };
      });
    }, 900);
  };

  const save = (): void => {
    if (form === null || form.name === "" || form.url === "") return;
    const row: ModelRow = { ...form, id: "m" + Date.now().toString(36) };
    setModels((m) => [...m, row]);
    setForm(null);
  };

  const del = (id: string): void => setModels((m) => m.filter((x) => x.id !== id));

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
                <div className="set-sec-t">Local Model Config</div>
                <div className="set-sec-d">
                  Connect models hosted inside your network — behind your firewall. Keys are stored locally.
                </div>
              </div>
              {form === null && (
                <button type="button" className="set-add" onClick={startAdd}>
                  <Icons.plus size={14} /> Add model
                </button>
              )}
            </div>
            {form !== null && (
              <ModelForm
                form={form}
                setForm={setForm}
                onTest={test}
                onSave={save}
                onCancel={() => setForm(null)}
              />
            )}
            <div className="set-list">
              {models.map((m) => {
                const Icon = Icons[typeIcon(m.type)];
                return (
                  <div className="ml-row" key={m.id}>
                    <span className="ml-ico"><Icon size={16} /></span>
                    <div className="ml-info">
                      <div className="ml-top">
                        <span className="ml-name">{m.name}</span>
                        <span className="ml-type mono">{m.type}</span>
                      </div>
                      <div className="ml-url mono">{m.url === "" ? "—" : m.url}</div>
                    </div>
                    <span className="ml-key mono">{m.key === "" ? "no key" : "••••"}</span>
                    <span className={"ml-status " + m.status} title={m.status} />
                    <button
                      type="button"
                      className="ml-del"
                      aria-label={`Remove ${m.name}`}
                      title="Remove"
                      onClick={() => del(m.id)}
                    >
                      <Icons.close size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
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
