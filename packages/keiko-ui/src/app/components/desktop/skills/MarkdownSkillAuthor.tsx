"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { Icons } from "../Icons";
import { useMarkdownSkillAuthor, type MarkdownSkillAuthorState } from "./useMarkdownSkillAuthor";
import styles from "./MarkdownSkillControl.module.css";

const FileIcon = Icons.file;

/**
 * Drafts a skill from a document or pasted text with the chat model. The draft opens in the
 * editor as a new, unsaved skill: the person reviews and saves it there.
 */
export function MarkdownSkillAuthor({
  modelId,
  onDraft,
}: {
  readonly modelId: string | undefined;
  readonly onDraft: (text: string) => void;
}): ReactNode {
  const t = useTranslate();
  const author = useMarkdownSkillAuthor(modelId);
  useDraftHandoff(author.draft, onDraft);
  return (
    <div className={styles.cmpForm}>
      <h3>{t("chat.skills.author.title")}</h3>
      <p>{t("chat.skills.author.description")}</p>
      <SkillSource author={author} />
      <div className={styles.cmpInline}>
        <button
          type="button"
          className={styles.cmpPrimary}
          disabled={author.busy || !modelId}
          onClick={() => {
            void author.generate();
          }}
        >
          {t(author.busy ? "chat.skills.author.generating" : "chat.skills.author.generate")}
        </button>
        {author.busy ? (
          <button type="button" onClick={author.cancel}>
            {t("chat.skills.cancel")}
          </button>
        ) : null}
      </div>
      {!modelId ? <p>{t("chat.skills.author.modelRequired")}</p> : null}
      {author.error ? (
        <p role="alert">
          {t(
            author.error === "source"
              ? "chat.skills.author.sourceError"
              : "chat.skills.author.generationError",
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Each generated draft is handed to the editor once per generation. */
function useDraftHandoff(draft: string | undefined, onDraft: (text: string) => void): void {
  const handed = useRef<string | undefined>(undefined);
  const latest = useRef(onDraft);
  latest.current = onDraft;
  useEffect(() => {
    if (draft === undefined) {
      // A new generation starts empty, so an identical draft from it is handed over again.
      handed.current = undefined;
      return;
    }
    if (draft === handed.current) return;
    handed.current = draft;
    latest.current(draft);
  }, [draft]);
}

function SkillSource({ author }: { readonly author: MarkdownSkillAuthorState }): ReactNode {
  const t = useTranslate();
  return (
    <>
      <label className={styles.cmpFilePicker} data-disabled={author.busy}>
        <FileIcon size={16} />
        <span>{t("chat.skills.author.file")}</span>
        <input
          type="file"
          className="visually-hidden"
          accept=".md,.txt,text/plain,text/markdown"
          disabled={author.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void author.load(file);
          }}
        />
      </label>
      <label className={styles.cmpField}>
        <span>{t("chat.skills.author.source")}</span>
        <textarea
          rows={12}
          value={author.source}
          disabled={author.busy}
          onChange={(event) => author.setSource(event.target.value)}
        />
      </label>
    </>
  );
}
