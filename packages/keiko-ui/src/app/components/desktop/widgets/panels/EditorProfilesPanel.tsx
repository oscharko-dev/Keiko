"use client";

import { useMemo, useState, type ReactNode } from "react";

import {
  EDITOR_M11_DEFAULT_PROFILE_REF,
  WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
  isAssignableWorkspaceProfileDisplayName,
  isReservedWorkspaceProfileDisplayName,
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
  const [nameDraft, setNameDraft] = useState<NameDraft | undefined>();
  const selectedRef = selectedProfileRef(chosenRef, snapshot);
  const selected = useMemo(
    () => snapshot?.profiles.find((profile) => profile.profileRef === selectedRef),
    [selectedRef, snapshot],
  );
  const active = snapshot?.profiles.find(
    (profile) => profile.profileRef === snapshot.activeProfileRef,
  );
  // A draft belongs to the profile it was typed for. The selection can also move on its own — the
  // chosen profile gets deleted and the fallback takes over — and carrying the draft across that
  // would rename or duplicate a profile the text was never meant for.
  const isEditingName = nameDraft?.profileRef === selectedRef;
  const displayName = isEditingName ? nameDraft.text : projectedDisplayName(selected);
  const nameValidity = validateProfileDisplayName(displayName);
  // The alert is scoped to an ACTIVE edit, not the field's mere display value: the built-in
  // profile's field is deliberately seeded empty (see projectedDisplayName below), and an empty,
  // untouched field fails validation the same way a typed one would — showing "this name isn't
  // allowed" for a field nobody has typed into yet would be a false alarm on every fresh load.
  // Buttons still gate on `nameValidity.ok` unconditionally below (unchanged): only the visible
  // alert/aria-invalid/aria-describedby wait for the user to actually start editing.
  const showNameError = !nameValidity.ok && isEditingName;
  const nameErrorId = showNameError ? "editor-profile-name-error" : undefined;
  const profileOptions = snapshot?.profiles ?? [];
  return (
    <section className={styles.section} aria-labelledby="editor-profiles-title">
      <header className={styles.header}>
        <h3 className={styles.title} id="editor-profiles-title">
          {t("settings.profiles.title")}
        </h3>
        <p className={styles.description}>{t("settings.profiles.description")}</p>
      </header>
      <output className={styles.profileCurrent} aria-live="polite">
        {t("settings.profiles.current", {
          name: active?.displayName ?? t("settings.profiles.defaultName"),
        })}
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
            }}
          >
            {profileOptions.length === 0 ? (
              // No profile is loaded yet (snapshot === undefined, or an empty list): a
              // populated `value={selectedRef}` with zero <option> elements is an invalid
              // controlled-select state. This disabled placeholder keeps `value` matching a
              // real option until the real list arrives.
              <option value={selectedRef} disabled />
            ) : (
              profileOptions.map((profile) => (
                <option key={profile.profileRef} value={profile.profileRef}>
                  {profile.displayName}
                </option>
              ))
            )}
          </select>
        </label>
        <label className={styles.field}>
          {t("settings.profiles.name")}
          <input
            id="editor-profile-name"
            className={styles.input}
            value={displayName}
            maxLength={WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS}
            aria-invalid={showNameError}
            aria-describedby={nameErrorId}
            onChange={(event) =>
              setNameDraft({ profileRef: selectedRef, text: event.target.value })
            }
          />
        </label>
        {showNameError && !nameValidity.ok ? (
          <div className={styles.alert} role="alert" id={nameErrorId}>
            {profileNameErrorMessage(nameValidity.reason, t)}
          </div>
        ) : null}
        <ProfileActions
          activeRef={snapshot?.activeProfileRef}
          disabled={view.mutating || snapshot === undefined}
          displayName={displayName}
          selected={selected}
          t={t}
          validName={nameValidity.ok}
          view={view}
        />
      </div>
      <EditorProfilePortability root={root} selected={selected} view={view} />
    </section>
  );
}

interface NameDraft {
  readonly profileRef: WorkspaceProfileRef;
  readonly text: string;
}

type ProfileNameReasonCode = "reserved" | "invalid" | "tooLong";

type ProfileNameValidity =
  { readonly ok: true } | { readonly ok: false; readonly reason: ProfileNameReasonCode };

// KEIKO-0727: a bare boolean collapsed every rejection reason (reserved name, disallowed
// characters/padding, over the length cap) into the same silent "buttons stay disabled" signal,
// with no way for the user to tell which one applied. Order matters here: "reserved" is checked
// first since it is the most specific, actionable diagnosis; "tooLong" next since it is the most
// common way to fail the underlying isAssignableWorkspaceProfileDisplayName check; anything else
// that check rejects (empty, control characters, leading/trailing whitespace) falls to "invalid".
function validateProfileDisplayName(value: string): ProfileNameValidity {
  if (isReservedWorkspaceProfileDisplayName(value)) {
    return { ok: false, reason: "reserved" };
  }
  if (value.length > WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS) {
    return { ok: false, reason: "tooLong" };
  }
  if (!isAssignableWorkspaceProfileDisplayName(value)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}

function profileNameErrorMessage(reason: ProfileNameReasonCode, t: I18nTranslate): string {
  if (reason === "reserved") return t("settings.profiles.name.reserved");
  if (reason === "tooLong") {
    return t("settings.profiles.name.tooLong", {
      max: WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
    });
  }
  return t("settings.profiles.name.invalid");
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
