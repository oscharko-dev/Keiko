"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { EDITOR_M11_DEFAULT_PROFILE_REF } from "@oscharko-dev/keiko-contracts";
import type {
  EditorM7AiActivationStatus,
  EditorM7SettingDefinition,
  EditorM7SettingId,
  EditorM7SettingValue,
  EditorM11ResolvedSetting,
} from "@oscharko-dev/keiko-contracts";
import { useEditorSettings, type EditorSettingsEditScope } from "../cards/useEditorSettings";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel";
import { WorkspaceSnippetsPanel } from "./WorkspaceSnippetsPanel";
import { EditorProfilesPanel } from "./EditorProfilesPanel";

import styles from "./EditorSettingsPanel.module.css";

export function EditorSettingsPanel({ root }: { readonly root?: string | undefined }): ReactNode {
  const t = useTranslate();
  const view = useEditorSettings(root);
  const [scope, setScope] = useState<EditorSettingsEditScope>("user");
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
  const activeProfile = view.snapshot?.profiles?.activeProfileRef;
  useEffect(() => {
    if (scope === "profile" && activeProfile === EDITOR_M11_DEFAULT_PROFILE_REF) setScope("user");
  }, [activeProfile, scope]);
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
            onChange={(event) => setScope(event.target.value as EditorSettingsEditScope)}
          >
            <option value="user">{t("settings.editor.scopeUser")}</option>
            <option value="workspace" disabled={root === undefined}>
              {t("settings.editor.scopeWorkspace")}
            </option>
            <option value="root" disabled={root === undefined}>
              {t("settings.editor.scopeRoot")}
            </option>
            <option
              value="profile"
              disabled={
                activeProfile === undefined || activeProfile === EDITOR_M11_DEFAULT_PROFILE_REF
              }
            >
              {t("settings.editor.scopeProfile")}
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
      {requiresRoot(scope) && root === undefined ? (
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
      <EditorProfilesPanel root={root} view={view} />
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
  readonly setting: EditorM11ResolvedSetting;
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
  settings: readonly EditorM11ResolvedSetting[],
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
  readonly scope: EditorSettingsEditScope;
  readonly setting: EditorM11ResolvedSetting;
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
              {aiStatusLabel(aiStatus, t)}
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
          disabled={disabled || !settingSupportsScope(definition, scope)}
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
  readonly setting: EditorM11ResolvedSetting;
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

/**
 * F-01: this badge is the operator's readout of whether AI assistance is actually live. The
 * unverified reason gets a sentence rather than the raw `PROVIDER_UNVERIFIED` code, because "no
 * readiness check has confirmed the gateway" is an actionable condition and the operator has to be
 * able to tell it apart from a provider that answered and failed.
 */
function aiStatusLabel(status: EditorM7AiActivationStatus, t: I18nTranslate): string {
  if (status.reasonCode === "PROVIDER_UNVERIFIED") {
    return t("settings.editor.aiStatusUnverified");
  }
  return t("settings.editor.aiStatus", { state: status.state, reason: status.reasonCode });
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
  useDialogTabTrap(dialogRef);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onDecline();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDecline]);
  return (
    <div className={styles.confirmBackdrop}>
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
  setting: EditorM11ResolvedSetting,
  scope: EditorSettingsEditScope,
  root: string | undefined,
  t: I18nTranslate,
): string | undefined {
  if (requiresRoot(scope) && root === undefined) return t("settings.editor.noWorkspace");
  if (!settingSupportsScope(definition, scope)) return t("settings.editor.scopeUnavailable");
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
  if (id === "gitCommitMessagePolicy") {
    return t("settings.editor.setting.gitCommitMessagePolicy");
  }
  return t("settings.editor.setting.keybindingOverrides");
}

function settingSupportsScope(
  definition: EditorM7SettingDefinition,
  scope: EditorSettingsEditScope,
): boolean {
  if (scope === "root") return definition.scopes.includes("workspace");
  if (scope === "profile") return definition.scopes.includes("user");
  return definition.scopes.includes(scope);
}

function requiresRoot(scope: EditorSettingsEditScope): boolean {
  return scope === "workspace" || scope === "root";
}

function sourceLabel(source: EditorM11ResolvedSetting["source"], t: I18nTranslate): string {
  if (source === "root") return t("settings.editor.sourceRoot");
  if (source === "workspace") return t("settings.editor.sourceWorkspace");
  if (source === "user") return t("settings.editor.sourceUser");
  if (source === "profile") return t("settings.editor.sourceProfile");
  return t("settings.editor.sourceBuiltInDefault");
}

function effectLabel(effect: EditorM11ResolvedSetting["effect"], t: I18nTranslate): string {
  return effect === "restart"
    ? t("settings.editor.effectRestart")
    : t("settings.editor.effectLive");
}
