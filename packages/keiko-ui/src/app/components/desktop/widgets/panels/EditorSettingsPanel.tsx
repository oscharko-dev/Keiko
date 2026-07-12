"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  EditorM7AiActivationStatus,
  EditorM7ResolvedSetting,
  EditorM7SettingDefinition,
  EditorM7SettingId,
  EditorM7SettingScope,
  EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";
import { useEditorSettings } from "../cards/useEditorSettings";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";
import { WorkspaceSnippetsPanel } from "./WorkspaceSnippetsPanel";

import styles from "./EditorSettingsPanel.module.css";

export function EditorSettingsPanel({ root }: { readonly root?: string | undefined }): ReactNode {
  const t = useTranslate();
  const view = useEditorSettings(root);
  const [scope, setScope] = useState<EditorM7SettingScope>("user");
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [pendingAiConfirm, setPendingAiConfirm] = useState<EditorM7SettingId | null>(null);
  const rows = useMemo(
    () =>
      filteredRows(
        view.snapshot?.definitions ?? [],
        view.snapshot?.settings ?? [],
        query,
        modifiedOnly,
        t,
      ),
    [modifiedOnly, query, t, view.snapshot],
  );
  const resetVisible = (): void => {
    void view.reset(
      scope,
      rows.map((row) => row.definition.id),
    );
  };
  return (
    <section className={styles.section} aria-labelledby="editor-settings-title">
      <header className={styles.header}>
        <h3 className={styles.title} id="editor-settings-title">
          {t("settings.editor.title")}
        </h3>
        <p className={styles.description}>{t("settings.editor.description")}</p>
      </header>
      <output className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {view.mutating ? t("settings.editor.applying") : ""}
        {view.announcement.length > 0 ? t("settings.editor.applied") : ""}
      </output>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          {t("settings.editor.search")}
          <input
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          {t("settings.editor.scope")}
          <select
            className={styles.select}
            value={scope}
            onChange={(event) => setScope(event.target.value as EditorM7SettingScope)}
          >
            <option value="user">{t("settings.editor.scopeUser")}</option>
            <option value="workspace" disabled={root === undefined}>
              {t("settings.editor.scopeWorkspace")}
            </option>
          </select>
        </label>
        <label className={styles.checkboxField}>
          <input
            className={styles.checkbox}
            type="checkbox"
            checked={modifiedOnly}
            onChange={(event) => setModifiedOnly(event.target.checked)}
          />
          {t("settings.editor.modifiedOnly")}
        </label>
        <button
          type="button"
          className={styles.button}
          disabled={view.mutating || rows.length === 0}
          onClick={resetVisible}
        >
          {t("settings.editor.resetAll")}
        </button>
      </div>
      {scope === "workspace" && root === undefined ? (
        <p className={styles.empty}>{t("settings.editor.noWorkspace")}</p>
      ) : null}
      {view.issue !== undefined ? (
        <div className={styles.alert} role="alert">
          <span>{issueCopy(view.issue, t)}</span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void view.refresh();
            }}
          >
            {t("settings.editor.retry")}
          </button>
        </div>
      ) : null}
      {view.loading && view.snapshot === undefined ? (
        <output className={styles.empty}>{t("settings.editor.loading")}</output>
      ) : null}
      {view.snapshot !== undefined && rows.length === 0 ? (
        <p className={styles.empty}>{t("settings.editor.empty")}</p>
      ) : null}
      <div className={styles.list}>
        {rows.map((row) => (
          <EditorSettingCard
            key={row.definition.id}
            aiStatus={aiStatusForSetting(
              row.definition.id,
              view.snapshot?.aiAssistance?.statuses ?? [],
            )}
            definition={row.definition}
            disabled={view.mutating}
            root={root}
            scope={scope}
            setting={row.setting}
            t={t}
            onReset={(id) => {
              void view.reset(scope, [id]);
            }}
            onSet={(id, value) => {
              if (value === true && requiresAiConfirmation(id)) {
                setPendingAiConfirm(id);
                return;
              }
              void view.setValue(scope, id, value);
            }}
          />
        ))}
      </div>
      <KeyboardShortcutsPanel root={root} scope={scope} view={view} />
      <WorkspaceSnippetsPanel root={root} />
      {pendingAiConfirm === null ? null : (
        <AiActivationConfirmDialog
          id={pendingAiConfirm}
          t={t}
          onAccept={() => {
            void view.setValue(scope, pendingAiConfirm, true);
            setPendingAiConfirm(null);
          }}
          onDecline={() => {
            setPendingAiConfirm(null);
          }}
        />
      )}
    </section>
  );
}

interface Row {
  readonly definition: EditorM7SettingDefinition;
  readonly setting: EditorM7ResolvedSetting;
}

function aiStatusForSetting(
  id: EditorM7SettingId,
  statuses: readonly EditorM7AiActivationStatus[],
): EditorM7AiActivationStatus | undefined {
  if (id === "inlineCompletion") {
    return statuses.find((status) => status.feature === "inlineCompletion");
  }
  if (id === "testGeneration")
    return statuses.find((status) => status.feature === "testGeneration");
  if (id === "patchApply") return statuses.find((status) => status.feature === "patchApply");
  return undefined;
}

function filteredRows(
  definitions: readonly EditorM7SettingDefinition[],
  settings: readonly EditorM7ResolvedSetting[],
  query: string,
  modifiedOnly: boolean,
  t: I18nTranslate,
): readonly Row[] {
  const normalized = query.trim().toLowerCase();
  return definitions.flatMap((definition) => {
    if (definition.id === "keybindingOverrides") return [];
    const setting = settings.find((entry) => entry.id === definition.id);
    if (setting === undefined) return [];
    if (modifiedOnly && setting.source === "builtInDefault") return [];
    const haystack = `${settingLabel(definition.id, t)} ${definition.description}`.toLowerCase();
    return normalized.length === 0 || haystack.includes(normalized)
      ? [{ definition, setting }]
      : [];
  });
}

function EditorSettingCard({
  aiStatus,
  definition,
  disabled,
  root,
  scope,
  setting,
  t,
  onReset,
  onSet,
}: {
  readonly aiStatus: EditorM7AiActivationStatus | undefined;
  readonly definition: EditorM7SettingDefinition;
  readonly disabled: boolean;
  readonly root: string | undefined;
  readonly scope: EditorM7SettingScope;
  readonly setting: EditorM7ResolvedSetting;
  readonly t: I18nTranslate;
  readonly onReset: (id: EditorM7SettingId) => void;
  readonly onSet: (id: EditorM7SettingId, value: EditorM7SettingValue) => void;
}): ReactNode {
  const unavailableReason = unavailable(definition, setting, scope, root, t);
  const controlDisabled = disabled || unavailableReason !== undefined;
  return (
    <article className={styles.card} aria-labelledby={`editor-setting-${definition.id}`}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.name} id={`editor-setting-${definition.id}`}>
            {settingLabel(definition.id, t)}
          </div>
          <div className={styles.help}>{definition.description}</div>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge}>{sourceLabel(setting.source, t)}</span>
          <span className={styles.badge}>{effectLabel(setting.effect, t)}</span>
          {setting.policyLocked ? (
            <span className={styles.badge} data-tone="danger">
              {t("settings.editor.policyLocked", { reason: setting.reasonCode ?? "policy" })}
            </span>
          ) : null}
          {aiStatus === undefined ? null : (
            <span className={styles.badge} data-tone={aiStatusTone(aiStatus)}>
              {t("settings.editor.aiStatus", {
                state: aiStatus.state,
                reason: aiStatus.reasonCode,
              })}
            </span>
          )}
        </div>
      </div>
      <div className={styles.control}>
        <SettingControl
          definition={definition}
          disabled={controlDisabled}
          setting={setting}
          onSet={onSet}
          t={t}
        />
        <button
          type="button"
          className={styles.button}
          disabled={disabled || !definition.scopes.includes(scope)}
          onClick={() => onReset(definition.id)}
        >
          {t("settings.editor.reset")}
        </button>
      </div>
      <div className={styles.meta}>
        {t("settings.editor.source", { source: sourceLabel(setting.source, t) })}
      </div>
      {unavailableReason === undefined ? null : (
        <div className={styles.meta}>{unavailableReason}</div>
      )}
    </article>
  );
}

function SettingControl({
  definition,
  disabled,
  setting,
  t,
  onSet,
}: {
  readonly definition: EditorM7SettingDefinition;
  readonly disabled: boolean;
  readonly setting: EditorM7ResolvedSetting;
  readonly t: I18nTranslate;
  readonly onSet: (id: EditorM7SettingId, value: EditorM7SettingValue) => void;
}): ReactNode {
  if (definition.type === "boolean") {
    return (
      <label className={styles.checkboxField}>
        <input
          className={styles.checkbox}
          type="checkbox"
          aria-label={settingLabel(definition.id, t)}
          checked={setting.value === true}
          disabled={disabled}
          onChange={(event) => {
            onSet(definition.id, event.target.checked);
          }}
        />
        {String(setting.value)}
      </label>
    );
  }
  if (definition.type === "integer") {
    return (
      <input
        aria-label={settingLabel(definition.id, t)}
        className={styles.input}
        type="number"
        min={definition.minimum}
        max={definition.maximum}
        value={typeof setting.value === "number" ? setting.value : ""}
        disabled={disabled}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isSafeInteger(next)) onSet(definition.id, next);
        }}
      />
    );
  }
  if (definition.type === "enum") {
    return (
      <select
        aria-label={settingLabel(definition.id, t)}
        className={styles.select}
        value={typeof setting.value === "string" ? setting.value : ""}
        disabled={disabled}
        onChange={(event) => onSet(definition.id, event.target.value as EditorM7SettingValue)}
      >
        {(definition.enumValues ?? []).map((value) => (
          <option value={value} key={value}>
            {value}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span className={styles.meta}>
      {String(Array.isArray(setting.value) ? setting.value.length : 0)}
    </span>
  );
}

function aiStatusTone(status: EditorM7AiActivationStatus): "success" | "warning" | "danger" {
  if (status.state === "active") return "success";
  if (status.state === "denied") return "danger";
  return "warning";
}

function requiresAiConfirmation(id: EditorM7SettingId): boolean {
  return id === "inlineCompletion" || id === "testGeneration" || id === "patchApply";
}

function aiActivationMessage(id: EditorM7SettingId, t: I18nTranslate): string {
  if (id === "inlineCompletion") return t("settings.editor.confirmInlineCompletion");
  if (id === "testGeneration") return t("settings.editor.confirmTestGeneration");
  return t("settings.editor.confirmPatchApply");
}

// Replaces window.confirm() (WCAG 2.2 AA: a native browser confirm is not keyboard/screen-reader
// operable, unstylable, and traps focus outside the app's control). Extends the accessible-dialog
// pattern already established by EditorWidget's dirty-close dialog (capture/restore focus, move
// focus into the dialog on mount, close on Escape) with real Tab/Shift+Tab containment, since
// aria-modal="true" on an alertdialog requires focus to stay inside it while open.
function AiActivationConfirmDialog({
  id,
  t,
  onAccept,
  onDecline,
}: {
  readonly id: EditorM7SettingId;
  readonly t: I18nTranslate;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}): ReactNode {
  const titleId = "editor-settings-ai-confirm-title";
  const descriptionId = "editor-settings-ai-confirm-description";
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (opener !== null && typeof opener.focus === "function" && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDecline();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button, [href]");
      if (focusable === undefined || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDecline]);
  return (
    <div className={styles.confirmBackdrop} role="presentation">
      <div
        className={styles.confirmDialog}
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <h4 className={styles.confirmTitle} id={titleId}>
          {t("settings.editor.confirmTitle")}
        </h4>
        <p className={styles.confirmBody} id={descriptionId}>
          {aiActivationMessage(id, t)}
        </p>
        <div className={styles.confirmActions}>
          <button type="button" className={styles.button} onClick={onDecline}>
            {t("settings.editor.confirmDecline")}
          </button>
          <button type="button" className={styles.button} onClick={onAccept}>
            {t("settings.editor.confirmAccept")}
          </button>
        </div>
      </div>
    </div>
  );
}

function unavailable(
  definition: EditorM7SettingDefinition,
  setting: EditorM7ResolvedSetting,
  scope: EditorM7SettingScope,
  root: string | undefined,
  t: I18nTranslate,
): string | undefined {
  if (scope === "workspace" && root === undefined) return t("settings.editor.noWorkspace");
  if (!definition.scopes.includes(scope)) return t("settings.editor.scopeUnavailable");
  if (setting.policyLocked) {
    return t("settings.editor.policyLocked", { reason: setting.reasonCode ?? "policy" });
  }
  if (definition.id === "externalReload") return t("settings.editor.followupExternalReload");
  return undefined;
}

function issueCopy(issue: "load" | "mutation" | "conflict", t: I18nTranslate): string {
  if (issue === "load") return t("settings.editor.loadError");
  if (issue === "conflict") return t("settings.editor.conflict");
  return t("settings.editor.mutationError");
}

function settingLabel(id: EditorM7SettingId, t: I18nTranslate): string {
  if (id === "fontSize") return t("settings.editor.setting.fontSize");
  if (id === "tabSize") return t("settings.editor.setting.tabSize");
  if (id === "insertSpaces") return t("settings.editor.setting.insertSpaces");
  if (id === "wordWrap") return t("settings.editor.setting.wordWrap");
  if (id === "renderWhitespace") return t("settings.editor.setting.renderWhitespace");
  if (id === "minimap") return t("settings.editor.setting.minimap");
  if (id === "formatOnSave") return t("settings.editor.setting.formatOnSave");
  if (id === "externalReload") return t("settings.editor.setting.externalReload");
  if (id === "inlineCompletion") return t("settings.editor.setting.inlineCompletion");
  if (id === "testGeneration") return t("settings.editor.setting.testGeneration");
  if (id === "patchApply") return t("settings.editor.setting.patchApply");
  if (id === "watcherExclusions") return t("settings.editor.setting.watcherExclusions");
  if (id === "largeFileMode") return t("settings.editor.setting.largeFileMode");
  if (id === "modelRetentionCount") return t("settings.editor.setting.modelRetentionCount");
  if (id === "modelRetentionBytes") return t("settings.editor.setting.modelRetentionBytes");
  return t("settings.editor.setting.keybindingOverrides");
}

function sourceLabel(source: EditorM7ResolvedSetting["source"], t: I18nTranslate): string {
  if (source === "workspace") return t("settings.editor.sourceWorkspace");
  if (source === "user") return t("settings.editor.sourceUser");
  return t("settings.editor.sourceBuiltInDefault");
}

function effectLabel(effect: EditorM7ResolvedSetting["effect"], t: I18nTranslate): string {
  return effect === "restart"
    ? t("settings.editor.effectRestart")
    : t("settings.editor.effectLive");
}
