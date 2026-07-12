"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  EditorM7CommandDefinition,
  EditorM7ReasonCode,
  EditorM7SettingScope,
  EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";
import {
  bindingFromKeyboardEvent,
  detectKeyboardShortcutPlatform,
  removeKeyboardShortcutOverride,
  resolveEffectiveKeyboardShortcuts,
  shortcutLabel,
  updateKeyboardShortcutOverride,
  type EffectiveKeyboardShortcut,
} from "../../keyboardShortcutsRegistry";
import { settingById, type EditorSettingsView } from "../cards/useEditorSettings";
import {
  useSettingsTranslate as useTranslate,
  type I18nTranslate,
  type SettingsMessageKey,
} from "./settings-i18n";

import styles from "./EditorSettingsPanel.module.css";

export function KeyboardShortcutsPanel({
  root,
  scope,
  view,
}: {
  readonly root?: string | undefined;
  readonly scope: EditorM7SettingScope;
  readonly view: EditorSettingsView;
}): ReactNode {
  const t = useTranslate();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [issue, setIssue] = useState<EditorM7ReasonCode | undefined>();
  const raw = currentOverrideSetting(view);
  const registry = useMemo(() => resolveEffectiveKeyboardShortcuts(raw), [raw]);
  const rows = useMemo(
    () => filteredShortcutRows(registry.commands, query, modifiedOnly, t),
    [modifiedOnly, query, registry.commands, t],
  );
  const disabled = view.mutating || (scope === "workspace" && root === undefined);
  const restoreFocus = (commandId: string): void => {
    requestAnimationFrame(() => buttonRefs.current.get(commandId)?.focus());
  };
  return (
    <section className={styles.section} aria-labelledby="keyboard-shortcuts-title">
      <ShortcutHeader status={registry.status} t={t} />
      <ShortcutToolbar
        disabled={disabled}
        modifiedOnly={modifiedOnly}
        query={query}
        t={t}
        onModifiedOnly={setModifiedOnly}
        onQuery={setQuery}
        onReset={() => {
          void view.reset(scope, ["keybindingOverrides"]);
        }}
      />
      <output className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {recordingId === null ? "" : t("settings.keyboard.recordingLive")}
        {issue === undefined ? "" : reasonLabel(issue, t)}
      </output>
      {issue === undefined ? null : (
        <div className={styles.alert} role="alert">
          {reasonLabel(issue, t)}
        </div>
      )}
      <div className={styles.list}>
        {rows.map((entry) => (
          <ShortcutRow
            key={entry.command.id}
            disabled={disabled}
            entry={entry}
            recording={recordingId === entry.command.id}
            setButtonRef={(node) => setButtonRef(buttonRefs.current, entry.command.id, node)}
            t={t}
            onCancel={() => {
              setRecordingId(null);
              restoreFocus(entry.command.id);
            }}
            onCapture={(event) => {
              handleCapture({
                commandId: entry.command.id,
                current: raw,
                event,
                scope,
                setIssue,
                setRecordingId,
                view,
              });
              restoreFocus(entry.command.id);
            }}
            onRecord={() => {
              setIssue(undefined);
              setRecordingId(entry.command.id);
            }}
            onRemove={() => {
              void view.setValue(
                scope,
                "keybindingOverrides",
                removeKeyboardShortcutOverride(raw, entry.command.id),
              );
            }}
          />
        ))}
      </div>
    </section>
  );
}

function currentOverrideSetting(view: EditorSettingsView): EditorM7SettingValue | undefined {
  return (
    settingById(view.snapshot, "keybindingOverrides")?.value ?? view.applied.keybindingOverrides
  );
}

function setButtonRef(
  refs: Map<string, HTMLButtonElement>,
  commandId: string,
  node: HTMLButtonElement | null,
): void {
  if (node === null) refs.delete(commandId);
  else refs.set(commandId, node);
}

function ShortcutHeader({
  status,
  t,
}: {
  readonly status: ReturnType<typeof resolveEffectiveKeyboardShortcuts>["status"];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <header className={styles.header}>
      <h3 className={styles.title} id="keyboard-shortcuts-title">
        {t("settings.keyboard.title")}
      </h3>
      <p className={styles.description}>{t("settings.keyboard.description")}</p>
      {status.kind === "fallback" ? (
        <div className={styles.alert} role="status">
          {t("settings.keyboard.fallback", { reason: status.reasonCode ?? "invalid" })}
        </div>
      ) : null}
    </header>
  );
}

function ShortcutToolbar({
  disabled,
  modifiedOnly,
  query,
  t,
  onModifiedOnly,
  onQuery,
  onReset,
}: {
  readonly disabled: boolean;
  readonly modifiedOnly: boolean;
  readonly query: string;
  readonly t: I18nTranslate;
  readonly onModifiedOnly: (value: boolean) => void;
  readonly onQuery: (value: string) => void;
  readonly onReset: () => void;
}): ReactNode {
  return (
    <div className={styles.toolbar}>
      <label className={styles.field}>
        {t("settings.keyboard.search")}
        <input
          className={styles.input}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <label className={styles.checkboxField}>
        <input
          className={styles.checkbox}
          type="checkbox"
          checked={modifiedOnly}
          onChange={(event) => onModifiedOnly(event.target.checked)}
        />
        {t("settings.keyboard.modifiedOnly")}
      </label>
      <button type="button" className={styles.button} disabled={disabled} onClick={onReset}>
        {t("settings.keyboard.resetAll")}
      </button>
    </div>
  );
}

function ShortcutRow({
  disabled,
  entry,
  recording,
  setButtonRef,
  t,
  onCancel,
  onCapture,
  onRecord,
  onRemove,
}: {
  readonly disabled: boolean;
  readonly entry: EffectiveKeyboardShortcut;
  readonly recording: boolean;
  readonly setButtonRef: (node: HTMLButtonElement | null) => void;
  readonly t: I18nTranslate;
  readonly onCancel: () => void;
  readonly onCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onRecord: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const platform = detectKeyboardShortcutPlatform();
  return (
    <article className={styles.card} aria-labelledby={`shortcut-${entry.command.id}`}>
      <div className={styles.cardHeader}>
        <ShortcutSummary entry={entry} platform={platform} t={t} />
        <ShortcutActions
          disabled={disabled}
          entry={entry}
          recording={recording}
          setButtonRef={setButtonRef}
          t={t}
          onCancel={onCancel}
          onCapture={onCapture}
          onRecord={onRecord}
          onRemove={onRemove}
        />
      </div>
      <ShortcutDiagnostics entry={entry} t={t} />
    </article>
  );
}

function ShortcutSummary({
  entry,
  platform,
  t,
}: {
  readonly entry: EffectiveKeyboardShortcut;
  readonly platform: ReturnType<typeof detectKeyboardShortcutPlatform>;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div>
      <div className={styles.name} id={`shortcut-${entry.command.id}`}>
        {commandLabel(entry.command, t)}
      </div>
      <div className={styles.help}>{commandDescription(entry.command, t)}</div>
      <div className={styles.meta}>
        <kbd className={styles.kbd}>{shortcutLabel(entry.binding, platform)}</kbd>
        {" · "}
        {scopeLabel(entry.command, t)}
        {" · "}
        {entry.source === "user"
          ? t("settings.keyboard.sourceUser")
          : t("settings.keyboard.sourceDefault")}
      </div>
    </div>
  );
}

function ShortcutActions({
  disabled,
  entry,
  recording,
  setButtonRef,
  t,
  onCancel,
  onCapture,
  onRecord,
  onRemove,
}: {
  readonly disabled: boolean;
  readonly entry: EffectiveKeyboardShortcut;
  readonly recording: boolean;
  readonly setButtonRef: (node: HTMLButtonElement | null) => void;
  readonly t: I18nTranslate;
  readonly onCancel: () => void;
  readonly onCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onRecord: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  if (recording) {
    return (
      <div className={styles.control}>
        <button type="button" className={styles.button} onKeyDown={onCapture}>
          {t("settings.keyboard.pressShortcut")}
        </button>
        <button type="button" className={styles.button} onClick={onCancel}>
          {t("settings.keyboard.cancel")}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.control}>
      <button
        ref={setButtonRef}
        type="button"
        className={styles.button}
        disabled={disabled || !entry.command.rebindable}
        onClick={onRecord}
      >
        {entry.command.rebindable
          ? t("settings.keyboard.record")
          : t("settings.keyboard.protected")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || !entry.modified}
        onClick={onRemove}
      >
        {t("settings.keyboard.remove")}
      </button>
    </div>
  );
}

function ShortcutDiagnostics({
  entry,
  t,
}: {
  readonly entry: EffectiveKeyboardShortcut;
  readonly t: I18nTranslate;
}): ReactNode {
  if (entry.conflictCommandIds.length === 0) {
    return (
      <div className={styles.badges}>
        <span className={styles.badge}>{entry.command.dispatchOwner}</span>
        <span className={styles.badge}>{entry.command.contexts.join(", ")}</span>
      </div>
    );
  }
  return (
    <div className={styles.alert} role="status">
      {t("settings.keyboard.conflict", { commands: entry.conflictCommandIds.join(", ") })}
    </div>
  );
}

function handleCapture(args: {
  readonly commandId: string;
  readonly current: EditorM7SettingValue | undefined;
  readonly event: KeyboardEvent<HTMLButtonElement>;
  readonly scope: EditorM7SettingScope;
  readonly setIssue: (issue: EditorM7ReasonCode | undefined) => void;
  readonly setRecordingId: (id: string | null) => void;
  readonly view: EditorSettingsView;
}): void {
  args.event.preventDefault();
  args.event.stopPropagation();
  const binding = bindingFromKeyboardEvent(args.event.nativeEvent);
  if (binding === null) {
    args.setIssue("INVALID_INPUT");
    return;
  }
  const next = updateKeyboardShortcutOverride({
    current: args.current,
    commandId: args.commandId,
    binding,
  });
  if (!next.ok) {
    args.setIssue(next.reasonCode);
    return;
  }
  args.setIssue(undefined);
  args.setRecordingId(null);
  void args.view.setValue(args.scope, "keybindingOverrides", next.value);
}

function filteredShortcutRows(
  entries: readonly EffectiveKeyboardShortcut[],
  query: string,
  modifiedOnly: boolean,
  t: I18nTranslate,
): readonly EffectiveKeyboardShortcut[] {
  const normalized = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (modifiedOnly && !entry.modified) return false;
    const haystack = `${commandLabel(entry.command, t)} ${commandDescription(entry.command, t)} ${
      entry.command.id
    }`.toLowerCase();
    return normalized.length === 0 || haystack.includes(normalized);
  });
}

function commandLabel(command: EditorM7CommandDefinition, t: I18nTranslate): string {
  return t(command.labelKey as SettingsMessageKey);
}

function commandDescription(command: EditorM7CommandDefinition, t: I18nTranslate): string {
  return t(command.descriptionKey as SettingsMessageKey);
}

function scopeLabel(command: EditorM7CommandDefinition, t: I18nTranslate): string {
  if (command.scope === "editor") return t("settings.keyboard.scopeEditor");
  if (command.scope === "settings") return t("settings.keyboard.scopeSettings");
  if (command.scope === "explorer") return t("settings.keyboard.scopeExplorer");
  if (command.scope === "git") return t("settings.keyboard.scopeGit");
  return t("settings.keyboard.scopeGlobal");
}

function reasonLabel(reason: EditorM7ReasonCode, t: I18nTranslate): string {
  return t("settings.keyboard.reason", { reason });
}
