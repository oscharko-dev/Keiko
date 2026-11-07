"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillMetadata,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { Icons } from "../Icons";
import { MarkdownEditor } from "../markdown-editor/MarkdownEditor";
import { splitMarkdownDocument } from "../markdown-editor/markdown-document";
import { JiraTemplateProposal, TemplateStatus, type JiraTemplates } from "./JiraTemplateTools";
import { MarkdownSkillAuthor } from "./MarkdownSkillAuthor";
import { templateKey } from "./useAutomaticTemplateChecks";
import { skillTextFits } from "./useMarkdownSkillAuthor";
import { downloadSkillMarkdown, type MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import { skillHeading, type SkillDocument, type SkillWorkspace } from "./useSkillWorkspace";
import styles from "./MarkdownSkillControl.module.css";

const PlusIcon = Icons.plus;
const SparkIcon = Icons.spark;
const EditorIcon = Icons.editor;
const DownloadIcon = Icons.download;
const TrashIcon = Icons.trash;

interface PaneProps {
  readonly library: MarkdownSkillLibrary;
  readonly skill: ChatMarkdownSkill;
  readonly jira: JiraTemplates;
  readonly workspace: SkillWorkspace;
  readonly disabled: boolean;
  readonly modelId: string | undefined;
}

/** The right two thirds: the open file in the shared Markdown editor, or a way to draft one. */
export function SkillWorkspacePane(props: PaneProps): ReactNode {
  const { workspace } = props;
  const view = workspace.view;
  return (
    <section className={styles.cmpWorkspace} aria-live="polite" aria-busy={props.library.busy}>
      {workspace.confirming ? <DiscardBar workspace={workspace} /> : null}
      {view.kind === "empty" ? <EmptyWorkspace workspace={workspace} /> : null}
      {view.kind === "author" ? (
        <MarkdownSkillAuthor
          key={props.modelId}
          modelId={props.modelId}
          onDraft={(text) => workspace.create(text, "skill.md")}
        />
      ) : null}
      {view.kind === "propose" ? (
        <JiraTemplateProposal
          jira={props.jira}
          onDraft={(text, fileName) => workspace.create(text, fileName)}
        />
      ) : null}
      {view.kind === "document" ? <DocumentEditor {...props} document={view.document} /> : null}
    </section>
  );
}

function DiscardBar({ workspace }: { readonly workspace: SkillWorkspace }): ReactNode {
  const t = useTranslate();
  return (
    <div role="alertdialog" aria-label={t("chat.skills.unsaved")} className={styles.cmpDiscard}>
      <span>{t("chat.skills.discardQuestion")}</span>
      <button type="button" onClick={workspace.keepEditing}>
        {t("chat.skills.keepEditing")}
      </button>
      <button type="button" className={styles.cmpDanger} onClick={workspace.discard}>
        {t("chat.skills.discard")}
      </button>
    </div>
  );
}

function EmptyWorkspace({ workspace }: { readonly workspace: SkillWorkspace }): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.cmpEmptyWorkspace}>
      <span className={styles.cmpEmptyIcon} aria-hidden="true">
        <EditorIcon size={26} />
      </span>
      <h3>{t("chat.skills.emptyTitle")}</h3>
      <p>{t("chat.skills.emptyText")}</p>
      <div className={styles.cmpInline}>
        <button
          type="button"
          className={styles.cmpPrimary}
          onClick={() => workspace.create(`# ${t("chat.skills.newName")}\n\n`, "skill.md")}
        >
          <PlusIcon size={16} />
          {t("chat.skills.new")}
        </button>
        <button type="button" onClick={() => workspace.show("author")}>
          <SparkIcon size={16} />
          {t("chat.skills.author.short")}
        </button>
      </div>
    </div>
  );
}

function isTemplate(document: SkillDocument, jira: JiraTemplates): boolean {
  const stored = document.stored;
  if (stored !== undefined && jira.templateIds?.has(stored.id) === true) return true;
  return splitMarkdownDocument(document.text).frontMatter !== undefined;
}

function DocumentEditor(props: PaneProps & { readonly document: SkillDocument }): ReactNode {
  const t = useTranslate();
  const { document, workspace } = props;
  const template = isTemplate(document, props.jira);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (workspace.canSave) workspace.save();
    }
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- ⌘S saves from anywhere in the open file
    <div className={styles.cmpDocument} onKeyDown={onKeyDown}>
      <DocumentHeader {...props} template={template} />
      {template && document.stored !== undefined ? (
        <OpenTemplateStatus jira={props.jira} id={document.stored.id} />
      ) : null}
      <div className={styles.cmpEditorFrame}>
        <MarkdownEditor
          documentKey={document.key}
          value={document.text}
          onChange={workspace.edit}
          ariaLabel={skillHeading(document.text) ?? t("chat.skills.untitled")}
          placeholder={t("chat.skills.editorPlaceholder")}
          maxLength={MARKDOWN_SKILL_LIMITS.importBytes}
          selectTitleOnOpen={document.stored === undefined}
        />
      </div>
      {skillTextFits(document.text) ? null : (
        <p role="alert" className={styles.cmpAlert}>
          {t("chat.skills.fileError")}
        </p>
      )}
    </div>
  );
}

function OpenTemplateStatus({
  jira,
  id,
}: {
  readonly jira: JiraTemplates;
  readonly id: string;
}): ReactNode {
  const entry = jira.tools.templates.find((item) => item.id === id);
  if (entry === undefined) return null;
  return (
    <div className={styles.cmpTemplateLine}>
      <TemplateStatus entry={entry} check={jira.tools.checks.get(templateKey(entry))} />
    </div>
  );
}

function DocumentMeta({
  document,
  template,
  dirty,
}: {
  readonly document: SkillDocument;
  readonly template: boolean;
  readonly dirty: boolean;
}): ReactNode {
  const t = useTranslate();
  return (
    <span className={styles.cmpMeta}>
      <span className={styles.cmpBadge} data-kind={template ? "template" : "skill"}>
        {t(template ? "chat.skills.kind.template" : "chat.skills.kind.skill")}
      </span>
      <span>
        {document.stored === undefined
          ? t("chat.skills.notSaved")
          : `v${String(document.stored.revision)}`}
      </span>
      {dirty ? <span className={styles.cmpDirty}>{t("chat.skills.unsaved")}</span> : null}
    </span>
  );
}

function DocumentHeader(
  props: PaneProps & { readonly document: SkillDocument; readonly template: boolean },
): ReactNode {
  const t = useTranslate();
  const { document, workspace } = props;
  return (
    <div className={styles.cmpDocumentHead}>
      <div className={styles.cmpTitle}>
        <h3>{skillHeading(document.text) ?? document.stored?.name ?? t("chat.skills.untitled")}</h3>
        <DocumentMeta document={document} template={props.template} dirty={workspace.dirty} />
      </div>
      <div className={styles.cmpInline}>
        <DocumentFileActions
          key={`${document.key}:${document.stored?.id ?? ""}:${String(document.stored?.revision ?? 0)}`}
          {...props}
        />
        <button
          type="button"
          className={styles.cmpPrimary}
          disabled={!workspace.canSave}
          title="⌘S"
          onClick={workspace.save}
        >
          {t("chat.skills.save")}
        </button>
      </div>
    </div>
  );
}

function DeleteConfirm({
  stored,
  library,
  onCancel,
}: {
  readonly stored: MarkdownSkillMetadata;
  readonly library: MarkdownSkillLibrary;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <span className={styles.cmpConfirm} role="group" aria-label={t("chat.skills.delete")}>
      <span>{t("chat.skills.deleteWarning")}</span>
      <button type="button" onClick={onCancel}>
        {t("chat.skills.cancel")}
      </button>
      <button
        type="button"
        className={styles.cmpDanger}
        disabled={library.busy}
        onClick={() => {
          void library.remove(stored);
        }}
      >
        {t("chat.skills.confirmDelete")}
      </button>
    </span>
  );
}

function DocumentFileActions({
  document,
  library,
  workspace,
}: PaneProps & { readonly document: SkillDocument }): ReactNode {
  const t = useTranslate();
  const [confirming, setConfirming] = useState(false);
  const stored = document.stored;
  if (confirming && stored !== undefined)
    return (
      <DeleteConfirm stored={stored} library={library} onCancel={() => setConfirming(false)} />
    );
  return (
    <>
      <button
        type="button"
        className={styles.cmpIconButton}
        aria-label={t("chat.skills.export")}
        title={t("chat.skills.export")}
        disabled={library.busy}
        onClick={() => {
          // What the person sees is what they download, saved or not.
          if (stored === undefined || workspace.dirty)
            downloadSkillMarkdown(document.text, document.fileName);
          else void library.download(stored);
        }}
      >
        <DownloadIcon size={17} />
      </button>
      {stored === undefined ? null : (
        <button
          type="button"
          className={styles.cmpIconButton}
          aria-label={t("chat.skills.delete")}
          title={t("chat.skills.delete")}
          onClick={() => setConfirming(true)}
        >
          <TrashIcon size={17} />
        </button>
      )}
    </>
  );
}
