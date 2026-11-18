"use client";

import { startingProjectPaths } from "../windows/startingProjectRoot";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { fetchProjects } from "@/lib/api";
import { pickWithNativeDialog } from "@/lib/native-file-dialog";
import { Icons } from "../Icons";
import { useNativeFileDialogCapability } from "../hooks/useNativeFileDialogCapability";
import {
  localizedWindowConfigFields,
  localizedWindowCta,
  localizedWindowDesc,
  localizedWindowTitle,
  type LocalizedConfigField,
  type WIN_TYPES as WinTypes,
  type WindowType,
} from "../windows/WindowsRegistry";
import { CHAT_TITLE_IS_DEFAULT_CFG_KEY } from "../windows/connectionUtils";
import KeikoSelect from "../KeikoSelect";
import { PermControl, type Cfg, type CfgValue } from "./PermControl";
import { restoreModalFocusAfterUnlock } from "./modalFocusRestore";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { startFilesNavigationEvidence } from "@/lib/files-navigation-evidence";
import { useEditorProjectConnection } from "../widgets/cards/useEditorProjectConnection";
// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CloseIcon = Icons.close;

interface NewWindowDialogProps {
  readonly type: WindowType;
  readonly types: typeof WinTypes;
  readonly opener?: HTMLElement | null;
  readonly onConfirm: (cfg: Cfg) => void;
  readonly onClose: () => void;
}

function initialCfg(fields: readonly LocalizedConfigField[]): Cfg {
  const out: Cfg = {};
  for (const f of fields) {
    out[f.key] = f.def;
  }
  return out;
}

function useNewWindowFocusRestore(opener: HTMLElement | null | undefined): void {
  const triggerRef = useRef(opener ?? null);
  useEffect((): (() => void) => {
    const trigger = triggerRef.current;
    return () => {
      // Audit C148 — confirming from the Empty State unmounts the trigger button
      // (the first window replaces the empty state), so focusing it silently
      // dropped keyboard focus to <body>. Fall back to the freshly created top
      // window (focusable via tabIndex={-1}) or the New-window FAB. The shared
      // helper waits until AppShell unlocks an inert background before focusing
      // a connected opener, then applies the MD-05 deterministic fallback.
      restoreModalFocusAfterUnlock(trigger);
    };
  }, []);
}

// 0.3.0 release audit — the dialog seeds the chat title field with the LOCALIZED default, so that
// display string must not leave the dialog as data. When the operator accepts it unchanged (or
// clears the field), the window is confirmed with NO title plus the structural "still untitled"
// marker the workspace reads (`CHAT_TITLE_IS_DEFAULT_CFG_KEY`). Two things then hold in every
// locale: the workspace never repeats the default title as a subtitle, and the chat record keeps
// the server's canonical stored default, which is what the server's first-turn auto-title keys on
// — a German chat used to be created as "Neuer Chat" and could therefore never be auto-titled.
// An operator-chosen title is passed through untouched and carries no marker.
function withChatUntitledMarker(
  type: WindowType,
  fields: readonly LocalizedConfigField[],
  cfg: Cfg,
): Cfg {
  if (type !== "chat") return cfg;
  const seededDefault = fields.find((field) => field.key === "title")?.def ?? "";
  const entered = resolveFieldValue(cfg["title"]).trim();
  if (entered.length > 0 && entered !== seededDefault.trim()) return cfg;
  const { title, ...rest } = cfg;
  return { ...rest, [CHAT_TITLE_IS_DEFAULT_CFG_KEY]: true };
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

function errorMessage(error: unknown, t: I18nTranslate): string {
  return error instanceof Error ? error.message : t("newWindow.unexpectedError");
}

// Epic #1941 (ADR-0118 D4) — copy for the two calm native-dialog outcomes every Browse surface in
// this dialog shares. Manual path entry stays available either way. The copy lives in the shared
// catalog (`nativeDialog.*`) so the German shell no longer falls back to an English sentence.

// Opens the native OS folder dialog and routes the outcome: a picked path lands in `onPick`,
// cancellation is a non-event, everything else becomes calm dialog copy via `onError`.
async function browseNativeDirectory(
  seedPath: string,
  title: string,
  onPick: (path: string) => void,
  onError: (message: string) => void,
  t: I18nTranslate,
): Promise<void> {
  const trimmed = seedPath.trim();
  const outcome = await pickWithNativeDialog({
    mode: "open-directory",
    title,
    ...(trimmed.length > 0 ? { defaultPath: trimmed } : {}),
  });
  if (outcome.kind === "picked" && outcome.paths[0] !== undefined) {
    onPick(outcome.paths[0]);
    return;
  }
  if (outcome.kind === "busy") onError(t("nativeDialog.busy"));
  if (outcome.kind === "unsupported") onError(t("nativeDialog.unsupported"));
  if (outcome.kind === "error") onError(outcome.message);
}

interface DirectoryBrowseControl {
  readonly supported: boolean;
  readonly open: (key: string, value: string) => void;
}

export function resolveFieldValue(raw: CfgValue): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined) return "";
  return String(raw);
}

function renderDirectoryField(
  f: LocalizedConfigField,
  value: string,
  set: (key: string, value: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  browse: DirectoryBrowseControl,
  t: I18nTranslate,
): ReactNode {
  const nativeNoteId = `dlg-native-note-${f.key}`;
  return (
    <>
      <span className="dlg-dirwrap">
        <input
          ref={firstRef ?? undefined}
          className="dlg-input mono"
          placeholder={f.placeholder ?? f.label}
          value={value}
          onChange={(e) => set(f.key, e.target.value)}
        />
        <button
          type="button"
          className="dlg-btn dlg-dirbtn"
          disabled={!browse.supported}
          aria-describedby={browse.supported ? undefined : nativeNoteId}
          onClick={() => browse.open(f.key, value)}
        >
          {t("common.browse")}
        </button>
      </span>
      {!browse.supported ? (
        <span id={nativeNoteId} className="dlg-note">
          {t("nativeDialog.unsupported")}
        </span>
      ) : null}
    </>
  );
}

function renderField(
  f: LocalizedConfigField,
  cfg: Cfg,
  set: (k: string, v: CfgValue) => void,
  firstRef: ((node: HTMLElement | null) => void) | null,
  browse: DirectoryBrowseControl,
  t: I18nTranslate,
): ReactNode {
  if (f.type === "perm") return <PermControl cfg={cfg} set={set} />;
  const raw = cfg[f.key];
  const value = resolveFieldValue(raw);
  if (f.type === "select") {
    const options = f.options ?? [];
    return (
      <span className="dlg-selwrap">
        <KeikoSelect
          triggerClassName="dlg-input mono"
          value={value}
          disabled={options.length === 0}
          /* eslint-disable-next-line jsx-a11y/no-autofocus -- dialog opens with the first configured launcher control focused. */
          autoFocus={firstRef !== null}
          menuTitle={f.label}
          mono
          sections={[
            {
              options: options.map((option) => ({
                value: option,
                label: `${f.prefix ?? ""}${option}`,
              })),
            },
          ]}
          onValueChange={(next) => set(f.key, next)}
        />
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
  if (f.type === "directory") return renderDirectoryField(f, value, set, firstRef, browse, t);
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

function trapDialogTab(e: KeyboardEvent<HTMLDialogElement>): void {
  if (e.key !== "Tab") return;
  const f = focusableInside(e.currentTarget);
  if (f.length === 0) return;
  const first = f[0] as HTMLElement;
  const last = f.at(-1) as HTMLElement;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function NewWindowDialog({
  type,
  types,
  opener,
  onConfirm,
  onClose,
}: NewWindowDialogProps): ReactNode {
  const translate = useTranslate();
  const def = types[type];
  // Every launcher field arrives already localized; `type === "chat"` no longer needs a bespoke
  // branch, because the whole registry now carries message keys instead of English literals.
  const fields = useMemo(() => localizedWindowConfigFields(translate, type), [translate, type]);
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(fields));
  const [shown, setShown] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [connectingEditor, setConnectingEditor] = useState(false);
  const connectEditorRoot = useEditorProjectConnection({
    root: "",
    onNotice: setDialogError,
    onBusy: setConnectingEditor,
  });
  const nativeDialogSupported = useNativeFileDialogCapability();
  const firstFieldRef = useRef<HTMLElement | null>(null);
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  useNewWindowFocusRestore(opener);
  const windowLabel = localizedWindowTitle(translate, type);
  const dialogTitle = translate("newWindow.title", { label: windowLabel });
  const dialogDesc = localizedWindowDesc(translate, type);
  const cta =
    localizedWindowCta(translate, type) ?? translate("newWindow.open", { label: windowLabel });

  useEffect(() => {
    const r = requestAnimationFrame(() => {
      setShown(true);
      // uiux-fix F008 C053 — config-less types (connector, figma) have no first field, so focus
      // used to stay on the trigger OUTSIDE this aria-modal dialog: Escape and the Tab trap
      // (both bound to the dialog div) never fired. Fall back to the dialog container itself.
      const target = firstFieldRef.current ?? dlgRef.current;
      target?.focus();
      // #4335 — a prefilled default (the chat title) must be replaced by typing, not appended to.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select();
      }
    });
    return () => cancelAnimationFrame(r);
  }, []);

  // uiux-fix F008 C053 — window-level Escape covers the residual cases where focus sits outside
  // the dialog (the div's own onKeyDown only fires while focus is inside). Scoped to the dialog's
  // lifetime via the effect cleanup so it never eats Escape meant for other overlays.
  useEffect(() => {
    const onWindowKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [onClose]);

  // ADR-0018 — no shell prefetch: the terminal tool is a permitted-command picker now. The
  // window only needs a projectPath and an optional cwd, both supplied via the form below.

  useEffect(() => {
    if (type !== "files" && type !== "editor") return;
    let cancelled = false;
    const currentRoot = cfg.root;
    if (typeof currentRoot === "string" && currentRoot.length > 0) return;
    setDialogError(null);
    void fetchProjects()
      .then((payload) => {
        // A project the read surface refuses is never the prefilled folder (#4371).
        const firstProject = startingProjectPaths(payload.projects)[0];
        if (!cancelled && firstProject !== undefined) {
          setCfg((current) => ({ ...current, root: firstProject }));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setDialogError(errorMessage(error, translate));
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.root, type, translate]);

  const set = (k: string, v: CfgValue): void => setCfg((s) => ({ ...s, [k]: v }));
  // Epic #1941 — directory fields browse through the native OS dialog; a picked folder lands in
  // the same cfg slot the manual input writes, cancellation changes nothing.
  const browse: DirectoryBrowseControl = {
    supported: nativeDialogSupported,
    open: (key, value) => {
      setDialogError(null);
      void browseNativeDirectory(
        value,
        translate("nativeDialog.selectFolder"),
        (path) => set(key, path),
        setDialogError,
        translate,
      );
    },
  };
  const submit = (): void => {
    const selectedCfg =
      (type === "files" || type === "editor") &&
      typeof cfg.root === "string" &&
      cfg.root.trim().length > 0
        ? { ...cfg, rootBinding: "coding-repository" }
        : cfg;
    if (
      type === "editor" &&
      typeof selectedCfg.root === "string" &&
      selectedCfg.root.trim().length > 0
    ) {
      if (connectingEditor) return;
      void connectEditorRoot(
        selectedCfg.root.trim(),
        (root, _correlationId, warning, warningCorrelationId) => {
          onConfirm({
            ...selectedCfg,
            root,
            ...(warning === undefined
              ? {}
              : {
                  workspaceNoticeCode: "trust-grant-failed",
                  workspaceNoticeCorrelationId: warningCorrelationId,
                }),
          });
        },
      );
      return;
    }
    const settle =
      type === "files" ? startFilesNavigationEvidence("files project selection") : undefined;
    try {
      onConfirm(withChatUntitledMarker(type, fields, selectedCfg));
    } finally {
      settle?.(undefined, "applied");
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDialogElement>): void => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      submit();
      return;
    }
    // uiux-fix F017 C364 — plain Enter in a single-line field confirms the dialog
    // (one-field-dialog expectation). Textareas keep Enter for newlines and buttons keep
    // native activation.
    if (e.key === "Enter") {
      const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
      if (tag === "INPUT" || tag === "SELECT") {
        e.preventDefault();
        submit();
      }
      return;
    }
    trapDialogTab(e);
  };

  const Icon = Icons[def.icon];

  return (
    <div className={"dlg-overlay" + (shown ? " in" : "")} onPointerDown={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog needs Esc/Tab/⌘Enter key handling */}
      <dialog
        open
        ref={dlgRef}
        className="dlg"
        aria-modal="true"
        aria-labelledby="new-window-title"
        aria-describedby="new-window-desc"
        tabIndex={-1}
        style={{ position: "relative", inset: "auto", margin: 0, padding: 0, color: "inherit" }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="dlg-head">
          <span className="dlg-ico">
            <Icon size={20} />
          </span>
          <div className="dlg-htext">
            <span id="new-window-title" className="dlg-title">
              {dialogTitle}
            </span>
            <span id="new-window-desc" className="dlg-sub">
              {dialogDesc}
            </span>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="palette-x"
            onClick={onClose}
            aria-label={translate("common.cancel")}
            title={translate("common.cancel")}
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="dlg-body">
          {fields.length === 0 && (
            <div className="dlg-empty">{translate("newWindow.empty", { label: windowLabel })}</div>
          )}
          {fields.map((f, i) => (
            <label className="dlg-field" key={f.key}>
              <span className="dlg-label">
                {f.label}
                {f.optional === true && (
                  <span className="dlg-opt">{translate("common.optional")}</span>
                )}
              </span>
              {renderField(
                f,
                cfg,
                set,
                i === 0
                  ? (node) => {
                      firstFieldRef.current = node;
                    }
                  : null,
                browse,
                translate,
              )}
            </label>
          ))}
          {dialogError !== null ? (
            <div className="dlg-error" role="alert">
              {dialogError}
            </div>
          ) : null}
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onClose}>
            {translate("common.cancel")}
          </button>
          <button
            type="button"
            className="dlg-btn dlg-primary"
            disabled={connectingEditor}
            onClick={submit}
          >
            {connectingEditor ? translate("editor.empty.opening") : cta}
          </button>
        </div>
      </dialog>
    </div>
  );
}
