"use client";

import { useMemo, useState, type ReactNode } from "react";

import {
  compileEditorM7SnippetBody,
  type EditorM7ReasonCode,
  type EditorM7WorkspaceSnippet,
  type EditorM7WorkspaceSnippetInput,
} from "@oscharko-dev/keiko-contracts";
import { useWorkspaceSnippets } from "../cards/useWorkspaceSnippets";
import { useSettingsTranslate as useTranslate, type I18nTranslate } from "./settings-i18n";

import styles from "./EditorSettingsPanel.module.css";

export function WorkspaceSnippetsPanel({
  root,
}: {
  readonly root?: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const view = useWorkspaceSnippets(root);
  const [draft, setDraft] = useState(defaultDraft());
  const [preview, setPreview] = useState<SnippetPreviewResult | undefined>();
  const snippets = view.snapshot?.snippets ?? [];
  const disabled = root === undefined || view.mutating;
  return (
    <section className={styles.section} aria-labelledby="workspace-snippets-title">
      <header className={styles.header}>
        <h3 className={styles.title} id="workspace-snippets-title">
          {t("settings.snippets.title")}
        </h3>
        <p className={styles.description}>{t("settings.snippets.description")}</p>
      </header>
      {root === undefined ? (
        <p className={styles.empty}>{t("settings.snippets.noWorkspace")}</p>
      ) : null}
      {view.issue === undefined ? null : (
        <div className={styles.alert} role="alert">
          {t("settings.snippets.issue", { issue: view.issue })}
        </div>
      )}
      <SnippetEditor
        disabled={disabled}
        draft={draft}
        preview={preview}
        t={t}
        onDraft={(next) => {
          // A preview computed for the previous body would otherwise keep showing stale,
          // possibly-invalid content (or a stale error) after the user keeps typing.
          if (next.body !== draft.body) setPreview(undefined);
          setDraft(next);
        }}
        onPreview={() => setPreview(previewDraft(draft))}
        onSave={() => {
          const next = [...snippets.map(snippetToInput), draftToInput(draft)];
          void view.replace(next).then((succeeded) => {
            if (!succeeded) return;
            setDraft(defaultDraft());
            setPreview(undefined);
          });
        }}
      />
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.button}
          disabled={disabled || snippets.length === 0}
          onClick={() => {
            void view.reset();
          }}
        >
          {t("settings.snippets.reset")}
        </button>
      </div>
      <SnippetList
        disabled={disabled}
        snippets={snippets}
        t={t}
        onDelete={(id) => {
          void view.replace(snippets.filter((snippet) => snippet.id !== id).map(snippetToInput));
        }}
      />
    </section>
  );
}

interface SnippetDraft {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly language: string;
  readonly include: string;
  readonly body: string;
}

function defaultDraft(): SnippetDraft {
  return {
    id: `snippet-${Date.now().toString(36)}`,
    name: "",
    prefix: "",
    language: "typescript",
    include: "src/**/*.ts",
    body: "const ${1:name} = ${2:value};\n$0",
  };
}

function SnippetEditor({
  disabled,
  draft,
  preview,
  t,
  onDraft,
  onPreview,
  onSave,
}: {
  readonly disabled: boolean;
  readonly draft: SnippetDraft;
  readonly preview: SnippetPreviewResult | undefined;
  readonly t: I18nTranslate;
  readonly onDraft: (draft: SnippetDraft) => void;
  readonly onPreview: () => void;
  readonly onSave: () => void;
}): ReactNode {
  // Gates Save on the CURRENT draft body's compile result, continuously — not only on whatever
  // the last Preview click happened to return — so a body already known locally to be invalid
  // cannot be sent even if the user edits it again after previewing (KEIKO-0619).
  const bodyCompileResult = compileEditorM7SnippetBody(draft.body.split(/\r?\n/u));
  const saveDisabled =
    disabled ||
    draft.name.trim().length === 0 ||
    draft.prefix.trim().length === 0 ||
    !bodyCompileResult.ok;
  return (
    <article className={styles.card}>
      <div className={styles.control}>
        <SnippetField
          label={t("settings.snippets.name")}
          value={draft.name}
          onChange={(name) => onDraft({ ...draft, name })}
        />
        <SnippetField
          label={t("settings.snippets.prefix")}
          value={draft.prefix}
          onChange={(prefix) => onDraft({ ...draft, prefix })}
        />
        <SnippetField
          label={t("settings.snippets.language")}
          value={draft.language}
          onChange={(language) => onDraft({ ...draft, language })}
        />
        <SnippetField
          label={t("settings.snippets.include")}
          value={draft.include}
          onChange={(include) => onDraft({ ...draft, include })}
        />
      </div>
      <label className={styles.field}>
        {t("settings.snippets.body")}
        <textarea
          className={styles.input}
          value={draft.body}
          rows={5}
          disabled={disabled}
          onChange={(event) => onDraft({ ...draft, body: event.target.value })}
        />
      </label>
      <div className={styles.control}>
        <button type="button" className={styles.button} disabled={disabled} onClick={onPreview}>
          {t("settings.snippets.preview")}
        </button>
        <button type="button" className={styles.button} disabled={saveDisabled} onClick={onSave}>
          {t("settings.snippets.save")}
        </button>
      </div>
      {preview === undefined ? null : preview.ok ? (
        <pre className={styles.meta}>{preview.preview}</pre>
      ) : (
        <div className={styles.alert} role="alert">
          {snippetPreviewErrorMessage(preview.reasonCode, t)}
        </div>
      )}
    </article>
  );
}

function SnippetField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className={styles.field}>
      {label}
      <input
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SnippetList({
  disabled,
  snippets,
  t,
  onDelete,
}: {
  readonly disabled: boolean;
  readonly snippets: readonly EditorM7WorkspaceSnippet[];
  readonly t: I18nTranslate;
  readonly onDelete: (id: string) => void;
}): ReactNode {
  const sorted = useMemo(
    () => [...snippets].sort((left, right) => left.name.localeCompare(right.name)),
    [snippets],
  );
  if (sorted.length === 0) return <p className={styles.empty}>{t("settings.snippets.empty")}</p>;
  return (
    <div className={styles.list}>
      {sorted.map((snippet) => (
        <article className={styles.card} key={snippet.id}>
          <div className={styles.cardHeader}>
            <div>
              <div className={styles.name}>{snippet.name}</div>
              <div className={styles.help}>
                {snippet.prefixes.join(", ")} · {snippet.languages.join(", ")} ·{" "}
                {t("settings.snippets.lines", { count: snippet.body.length })}
              </div>
            </div>
            <button
              type="button"
              className={styles.button}
              disabled={disabled}
              onClick={() => onDelete(snippet.id)}
            >
              {t("settings.snippets.delete")}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

type SnippetPreviewResult =
  | { readonly ok: true; readonly preview: string }
  | { readonly ok: false; readonly reasonCode: EditorM7ReasonCode };

function previewDraft(draft: SnippetDraft): SnippetPreviewResult {
  const compiled = compileEditorM7SnippetBody(draft.body.split(/\r?\n/u));
  return compiled.ok
    ? { ok: true, preview: compiled.value }
    : { ok: false, reasonCode: compiled.reasonCode };
}

// compileEditorM7SnippetBody only ever produces "UNSAFE_SNIPPET" today (its single ok:false
// return site), but EditorM7ParseResult<string>.reasonCode is typed to the full, shared
// EditorM7ReasonCode union. Every code this path can produce needs a translated message — never a
// silent fallback to the raw machine token — so unrecognized codes still resolve to a translated,
// generic message rather than leaking the reasonCode string itself.
function snippetPreviewErrorMessage(reasonCode: EditorM7ReasonCode, t: I18nTranslate): string {
  if (reasonCode === "UNSAFE_SNIPPET") return t("settings.snippets.previewUnsafe");
  return t("settings.snippets.previewFailed");
}

function draftToInput(draft: SnippetDraft): EditorM7WorkspaceSnippetInput {
  return {
    id: draft.id,
    name: draft.name.trim(),
    prefixes: [draft.prefix.trim()],
    description: draft.name.trim(),
    languages: [draft.language.trim()],
    include: draft.include.trim().length === 0 ? undefined : [draft.include.trim()],
    body: draft.body.split(/\r?\n/u),
  };
}

function snippetToInput(snippet: EditorM7WorkspaceSnippet): EditorM7WorkspaceSnippetInput {
  return {
    id: snippet.id,
    name: snippet.name,
    prefixes: snippet.prefixes,
    description: snippet.description,
    languages: snippet.languages,
    include: snippet.include,
    exclude: snippet.exclude,
    body: snippet.body,
  };
}
