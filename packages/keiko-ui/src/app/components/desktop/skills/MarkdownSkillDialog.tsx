"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  MarkdownSkillDocument,
  MarkdownSkillMetadata,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { useDialogTabTrap } from "../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../hooks/useModalInteractionLock";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { SafeMarkdown } from "../SafeMarkdown";
import { Icons } from "../Icons";
import { useMarkdownSkillLibrary, type MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import { MarkdownSkillAuthor } from "./MarkdownSkillAuthor";
import styles from "./MarkdownSkillControl.module.css";

const FileIcon = Icons.file;

interface DialogProps {
  readonly modelId: string | undefined;
  readonly skill: ChatMarkdownSkill;
  readonly disabled: boolean;
  readonly onClose: () => void;
}

function useCloseOnEscape(dialog: { current: HTMLElement | null }, onClose: () => void): void {
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const element = dialog.current;
    element?.addEventListener("keydown", close);
    return (): void => element?.removeEventListener("keydown", close);
  }, [dialog, onClose]);
}

export function MarkdownSkillDialog({ skill, disabled, onClose, modelId }: DialogProps): ReactNode {
  const t = useTranslate();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useCloseOnEscape(dialog, onClose);
  useDialogTabTrap(dialog);
  useModalInteractionLock({ initialFocusRef: dialog });
  const library = useMarkdownSkillLibrary(skill.refresh);
  return createPortal(
    <div className={styles.cmpBackdrop}>
      <dialog
        open
        ref={dialog}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.cmpDialog}
      >
        <header>
          <h2 id={titleId}>{t("chat.skills.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("chat.skills.close")}>
            ×
          </button>
        </header>
        <p>{t("chat.skills.description")}</p>
        <SkillUpload library={library} />
        <SkillLibraryStatus library={library} skill={skill} />
        <ul className={styles.cmpList}>
          {library.skills.map((item) => (
            <SkillRow
              key={item.id}
              item={item}
              library={library}
              skill={skill}
              disabled={disabled}
            />
          ))}
        </ul>
        {library.preview ? <SkillPreview library={library} /> : null}
        <MarkdownSkillAuthor key={modelId} modelId={modelId} library={library} />
        <p className={styles.cmpHint}>{t("chat.skills.protected")}</p>
      </dialog>
    </div>,
    document.body,
  );
}

function SkillUpload({
  library,
  previous,
}: {
  readonly library: MarkdownSkillLibrary;
  readonly previous?: MarkdownSkillMetadata;
}): ReactNode {
  const t = useTranslate();
  const disabled = library.busy || !library.available;
  return (
    <label className={styles.cmpFilePicker} data-disabled={disabled}>
      <FileIcon size={18} />
      <span>{t(previous === undefined ? "chat.skills.upload" : "chat.skills.replace")}</span>
      <input
        type="file"
        className="visually-hidden"
        accept=".md,text/markdown"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void library.upload(file, previous);
        }}
      />
    </label>
  );
}

function SkillLibraryStatus({
  library,
  skill,
}: {
  readonly library: MarkdownSkillLibrary;
  readonly skill: ChatMarkdownSkill;
}): ReactNode {
  const t = useTranslate();
  if (library.error !== undefined || skill.failed)
    return (
      <div role="alert">
        {t(skillLibraryErrorKey(library.error, skill.requireNoSkill === true))}
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
  if (library.busy) return <output>{t("chat.skills.loading")}</output>;
  return library.skills.length === 0 ? <p>{t("chat.skills.empty")}</p> : null;
}

function skillLibraryErrorKey(
  error: MarkdownSkillLibrary["error"],
  sessionRequired: boolean,
): "chat.skills.fileError" | "chat.skills.sessionRequired" | "chat.skills.requestError" {
  if (error === "file") return "chat.skills.fileError";
  return sessionRequired ? "chat.skills.sessionRequired" : "chat.skills.requestError";
}

function SkillRow({
  item,
  library,
  skill,
  disabled,
}: {
  readonly item: MarkdownSkillMetadata;
  readonly library: MarkdownSkillLibrary;
  readonly skill: ChatMarkdownSkill;
  readonly disabled: boolean;
}): ReactNode {
  const t = useTranslate();
  const selected = skill.view?.selection.skill;
  const active = selected?.id === item.id && selected.revision === item.revision;
  const selectionDisabled = disabled || skill.busy || library.busy || active;
  return (
    <li data-selected={active}>
      <button
        type="button"
        className={styles.cmpName}
        aria-disabled={library.busy}
        onClick={() => {
          if (library.busy) return;
          void library.inspect(item);
        }}
      >
        {item.name}
      </button>
      <span className={styles.cmpRevision}>v{item.revision}</span>
      <button
        type="button"
        aria-pressed={active}
        aria-disabled={selectionDisabled}
        onClick={() => {
          if (selectionDisabled) return;
          void skill
            .select({ id: item.id, revision: item.revision, digest: item.digest })
            .catch(() => undefined);
        }}
      >
        {t(active ? "chat.skills.selected" : "chat.skills.select")}
      </button>
    </li>
  );
}

function SkillContent({ item }: { readonly item: MarkdownSkillDocument }): ReactNode {
  return (
    <section
      className={styles.cmpMarkdown}
      aria-label={`${item.name} · v${String(item.revision)}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- bounded preview must support keyboard scrolling
      tabIndex={0}
    >
      <SafeMarkdown source={item.body} />
    </section>
  );
}

function SkillPreview({ library }: { readonly library: MarkdownSkillLibrary }): ReactNode {
  const t = useTranslate();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const item = library.preview;
  if (!item) return null;
  return (
    <section className={styles.cmpPreview} aria-label={t("chat.skills.preview")}>
      <h3>
        {item.name} · v{item.revision}
      </h3>
      <SkillContent item={item} />
      <div className={styles.cmpActions}>
        <SkillUpload library={library} previous={item} />
        <button
          type="button"
          disabled={library.busy}
          onClick={() => {
            void library.download(item);
          }}
        >
          {t("chat.skills.export")}
        </button>
        {confirmDelete === item.id ? (
          <>
            <span>{t("chat.skills.deleteWarning")}</span>
            <button
              type="button"
              disabled={library.busy}
              onClick={() => {
                void library.remove(item);
              }}
            >
              {t("chat.skills.confirmDelete")}
            </button>
            <button type="button" onClick={() => setConfirmDelete(undefined)}>
              {t("chat.skills.cancel")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(item.id)}>
            {t("chat.skills.delete")}
          </button>
        )}
      </div>
    </section>
  );
}
