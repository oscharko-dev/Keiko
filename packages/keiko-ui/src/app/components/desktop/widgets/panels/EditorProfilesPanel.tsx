"use client";

import { useMemo, useState, type ReactNode } from "react";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
  isAssignableWorkspaceProfileDisplayName,
  type EditorM11ProfileSummary,
  type EditorM11ProfilesSnapshot,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";
import { EditorProfilePortability } from "./EditorProfilePortability";

import styles from "./EditorSettingsPanel.module.css";

export function EditorProfilesPanel({
  root,
  view,
}: {
  readonly root: string | undefined;
  readonly view: EditorSettingsView;
}): ReactNode {
  const t = useTranslate();
  const snapshot = view.snapshot?.profiles;
  const [chosenRef, setChosenRef] = useState<WorkspaceProfileRef | undefined>();
  const [nameDraft, setNameDraft] = useState<string | undefined>();
  const selectedRef = selectedProfileRef(chosenRef, snapshot);
  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.profileRef === selectedRef),
    [selectedRef, snapshot],
  );
  const active = snapshot?.profiles.find(
    (profile) => profile.profileRef === snapshot.activeProfileRef,
  );
  const displayName = nameDraft ?? projectedDisplayName(selected);
  const validName = isAssignableWorkspaceProfileDisplayName(displayName);
  return (
    <section className={styles.section} aria-labelledby="editor-profiles-title">
      <header className={styles.header}>
        <h3 className={styles.title} id="editor-profiles-title">
          {t("settings.profiles.title")}
        </h3>
        <p className={styles.description}>{t("settings.profiles.description")}</p>
      </header>
      <output className={styles.profileCurrent} aria-live="polite">
        {t("settings.profiles.current", { name: active?.displayName ?? "Default" })}
      </output>
      {snapshot?.storeState === "unavailable" ? (
        <div className={styles.alert} role="alert">
          {t("settings.profiles.unavailable")}
        </div>
      ) : null}
      <div className={styles.toolbar}>
        <label className={styles.field}>
          {t("settings.profiles.profile")}
          <select
            className={styles.select}
            value={selectedRef}
            disabled={view.mutating || snapshot === undefined}
            onChange={(event) => {
              const next = snapshot?.profiles.find(
                (profile) => profile.profileRef === event.target.value,
              );
              if (next === undefined) return;
              setChosenRef(next.profileRef);
              setNameDraft(undefined);
            }}
          >
            {(snapshot?.profiles ?? []).map((profile) => (
              <option key={profile.profileRef} value={profile.profileRef}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {t("settings.profiles.name")}
          <input
            className={styles.input}
            value={displayName}
            maxLength={WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </label>
        <ProfileActions
          activeRef={snapshot?.activeProfileRef}
          disabled={view.mutating || snapshot === undefined}
          displayName={displayName}
          selected={selected}
          t={t}
          validName={validName}
          view={view}
        />
      </div>
      <EditorProfilePortability root={root} selected={selected} view={view} />
    </section>
  );
}

/**
 * The user's choice is authoritative once made, and it is derived — never copied into state by an
 * effect. An effect that re-seeded the selection from `activeProfileRef` made a background profile
 * switch (a second window, an import with "switch after import", any SSE refresh) silently move
 * the selection, and "Export selected profile" then wrote a different profile than the one the
 * user picked (#2618). The selection is surrendered on exactly one condition: the chosen profile
 * no longer exists, in which case there is nothing left to act on.
 */
function selectedProfileRef(
  chosen: WorkspaceProfileRef | undefined,
  snapshot: EditorM11ProfilesSnapshot | undefined,
): WorkspaceProfileRef {
  if (snapshot === undefined) return chosen ?? EDITOR_M11_DEFAULT_PROFILE_REF;
  const stillListed =
    chosen !== undefined && snapshot.profiles.some((profile) => profile.profileRef === chosen);
  return stillListed ? chosen : snapshot.activeProfileRef;
}

// The built-in profile cannot be renamed, so it seeds an empty field rather than the word "Default"
// — typing into it means creating or duplicating, never renaming the built-in.
function projectedDisplayName(selected: EditorM11ProfileSummary | undefined): string {
  return selected === undefined || selected.builtIn ? "" : selected.displayName;
}

function ProfileActions({
  activeRef,
  disabled,
  displayName,
  selected,
  t,
  validName,
  view,
}: {
  readonly activeRef: WorkspaceProfileRef | undefined;
  readonly disabled: boolean;
  readonly displayName: string;
  readonly selected: EditorM11ProfileSummary | undefined;
  readonly t: I18nTranslate;
  readonly validName: boolean;
  readonly view: EditorSettingsView;
}): ReactNode {
  return (
    <div className={styles.profileActions}>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || !validName}
        onClick={() => void view.createProfile(displayName)}
      >
        {t("settings.profiles.create")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || !validName || selected?.builtIn !== false}
        onClick={() => {
          if (selected !== undefined) void view.renameProfile(selected.profileRef, displayName);
        }}
      >
        {t("settings.profiles.rename")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || !validName || selected === undefined}
        onClick={() => {
          if (selected !== undefined) void view.duplicateProfile(selected.profileRef, displayName);
        }}
      >
        {t("settings.profiles.duplicate")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || selected === undefined || activeRef === selected.profileRef}
        onClick={() => {
          if (selected !== undefined) void view.switchProfile(selected.profileRef);
        }}
      >
        {t("settings.profiles.switch")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || selected?.builtIn !== false}
        onClick={() => {
          if (selected !== undefined) void view.resetProfile(selected.profileRef);
        }}
      >
        {t("settings.profiles.reset")}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || selected?.builtIn !== false}
        onClick={() => {
          if (selected !== undefined) void view.deleteProfile(selected.profileRef);
        }}
      >
        {t("settings.profiles.delete")}
      </button>
    </div>
  );
}
