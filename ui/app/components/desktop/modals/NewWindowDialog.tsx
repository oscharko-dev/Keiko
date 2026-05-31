"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
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

function renderField(
  f: ConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
): ReactNode {
  if (f.type === "perm") return <PermControl cfg={cfg} set={set} />;
  const raw = cfg[f.key];
  const value = typeof raw === "string" ? raw : raw === undefined ? "" : String(raw);
  if (f.type === "select") {
    return (
      <span className="dlg-selwrap">
        <select
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          value={value}
          onChange={(e) => set(f.key, e.target.value)}
        >
          {(f.options ?? []).map((o) => (
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
  const firstFieldRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const r = requestAnimationFrame(() => {
      setShown(true);
      firstFieldRef.current?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, []);

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
              {renderField(f, cfg, set, i === 0 ? (node) => { firstFieldRef.current = node; } : null)}
            </label>
          ))}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="dlg-btn dlg-primary" onClick={submit}>{cta}</button>
        </div>
      </div>
    </div>
  );
}
