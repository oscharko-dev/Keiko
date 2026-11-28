"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  MCP_SETTINGS_IMPORT_MAX_BYTES,
  type McpSettingsImportIssue,
  type McpSettingsImportResponse,
  type McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { ApiError } from "@/lib/api";
import { bffFetchJson } from "@/lib/http";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useSettingsTranslate as useTranslate, type SettingsMessageKey } from "./settings-i18n";
import styles from "./McpSettingsPanel.module.css";

const EXAMPLE = JSON.stringify(
  {
    mcp: {
      "team-tools": { type: "remote", url: "https://example.test/mcp" },
    },
  },
  null,
  2,
);

const ISSUES: Record<McpSettingsImportIssue, SettingsMessageKey> = {
  syntax: "settings.mcp.importSyntax",
  "duplicate-key": "settings.mcp.importDuplicateKey",
  shape: "settings.mcp.importShape",
  empty: "settings.mcp.importEmpty",
  capacity: "settings.mcp.importCapacity",
  name: "settings.mcp.help.name",
  duplicate: "settings.mcp.importDuplicate",
  type: "settings.mcp.importType",
  options: "settings.mcp.importOptions",
  local: "settings.mcp.importLocal",
  remote: "settings.mcp.importRemote",
  credentials: "settings.mcp.importCredentials",
  size: "settings.mcp.importSize",
};

type Preview = Extract<McpSettingsImportResponse, { kind: "preview" }>;
type Invalid = Extract<McpSettingsImportResponse, { kind: "invalid" }>;
type Issue =
  | Invalid
  | { readonly kind: "conflict" }
  | { readonly kind: "file" }
  | { readonly kind: "fileSize" };
interface ImportProps {
  readonly path: string;
  readonly busy: boolean;
  readonly perform: (work: () => Promise<void>) => void;
  readonly onSaved: (snapshot: McpSettingsSnapshot, count: number) => void;
  readonly onCancel: () => void;
}

async function requestImport(
  path: string,
  text: string,
  revision: string | undefined,
): Promise<McpSettingsImportResponse | { readonly kind: "conflict" }> {
  try {
    return await bffFetchJson<McpSettingsImportResponse>(path, {
      method: "POST",
      body: JSON.stringify({ text, revision }),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "MCP_SETTINGS_CONFLICT") throw error;
    return { kind: "conflict" };
  }
}

async function readImportFile(
  file: File,
  putText: (value: string) => void,
  setIssue: (value: Issue) => void,
): Promise<void> {
  try {
    putText(await file.text());
  } catch {
    reportClientDiagnostic("mcp-settings-import-file-read-failed");
    setIssue({ kind: "file" });
  }
}

function useImportDraft({ path, perform, onSaved }: ImportProps): {
  text: string;
  preview: Preview | undefined;
  issue: Issue | undefined;
  putText: (value: string) => void;
  readFile: (input: HTMLInputElement) => void;
  review: () => void;
  edit: () => void;
} {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [issue, setIssue] = useState<Issue>();
  function putText(value: string): void {
    setText(value);
    setPreview(undefined);
    setIssue(
      new TextEncoder().encode(value).length > MCP_SETTINGS_IMPORT_MAX_BYTES
        ? { kind: "invalid", issue: "size" }
        : undefined,
    );
  }
  function readFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    setPreview(undefined);
    setIssue(undefined);
    if (file.size > MCP_SETTINGS_IMPORT_MAX_BYTES) {
      setIssue({ kind: "fileSize" });
      return;
    }
    perform(() => readImportFile(file, putText, setIssue));
  }

  function review(): void {
    setIssue(undefined);
    perform(async () => {
      const result = await requestImport(path, text, preview?.revision);
      if (result.kind === "saved") onSaved(result.snapshot, preview?.servers.length ?? 0);
      else if (result.kind === "preview") setPreview(result);
      else {
        setPreview(undefined);
        setIssue(result);
      }
    });
  }
  function edit(): void {
    setPreview(undefined);
    setIssue(undefined);
  }
  return { text, preview, issue, putText, readFile, review, edit };
}

function ImportError({ issue, id }: { readonly issue: Issue; readonly id: string }): ReactNode {
  const t = useTranslate();
  if (issue.kind === "conflict")
    return (
      <p id={id} role="alert">
        {t("settings.mcp.importConflict")}
      </p>
    );
  if (issue.kind === "fileSize")
    return (
      <p id={id} role="alert">
        {t("settings.mcp.importSize")}
      </p>
    );
  if (issue.kind === "file")
    return (
      <p id={id} role="alert">
        {t("settings.mcp.importFileFailed")}
      </p>
    );
  return (
    <p id={id} role="alert">
      {issue.entry === undefined
        ? t(ISSUES[issue.issue])
        : t("settings.mcp.importEntry", { entry: issue.entry, problem: t(ISSUES[issue.issue]) })}
    </p>
  );
}

function ImportPreview({ preview }: { readonly preview: Preview }): ReactNode {
  const t = useTranslate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className={styles.cmpImportPreview} aria-label={t("settings.mcp.importReview")}>
      <h4 ref={heading} tabIndex={-1}>
        {t("settings.mcp.importReview")}
      </h4>
      <p>{t("settings.mcp.importPaused")}</p>
      <ul>
        {preview.servers.map(({ name, kind }) => (
          <li key={name}>
            <strong>{name}</strong>
            <span>{t(kind === "local" ? "settings.mcp.local" : "settings.mcp.remote")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function McpSettingsImport(props: ImportProps): ReactNode {
  const t = useTranslate();
  const draft = useImportDraft(props);
  const id = useId();
  return (
    <form
      className={styles.cmpFormCard}
      onSubmit={(event) => {
        event.preventDefault();
        draft.review();
      }}
    >
      <fieldset disabled={props.busy} className={styles.cmpForm}>
        <legend>{t("settings.mcp.importTitle")}</legend>
        {draft.preview === undefined ? (
          <ImportEditor draft={draft} id={id} />
        ) : (
          <ImportPreview preview={draft.preview} />
        )}
        <div className={styles.cmpActions}>
          <button
            className={styles.cmpPrimary}
            type="submit"
            disabled={
              draft.text.trim() === "" ||
              (draft.issue?.kind === "invalid" && draft.issue.issue === "size")
            }
          >
            {t(
              draft.preview === undefined ? "settings.mcp.importCheck" : "settings.mcp.importSave",
            )}
          </button>
          {draft.preview !== undefined && (
            <button type="button" onClick={draft.edit}>
              {t("settings.mcp.importEdit")}
            </button>
          )}
          <button type="button" onClick={props.onCancel}>
            {t("settings.mcp.cancel")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function ImportEditor({
  draft,
  id,
}: {
  readonly draft: ReturnType<typeof useImportDraft>;
  readonly id: string;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <p id={`${id}-help`}>{t("settings.mcp.importHelp")}</p>
      <ImportTextInput {...draft} id={id} />
      {draft.issue !== undefined && <ImportError issue={draft.issue} id={`${id}-issue`} />}
    </>
  );
}

function ImportTextInput({
  id,
  text,
  issue,
  putText,
  readFile,
}: ReturnType<typeof useImportDraft> & { readonly id: string }): ReactNode {
  const t = useTranslate();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className={styles.cmpInputStack}>
      <label htmlFor={id} title={t("settings.mcp.importHelp")}>
        {t("settings.mcp.importText")}
      </label>
      <textarea
        className={styles.cmpJson}
        id={id}
        ref={input}
        rows={8}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={issue?.kind === "invalid"}
        aria-describedby={issue === undefined ? `${id}-help` : `${id}-help ${id}-issue`}
        value={text}
        onChange={(event) => putText(event.target.value)}
      />
      <div className={styles.cmpImportInputs}>
        <ImportFile id={id} readFile={readFile} />
        {text === "" && (
          <button
            type="button"
            onClick={() => {
              putText(EXAMPLE);
              input.current?.focus();
            }}
          >
            {t("settings.mcp.importExample")}
          </button>
        )}
      </div>
    </div>
  );
}

function ImportFile({
  id,
  readFile,
}: {
  readonly id: string;
  readonly readFile: (input: HTMLInputElement) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      <label title={t("settings.mcp.importFileHelp")}>
        {t("settings.mcp.importFile")}
        <input
          type="file"
          accept=".json,.jsonc,application/json"
          aria-describedby={`${id}-file-help`}
          onChange={(event) => readFile(event.currentTarget)}
        />
      </label>
      <p id={`${id}-file-help`}>{t("settings.mcp.importFileHelp")}</p>
    </>
  );
}
