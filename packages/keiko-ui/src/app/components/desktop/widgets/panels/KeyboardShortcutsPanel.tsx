"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  EditorM7CommandDefinition,
  EditorM7ReasonCode,
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
import { projectShellShortcutRefusals } from "../../shellShortcutState";
import {
  settingById,
  type EditorSettingsEditScope,
  type EditorSettingsView,
} from "../cards/useEditorSettings";
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
  readonly scope: EditorSettingsEditScope;
  readonly view: EditorSettingsView;
}): ReactNode {
  const t = useTranslate();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [issue, setIssue] = useState<EditorM7ReasonCode | undefined>();
  const raw = resolvedOverrideSetting(view);
  const layer = scopeOverrideSetting(view, scope);
  const registry = useMemo(() => resolveEffectiveKeyboardShortcuts(raw), [raw]);
  const refusalByCommand = useMemo(
    () => shortcutRefusalByCommand(projectShellShortcutRefusals(registry)),
    [registry],
  );
  const layerOverrides = useMemo((): ReadonlySet<string> => overriddenCommandIds(layer), [layer]);
  const rows = useMemo(
    () => filteredShortcutRows(registry.commands, query, modifiedOnly, t),
    [modifiedOnly, query, registry.commands, t],
  );
  const disabled =
    view.mutating || ((scope === "workspace" || scope === "root") && root === undefined);
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
            refusalReason={refusalByCommand.get(entry.command.id)}
            recording={recordingId === entry.command.id}
            removable={layerOverrides.has(entry.command.id)}
            setButtonRef={(node) => setButtonRef(buttonRefs.current, entry.command.id, node)}
            t={t}
            onCancel={() => {
              setRecordingId(null);
              restoreFocus(entry.command.id);
            }}
            onCapture={(event) => {
              handleCapture({
                commandId: entry.command.id,
                current: layer,
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
                removeKeyboardShortcutOverride(layer, entry.command.id),
              );
            }}
          />
        ))}
      </div>
    </section>
  );
}

// What the user SEES: the binding actually in effect, whichever layer won it.
function resolvedOverrideSetting(view: EditorSettingsView): EditorM7SettingValue | undefined {
  return (
    settingById(view.snapshot, "keybindingOverrides")?.value ?? view.applied.keybindingOverrides
  );
}

/**
 * What an edit REWRITES: the overrides the edited scope holds in its own right. Composing the next
 * list from the resolved view copied whatever layer happened to win into the layer being written —
 * a profile edit absorbed the user/workspace/root list and carried it to another machine on export
 * (#2618). `undefined` means the scope holds no overrides yet, so the edit starts from empty.
 */
function scopeOverrideSetting(
  view: EditorSettingsView,
  scope: EditorSettingsEditScope,
): EditorM7SettingValue | undefined {
  return settingById(view.snapshot, "keybindingOverrides")?.layers[scope];
}

// Remove clears the edited scope's own override, so it is offered only where one exists to clear —
// a row overridden by a different layer stays untouched by an edit at this scope.
function overriddenCommandIds(value: EditorM7SettingValue | undefined): ReadonlySet<string> {
  const scoped = resolveEffectiveKeyboardShortcuts(value);
  return new Set(
    scoped.commands.filter((entry) => entry.modified).map((entry) => entry.command.id),
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
        <output className={styles.alert}>
          {t("settings.keyboard.fallback", { reason: status.reasonCode ?? "invalid" })}
        </output>
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
  refusalReason,
  recording,
  removable,
  setButtonRef,
  t,
  onCancel,
  onCapture,
  onRecord,
  onRemove,
}: {
  readonly disabled: boolean;
  readonly entry: EffectiveKeyboardShortcut;
  readonly refusalReason: EditorM7ReasonCode | undefined;
  readonly recording: boolean;
  readonly removable: boolean;
  readonly setButtonRef: (node: HTMLButtonElement | null) => void;
  readonly t: I18nTranslate;
  readonly onCancel: () => void;
  readonly onCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onRecord: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const platform = detectKeyboardShortcutPlatform();
  const refusalId =
    refusalReason === undefined ? undefined : `shortcut-${entry.command.id}-refusal`;
  return (
    <article
      className={styles.card}
      aria-labelledby={`shortcut-${entry.command.id}`}
      aria-describedby={refusalId}
    >
      <div className={styles.cardHeader}>
        <ShortcutSummary entry={entry} platform={platform} t={t} />
        <ShortcutActions
          disabled={disabled}
          entry={entry}
          recording={recording}
          removable={removable}
          setButtonRef={setButtonRef}
          t={t}
          onCancel={onCancel}
          onCapture={onCapture}
          onRecord={onRecord}
          onRemove={onRemove}
        />
      </div>
      <ShortcutDiagnostics
        entry={entry}
        refusalId={refusalId}
        refusalReason={refusalReason}
        t={t}
      />
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
  removable,
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
  readonly removable: boolean;
  readonly setButtonRef: (node: HTMLButtonElement | null) => void;
  readonly t: I18nTranslate;
  readonly onCancel: () => void;
  readonly onCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onRecord: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  if (recording) {
    return <RecordingControls t={t} onCancel={onCancel} onCapture={onCapture} />;
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
        disabled={disabled || !removable}
        onClick={onRemove}
      >
        {t("settings.keyboard.remove")}
      </button>
    </div>
  );
}

// Own component so its mount effect fires once when recording starts and never again on
// unrelated re-renders of the row (KEIKO-0472). Safari does not focus a <button> on click, so
// relying on ambient click-to-focus loses the keystroke on that platform.
function RecordingControls({
  t,
  onCancel,
  onCapture,
}: {
  readonly t: I18nTranslate;
  readonly onCancel: () => void;
  readonly onCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const pressButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const handle = requestAnimationFrame(() => pressButtonRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, []);
  return (
    <div className={styles.control}>
      <button
        ref={pressButtonRef}
        type="button"
        className={styles.button}
        onKeyDown={onCapture}
      >
        {t("settings.keyboard.pressShortcut")}
      </button>
      <button type="button" className={styles.button} onClick={onCancel}>
        {t("settings.keyboard.cancel")}
      </button>
    </div>
  );
}

function ShortcutDiagnostics({
  entry,
  refusalId,
  refusalReason,
  t,
}: {
  readonly entry: EffectiveKeyboardShortcut;
  readonly refusalId: string | undefined;
  readonly refusalReason: EditorM7ReasonCode | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <>
      {refusalReason === undefined ? null : (
        <output className={styles.alert} id={refusalId}>
          {shortcutRefusalLabel(refusalReason, t)}
        </output>
      )}
      {entry.conflictCommandIds.length === 0 ? (
        <div className={styles.badges}>
          <span className={styles.badge}>{entry.command.dispatchOwner}</span>
          <span className={styles.badge}>{entry.command.contexts.join(", ")}</span>
        </div>
      ) : (
        <output className={styles.alert}>
          {t("settings.keyboard.conflict", { commands: entry.conflictCommandIds.join(", ") })}
        </output>
      )}
    </>
  );
}

function shortcutRefusalByCommand(
  refusals: ReturnType<typeof projectShellShortcutRefusals>,
): ReadonlyMap<string, EditorM7ReasonCode> {
  return new Map(refusals.map((refusal) => [refusal.commandId, refusal.reasonCode]));
}

function shortcutRefusalLabel(reason: EditorM7ReasonCode, t: I18nTranslate): string {
  if (reason === "RESERVED_KEYBINDING") return t("settings.keyboard.refusal.reserved");
  if (reason === "KEYBINDING_COLLISION") return t("settings.keyboard.refusal.collision");
  return t("settings.keyboard.refusal.invalid");
}

function handleCapture(args: {
  readonly commandId: string;
  readonly current: EditorM7SettingValue | undefined;
  readonly event: KeyboardEvent<HTMLButtonElement>;
  readonly scope: EditorSettingsEditScope;
  readonly setIssue: (issue: EditorM7ReasonCode | undefined) => void;
  readonly setRecordingId: (id: string | null) => void;
  readonly view: EditorSettingsView;
}): void {
  args.event.preventDefault();
  args.event.stopPropagation();
  // Escape must cancel recording; capturing it as an 'Esc' override would trap the panel-wide
  // Escape-to-close affordance behind whatever the last user pressed while a row was live (#2894).
  if (args.event.key === "Escape") {
    args.setRecordingId(null);
    return;
  }
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
