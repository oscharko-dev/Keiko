"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  type EditorM11ProfileSummary,
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
  const [selectedRef, setSelectedRef] = useState<WorkspaceProfileRef>(
    EDITOR_M11_DEFAULT_PROFILE_REF,
  );
  const [displayName, setDisplayName] = useState("");
  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.profileRef === selectedRef),
    [selectedRef, snapshot],
  );
  const active = snapshot?.profiles.find(
    (profile) => profile.profileRef === snapshot.activeProfileRef,
  );

  useEffect(() => {
    if (snapshot === undefined) return;
    const current = snapshot.profiles.find(
      (profile) => profile.profileRef === snapshot.activeProfileRef,
    );
    setSelectedRef(snapshot.activeProfileRef);
    setDisplayName(current?.builtIn === true ? "" : (current?.displayName ?? ""));
    // Depend on the active profile ref, not the whole snapshot container: any
    // unrelated settings refresh (e.g. SSE `editor-settings:changed`) gives
    // `snapshot` a new reference and would otherwise reset the selection and
    // overwrite whatever the user was typing in the rename/duplicate field.
  }, [snapshot?.activeProfileRef]);

  const validName = displayName.trim().length > 0 && displayName.trim() === displayName;
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
              setSelectedRef(next.profileRef);
              setDisplayName(next.builtIn ? "" : next.displayName);
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
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
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
