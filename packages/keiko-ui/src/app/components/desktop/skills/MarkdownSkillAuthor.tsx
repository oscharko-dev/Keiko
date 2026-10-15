"use client";

import { useState, type ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { SafeMarkdown } from "../SafeMarkdown";
import { downloadSkillMarkdown, type MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import {
  skillTextFits,
  useMarkdownSkillAuthor,
  type MarkdownSkillAuthorState,
} from "./useMarkdownSkillAuthor";
import styles from "./MarkdownSkillControl.module.css";

export function MarkdownSkillAuthor({
  modelId,
  library,
}: {
  readonly modelId: string | undefined;
  readonly library: MarkdownSkillLibrary;
}): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.cmpAuthor}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("chat.skills.author.title")}
      </button>
      {open ? <AuthorForm modelId={modelId} library={library} /> : null}
    </section>
  );
}

function AuthorForm({
  modelId,
  library,
}: {
  readonly modelId: string | undefined;
  readonly library: MarkdownSkillLibrary;
}): ReactNode {
  const t = useTranslate();
  const author = useMarkdownSkillAuthor(modelId);
  return (
    <>
      <p>{t("chat.skills.author.description")}</p>
      <SkillSource author={author} />
      <div className={styles.cmpActions}>
        <button
          type="button"
          disabled={author.busy || !modelId}
          onClick={() => {
            void author.generate();
          }}
        >
          {t("chat.skills.author.generate")}
        </button>
        {author.busy ? (
          <>
            <output>{t("chat.skills.author.generating")}</output>
            <button type="button" onClick={author.cancel}>
              {t("chat.skills.cancel")}
            </button>
          </>
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
      {author.draft !== undefined ? <SkillDraft author={author} library={library} /> : null}
    </>
  );
}

function SkillSource({ author }: { readonly author: MarkdownSkillAuthorState }): ReactNode {
  const t = useTranslate();
  return (
    <>
      <label className={styles.cmpFilePicker} data-disabled={author.busy}>
        {t("chat.skills.author.file")}
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
      <label className={styles.cmpUpload}>
        {t("chat.skills.author.source")}
        <textarea
          rows={6}
          value={author.source}
          disabled={author.busy}
          onChange={(event) => author.setSource(event.target.value)}
        />
      </label>
    </>
  );
}

function SkillDraft({
  author,
  library,
}: {
  readonly author: MarkdownSkillAuthorState;
  readonly library: MarkdownSkillLibrary;
}): ReactNode {
  const t = useTranslate();
  const draft = author.draft ?? "";
  const disabled = library.busy || !skillTextFits(draft);
  return (
    <section>
      <p>{t("chat.skills.author.review")}</p>
      <label className={styles.cmpUpload}>
        {t("chat.skills.author.draft")}
        <textarea
          rows={10}
          value={draft}
          onChange={(event) => author.setDraft(event.target.value)}
        />
      </label>
      <div className={styles.cmpMarkdown}>
        <SafeMarkdown source={draft} />
      </div>
      <div className={styles.cmpActions}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void library.upload(new File([draft], "skill.md", { type: "text/markdown" }));
          }}
        >
          {t("chat.skills.author.save")}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => downloadSkillMarkdown(draft, "skill.md")}
        >
          {t("chat.skills.export")}
        </button>
      </div>
    </section>
  );
}
