"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";

import type {
  EditorM11ProfileSummary,
  WorkspaceProfileExportResult,
  WorkspaceProfileImportPreview,
  WorkspaceProfileImportPreviewRow,
} from "@oscharko-dev/keiko-contracts";
import { EDITOR_M7_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import {
  ApiError,
  applyEditorProfileImport,
  exportEditorProfile,
  previewEditorProfileImport,
} from "../../../../../lib/api";
import type { EditorSettingsView } from "../cards/useEditorSettings";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";

import styles from "./EditorSettingsPanel.module.css";

const MAX_IMPORT_BYTES = 64 * 1024;

interface PortabilityState {
  readonly busy: boolean;
  readonly issue: "fileTooLarge" | "invalid" | "stale" | undefined;
  readonly notice: "exported" | "imported" | undefined;
  readonly redactionCount: number;
  readonly serialized: string | undefined;
  readonly preview: WorkspaceProfileImportPreview | undefined;
}

const INITIAL_STATE: PortabilityState = {
  busy: false,
  issue: undefined,
  notice: undefined,
  redactionCount: 0,
  serialized: undefined,
  preview: undefined,
};

function idempotencyKey(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `editor-profile-import-${Date.now().toString(36)}`;
}

function issueFrom(error: unknown): PortabilityState["issue"] {
  return error instanceof ApiError && error.code === "STALE_REVISION" ? "stale" : "invalid";
}

function downloadExport(result: WorkspaceProfileExportResult): void {
  const blob = new Blob([result.serializedManifest], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `keiko-${result.manifest.profileRef}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function EditorProfilePortability({
  root,
  selected,
  view,
}: {
  readonly root: string | undefined;
  readonly selected: EditorM11ProfileSummary | undefined;
  readonly view: EditorSettingsView;
}): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<PortabilityState>(INITIAL_STATE);
  const [switchAfterImport, setSwitchAfterImport] = useState(false);
  const disabled = state.busy || view.mutating || view.snapshot?.profiles === undefined;
  const actions = portabilityActions({ root, selected, setState, state, switchAfterImport, view });
  return (
    <section className={styles.portability} aria-labelledby="editor-profile-portability-title">
      <header className={styles.header}>
        <h4 className={styles.name} id="editor-profile-portability-title">
          {t("settings.profiles.portabilityTitle")}
        </h4>
        <p className={styles.description}>{t("settings.profiles.portabilityDescription")}</p>
      </header>
      <PortabilityControls
        disabled={disabled}
        switchAfterImport={switchAfterImport}
        t={t}
        onExport={actions.exportSelected}
        onFile={actions.previewFile}
        onSwitch={setSwitchAfterImport}
      />
      <PortabilityStatus state={state} t={t} />
      {state.preview === undefined ? null : (
        <ImportPreview
          disabled={disabled}
          preview={state.preview}
          t={t}
          onApply={actions.applyPreview}
        />
      )}
    </section>
  );
}

interface PortabilityActionInput {
  readonly root: string | undefined;
  readonly selected: EditorM11ProfileSummary | undefined;
  readonly setState: (state: PortabilityState) => void;
  readonly state: PortabilityState;
  readonly switchAfterImport: boolean;
  readonly view: EditorSettingsView;
}

function portabilityActions(input: PortabilityActionInput): {
  readonly exportSelected: () => Promise<void>;
  readonly previewFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly applyPreview: () => Promise<void>;
} {
  return {
    exportSelected: async (): Promise<void> => exportSelected(input),
    previewFile: async (event): Promise<void> => previewFile(input, event),
    applyPreview: async (): Promise<void> => applyPreview(input),
  };
}

async function exportSelected(input: PortabilityActionInput): Promise<void> {
  if (input.selected === undefined) return;
  input.setState({ ...INITIAL_STATE, busy: true });
  try {
    const result = await exportEditorProfile(input.selected.profileRef);
    downloadExport(result);
    input.setState({
      ...INITIAL_STATE,
      notice: "exported",
      redactionCount: result.redactions.reduce((count, row) => count + row.rejectedCount, 0),
    });
  } catch (error: unknown) {
    input.setState({ ...INITIAL_STATE, issue: issueFrom(error) });
  }
}

async function previewFile(
  input: PortabilityActionInput,
  event: ChangeEvent<HTMLInputElement>,
): Promise<void> {
  const file = event.target.files?.[0];
  const profiles = input.view.snapshot?.profiles;
  if (file === undefined || profiles === undefined) return;
  if (file.size > MAX_IMPORT_BYTES) {
    input.setState({ ...INITIAL_STATE, issue: "fileTooLarge" });
    return;
  }
  input.setState({ ...INITIAL_STATE, busy: true });
  try {
    const serialized = await file.text();
    const preview = await previewEditorProfileImport(serialized, profiles.etag);
    input.setState({ ...INITIAL_STATE, serialized, preview });
  } catch (error: unknown) {
    input.setState({ ...INITIAL_STATE, issue: issueFrom(error) });
  }
}

async function applyPreview(input: PortabilityActionInput): Promise<void> {
  const profiles = input.view.snapshot?.profiles;
  const { preview, serialized } = input.state;
  if (profiles === undefined || preview === undefined || serialized === undefined) return;
  input.setState({ ...input.state, busy: true, issue: undefined });
  try {
    const manifest = JSON.parse(serialized) as unknown;
    await applyEditorProfileImport(
      {
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        expectedRevision: preview.expectedRevision,
        manifest,
        previewDigest: preview.previewDigest,
        switchAfterImport: input.switchAfterImport,
        ...(input.root === undefined ? {} : { root: input.root }),
      },
      profiles.etag,
      idempotencyKey(),
    );
    await input.view.refresh();
    input.setState({ ...INITIAL_STATE, notice: "imported" });
  } catch (error: unknown) {
    input.setState({ ...input.state, busy: false, issue: issueFrom(error) });
  }
}

function PortabilityControls({
  disabled,
  switchAfterImport,
  t,
  onExport,
  onFile,
  onSwitch,
}: {
  readonly disabled: boolean;
  readonly switchAfterImport: boolean;
  readonly t: I18nTranslate;
  readonly onExport: () => Promise<void>;
  readonly onFile: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly onSwitch: (value: boolean) => void;
}): ReactNode {
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.button}
        disabled={disabled}
        onClick={() => void onExport()}
      >
        {t("settings.profiles.export")}
      </button>
      <label className={styles.field}>
        {t("settings.profiles.importFile")}
        <input
          className={styles.input}
          type="file"
          accept="application/json,.json"
          disabled={disabled}
          onChange={(event) => void onFile(event)}
        />
      </label>
      <label className={styles.checkboxField}>
        <input
          className={styles.checkbox}
          type="checkbox"
          checked={switchAfterImport}
          disabled={disabled}
          onChange={(event) => onSwitch(event.target.checked)}
        />
        {t("settings.profiles.switchAfterImport")}
      </label>
    </div>
  );
}

function PortabilityStatus({
  state,
  t,
}: {
  readonly state: PortabilityState;
  readonly t: I18nTranslate;
}): ReactNode {
  if (state.issue !== undefined) {
    return (
      <div className={styles.alert} role="alert">
        {t(`settings.profiles.${state.issue}`)}
      </div>
    );
  }
  if (state.notice === "imported") return <output>{t("settings.profiles.imported")}</output>;
  if (state.notice !== "exported") return null;
  return (
    <output>
      {state.redactionCount === 0
        ? t("settings.profiles.exported")
        : t("settings.profiles.exportedRedacted", { count: state.redactionCount })}
    </output>
  );
}

function ImportPreview({
  disabled,
  preview,
  t,
  onApply,
}: {
  readonly disabled: boolean;
  readonly preview: WorkspaceProfileImportPreview;
  readonly t: I18nTranslate;
  readonly onApply: () => Promise<void>;
}): ReactNode {
  return (
    <div className={styles.preview}>
      <p className={styles.meta}>
        {t("settings.profiles.proposedName", { name: preview.proposedDisplayName })}
      </p>
      <table className={styles.previewTable}>
        <thead>
          <tr>
            <th>{t("settings.profiles.setting")}</th>
            <th>{t("settings.profiles.disposition")}</th>
            <th>{t("settings.profiles.value")}</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => (
            <PreviewRow key={row.settingId} row={row} t={t} />
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className={styles.button}
        disabled={disabled}
        onClick={() => void onApply()}
      >
        {t("settings.profiles.applyImport")}
      </button>
    </div>
  );
}

function PreviewRow({
  row,
  t,
}: {
  readonly row: WorkspaceProfileImportPreviewRow;
  readonly t: I18nTranslate;
}): ReactNode {
  const detail = row.disposition === "rejected" ? row.reasonCode : JSON.stringify(row.value);
  return (
    <tr>
      <th scope="row">{row.settingId}</th>
      <td>{t(`settings.profiles.disposition.${row.disposition}`)}</td>
      <td>
        <code>{detail}</code>
      </td>
    </tr>
  );
}
