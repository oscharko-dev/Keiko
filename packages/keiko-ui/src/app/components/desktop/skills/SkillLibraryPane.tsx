"use client";

import { useId, type ReactNode } from "react";
import type { MarkdownSkillMetadata } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { Icons } from "../Icons";
import { JiraTemplateList, PodSelect, type JiraTemplates } from "./JiraTemplateTools";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import type { SkillWorkspace } from "./useSkillWorkspace";
import styles from "./MarkdownSkillControl.module.css";

const PlusIcon = Icons.plus;
const SparkIcon = Icons.spark;
const FileIcon = Icons.file;

interface PaneProps {
  readonly library: MarkdownSkillLibrary;
  readonly skill: ChatMarkdownSkill;
  readonly jira: JiraTemplates;
  readonly workspace: SkillWorkspace;
}

function openSkillId(workspace: SkillWorkspace): string | undefined {
  return workspace.view.kind === "document" ? workspace.view.document.stored?.id : undefined;
}

/** The left third: everything stored, and the ways to start a new file. */
export function SkillLibraryPane({ library, skill, jira, workspace }: PaneProps): ReactNode {
  const t = useTranslate();
  const templateIds = jira.templateIds;
  // Until the template list is read every skill shows as a chat skill; templates then move.
  const chatSkills =
    templateIds === undefined
      ? library.skills
      : library.skills.filter((item) => !templateIds.has(item.id));
  const openId = openSkillId(workspace);
  return (
    <aside className={styles.cmpLibrary} aria-label={t("chat.skills.library")}>
      <LibraryActions library={library} workspace={workspace} />
      <LibraryStatus library={library} skill={skill} />
      <div className={styles.cmpGroups}>
        <LibraryGroup title={t("chat.skills.chat.title")} count={chatSkills.length}>
          {chatSkills.length === 0 && library.available ? (
            <p className={styles.cmpEmpty}>{t("chat.skills.empty")}</p>
          ) : (
            <ul className={styles.cmpItems}>
              {chatSkills.map((item) => (
                <ChatSkillItem
                  key={item.id}
                  item={item}
                  skill={skill}
                  open={openId === item.id}
                  onOpen={() => workspace.guard(() => workspace.open(item))}
                />
              ))}
            </ul>
          )}
        </LibraryGroup>
        <TemplateGroup library={library} jira={jira} workspace={workspace} openId={openId} />
      </div>
      <p className={styles.cmpFootnote}>{t("chat.skills.protected")}</p>
    </aside>
  );
}

function TemplateGroup({
  library,
  jira,
  workspace,
  openId,
}: Omit<PaneProps, "skill"> & { readonly openId: string | undefined }): ReactNode {
  const t = useTranslate();
  return (
    <LibraryGroup
      title={t("chat.skills.jira.title")}
      count={jira.tools.templates.length}
      hint={t("chat.skills.jira.description")}
      extra={<PodSelect jira={jira} />}
    >
      <JiraTemplateList
        jira={jira}
        library={library}
        openId={openId}
        onOpen={(item) => workspace.guard(() => workspace.open(item))}
      />
      <button
        type="button"
        className={styles.cmpLink}
        onClick={() => workspace.guard(() => workspace.show("propose"))}
      >
        <PlusIcon size={14} />
        {t("chat.skills.jira.proposeTitle")}
      </button>
    </LibraryGroup>
  );
}

function LibraryActions({
  library,
  workspace,
}: {
  readonly library: MarkdownSkillLibrary;
  readonly workspace: SkillWorkspace;
}): ReactNode {
  const t = useTranslate();
  const disabled = library.busy || !library.available;
  return (
    <div className={styles.cmpLibraryActions}>
      <button
        type="button"
        className={styles.cmpPrimary}
        onClick={() =>
          workspace.guard(() => workspace.create(`# ${t("chat.skills.newName")}\n\n`, "skill.md"))
        }
      >
        <PlusIcon size={16} />
        {t("chat.skills.new")}
      </button>
      <button type="button" onClick={() => workspace.guard(() => workspace.show("author"))}>
        <SparkIcon size={16} />
        {t("chat.skills.author.short")}
      </button>
      <label
        className={styles.cmpUploadButton}
        data-disabled={disabled}
        title={t("chat.skills.upload")}
      >
        <FileIcon size={16} />
        <span>{t("chat.skills.import")}</span>
        <input
          type="file"
          className="visually-hidden"
          accept=".md,text/markdown"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) workspace.guard(() => workspace.importFile(file));
          }}
        />
      </label>
    </div>
  );
}

function LibraryGroup({
  title,
  count,
  hint,
  extra,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly hint?: string;
  readonly extra?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const headingId = useId();
  return (
    <section className={styles.cmpGroup} aria-labelledby={headingId}>
      <div className={styles.cmpGroupHead}>
        <h3 id={headingId}>{title}</h3>
        <span className={styles.cmpCount}>{count}</span>
      </div>
      {hint === undefined ? null : <p className={styles.cmpGroupHint}>{hint}</p>}
      {extra}
      {children}
    </section>
  );
}

function ChatSkillItem({
  item,
  skill,
  open,
  onOpen,
}: {
  readonly item: MarkdownSkillMetadata;
  readonly skill: ChatMarkdownSkill;
  readonly open: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const t = useTranslate();
  const selected = skill.view?.selection.skill;
  const active = selected?.id === item.id && selected.revision === item.revision;
  return (
    <li>
      <button
        type="button"
        className={styles.cmpItem}
        aria-current={open ? "true" : undefined}
        onClick={onOpen}
      >
        <span className={styles.cmpItemName}>{item.name}</span>
        <span className={styles.cmpStatus} data-state={active ? "ok" : "idle"}>
          {active ? <span className={styles.cmpDot} aria-hidden="true" /> : null}
          <span>
            v{item.revision}
            {active ? ` · ${t("chat.skills.selected")}` : ""}
          </span>
        </span>
      </button>
    </li>
  );
}

function LibraryStatus({
  library,
  skill,
}: {
  readonly library: MarkdownSkillLibrary;
  readonly skill: ChatMarkdownSkill;
}): ReactNode {
  const t = useTranslate();
  if (library.error !== undefined || skill.failed)
    return (
      <div role="alert" className={styles.cmpAlert}>
        <span>{t(skillLibraryErrorKey(library.error, skill.requireNoSkill === true))}</span>
        <button
          type="button"
          disabled={library.busy}
          onClick={() => {
            void library.refresh();
            void skill.refresh();
          }}
        >
          {t("chat.skills.retry")}
        </button>
      </div>
    );
  if (library.busy && !library.available)
    return <output className={styles.cmpEmpty}>{t("chat.skills.loading")}</output>;
  return null;
}

function skillLibraryErrorKey(
  error: MarkdownSkillLibrary["error"],
  sessionRequired: boolean,
): "chat.skills.fileError" | "chat.skills.sessionRequired" | "chat.skills.requestError" {
  if (error === "file") return "chat.skills.fileError";
  return sessionRequired ? "chat.skills.sessionRequired" : "chat.skills.requestError";
}
