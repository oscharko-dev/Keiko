"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { fetchFilesDirectories, fetchTerminalConfig } from "../../../../lib/api";
import type {
  FilesDirectoryListing,
  TerminalConfig,
  TerminalShell,
} from "../../../../lib/types";
import { Icons } from "../Icons";
import {
  type ConfigField,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import { PermControl, type Cfg, type CfgValue } from "./PermControl";

interface NewWindowDialogProps {
  readonly type: WindowType;
  readonly types: typeof WinTypes;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

function initialCfg(fields: readonly ConfigField[]): Cfg {
  const out: Cfg = {};
  for (const f of fields) {
    out[f.key] = f.def ?? "";
  }
  return out;
}

function focusableInside(root: HTMLElement): readonly HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>("button,input,select,textarea");
  const out: HTMLElement[] = [];
  nodes.forEach((n) => {
    if (n.hasAttribute("disabled")) return;
    if (n.offsetParent === null && n.tagName !== "BUTTON") return;
    out.push(n);
  });
  return out;
}

interface DirectoryPickerProps {
  readonly value: string;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to read directories.";
}

function DirectoryPicker({ value, onSelect, onClose }: DirectoryPickerProps): ReactNode {
  const [listing, setListing] = useState<FilesDirectoryListing | null>(null);
  const [draft, setDraft] = useState(value);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchFilesDirectories(path);
      setListing(next);
      setDraft(next.path);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(value.length > 0 ? value : undefined);
  }, [load, value]);

  const choose = (): void => {
    if (listing !== null) {
      onSelect(listing.path);
      onClose();
    }
  };

  return (
    <div className="dir-picker" role="group" aria-label="Directory picker">
      <div className="dir-top">
        <input
          className="dlg-input mono dir-path"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void load(draft);
            }
          }}
        />
        <button type="button" className="dlg-btn dir-go" onClick={() => void load(draft)}>
          Go
        </button>
      </div>
      {listing !== null ? (
        <div className="dir-roots">
          {listing.roots.map((root) => (
            <button
              type="button"
              key={`${root.label}:${root.path}`}
              className="dir-chip"
              onClick={() => void load(root.path)}
            >
              {root.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dir-list">
        {listing?.parent !== null && listing?.parent !== undefined ? (
          <button type="button" className="dir-row" onClick={() => void load(listing.parent ?? undefined)}>
            <Icons.back size={14} />
            <span>Parent directory</span>
          </button>
        ) : null}
        {listing?.entries.map((entry) => (
          <button
            type="button"
            className="dir-row"
            key={entry.path}
            onClick={() => void load(entry.path)}
          >
            <Icons.folder size={14} />
            <span>{entry.name}</span>
          </button>
        ))}
        {loading ? <div className="dir-note">Loading directories...</div> : null}
        {!loading && listing !== null && listing.entries.length === 0 ? (
          <div className="dir-note">No child directories.</div>
        ) : null}
        {error !== null ? <div className="dir-error">{error}</div> : null}
      </div>
      <div className="dir-actions">
        <button type="button" className="dlg-btn" onClick={onClose}>Close</button>
        <button type="button" className="dlg-btn dlg-primary" onClick={choose} disabled={listing === null}>
          Use directory
        </button>
      </div>
    </div>
  );
}

function shellOptions(
  field: ConfigField,
  terminalConfig: TerminalConfig | null,
): readonly TerminalShell[] | null {
  if (field.key !== "shell" || terminalConfig === null) return null;
  return terminalConfig.shells;
}

function renderField(
  f: ConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  terminalConfig: TerminalConfig | null,
  openDirectoryPicker: (key: string) => void,
): ReactNode {
  if (f.type === "perm") return <PermControl cfg={cfg} set={set} />;
  const raw = cfg[f.key];
  const value = typeof raw === "string" ? raw : raw === undefined ? "" : String(raw);
  if (f.type === "select") {
    const dynamicShells = shellOptions(f, terminalConfig);
    const options = dynamicShells !== null ? dynamicShells.map((shell) => shell.id) : (f.options ?? []);
    return (
      <span className="dlg-selwrap">
        <select
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          value={value}
          onChange={(e) => set(f.key, e.target.value)}
          disabled={options.length === 0}
        >
          {dynamicShells !== null ? dynamicShells.map((shell) => (
            <option key={shell.id} value={shell.id}>{shell.label}</option>
          )) : options.map((o) => (
            <option key={o} value={o}>{(f.prefix ?? "") + o}</option>
          ))}
        </select>
        <span className="dlg-selchev"><Icons.chevron size={15} /></span>
      </span>
    );
  }
  if (f.type === "textarea") {
    return (
      <textarea
        ref={firstRef ?? undefined}
        className="dlg-input dlg-textarea"
        rows={3}
        placeholder={f.placeholder ?? ""}
        value={value}
        onChange={(e) => set(f.key, e.target.value)}
      />
    );
  }
  if (f.type === "directory") {
    return (
      <span className="dlg-dirwrap">
        <input
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          placeholder={f.placeholder ?? f.label}
          value={value}
          onClick={() => openDirectoryPicker(f.key)}
          onChange={(e) => set(f.key, e.target.value)}
        />
        <button type="button" className="dlg-dirbtn" onClick={() => openDirectoryPicker(f.key)}>
          Browse
        </button>
      </span>
    );
  }
  return (
    <input
      ref={firstRef ?? undefined}
      className="dlg-input mono"
      placeholder={f.placeholder ?? f.label}
      value={value}
      onChange={(e) => set(f.key, e.target.value)}
    />
  );
}

export function NewWindowDialog({
  type,
  types,
  onConfirm,
  onClose,
}: NewWindowDialogProps): ReactNode {
  const t = types[type];
  const fields = t.config ?? [];
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [terminalConfig, setTerminalConfig] = useState<TerminalConfig | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [directoryField, setDirectoryField] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // capture the element that opened this dialog so we can return focus on close
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const r = requestAnimationFrame(() => {
      setShown(true);
      firstFieldRef.current?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    if (type !== "terminal") return;
    let cancelled = false;
    setDialogError(null);
    void fetchTerminalConfig()
      .then((config) => {
        if (cancelled) return;
        setTerminalConfig(config);
        setCfg((current) => {
          const next = { ...current };
          if (typeof next.cwd !== "string" || next.cwd.length === 0) {
            next.cwd = config.defaultCwd;
          }
          const currentShell = typeof next.shell === "string" ? next.shell : "";
          const available = config.shells.some((shell) => shell.id === currentShell);
          if (!available && config.defaultShell !== null) {
            next.shell = config.defaultShell;
          }
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  useEffect(() => {
    if (type !== "files") return;
    let cancelled = false;
    const currentRoot = cfg.root;
    if (typeof currentRoot === "string" && currentRoot.length > 0) return;
    setDialogError(null);
    void fetchFilesDirectories()
      .then((listing) => {
        if (!cancelled) setCfg((current) => ({ ...current, root: listing.path }));
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.root, type]);

  const set = (k: string, v: CfgValue): void => setCfg((s) => ({ ...s, [k]: v }));
  const submit = (): void => onConfirm(cfg);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { submit(); return; }
    if (e.key !== "Tab") return;
    const f = focusableInside(e.currentTarget);
    if (f.length === 0) return;
    const first = f[0] as HTMLElement;
    const last = f[f.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const Icon = Icons[t.icon];
  const cta = t.cta ?? `Open ${t.title}`;

  return (
    <div className={"dlg-overlay" + (shown ? " in" : "")} onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Esc/Tab/⌘Enter key handling */}
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={`New ${t.title} window`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="dlg-head">
          <span className="dlg-ico"><Icon size={20} /></span>
          <div className="dlg-htext">
            <span className="dlg-title">New {t.title} window</span>
            <span className="dlg-sub">{t.desc}</span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="palette-x"
            onClick={onClose}
            aria-label="Cancel"
            title="Cancel"
          >
            <Icons.close size={16} />
          </button>
        </div>
        <div className="dlg-body">
          {fields.length === 0 && (
            <div className="dlg-empty">Add a new {t.title} window to your workspace.</div>
          )}
          {fields.map((f, i) => (
            <label className="dlg-field" key={f.key}>
              <span className="dlg-label">
                {f.label}
                {f.optional === true && <span className="dlg-opt">optional</span>}
              </span>
              {renderField(
                f,
                cfg,
                set,
                i === 0 ? (node) => { firstFieldRef.current = node; } : null,
                terminalConfig,
                setDirectoryField,
              )}
              {f.type === "directory" && directoryField === f.key ? (
                <DirectoryPicker
                  value={typeof cfg[f.key] === "string" ? cfg[f.key] as string : ""}
                  onSelect={(path) => set(f.key, path)}
                  onClose={() => setDirectoryField(null)}
                />
              ) : null}
            </label>
          ))}
          {dialogError !== null ? <div className="dlg-error">{dialogError}</div> : null}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="dlg-btn dlg-primary" onClick={submit}>{cta}</button>
        </div>
      </div>
    </div>
  );
}
