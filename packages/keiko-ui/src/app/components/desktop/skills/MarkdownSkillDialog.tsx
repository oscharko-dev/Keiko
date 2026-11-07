"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { useDialogTabTrap } from "../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../hooks/useModalInteractionLock";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import { Icons } from "../Icons";
import { useMarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import { useJiraTemplates } from "./JiraTemplateTools";
import { useSkillWorkspace } from "./useSkillWorkspace";
import { SkillLibraryPane } from "./SkillLibraryPane";
import { SkillWorkspacePane } from "./SkillWorkspacePane";
import styles from "./MarkdownSkillControl.module.css";

const CloseIcon = Icons.close;

interface DialogProps {
  readonly modelId: string | undefined;
  readonly skill: ChatMarkdownSkill;
  readonly disabled: boolean;
  readonly onClose: () => void;
}

function useCloseOnEscape(dialog: { current: HTMLElement | null }, onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.stopPropagation();
        latest.current();
      }
    };
    const element = dialog.current;
    element?.addEventListener("keydown", close);
    return (): void => element?.removeEventListener("keydown", close);
  }, [dialog]);
}

function DialogHeader({
  titleId,
  onClose,
}: {
  readonly titleId: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <header className={styles.cmpHeader}>
      <div>
        <h2 id={titleId}>{t("chat.skills.title")}</h2>
        <p>{t("chat.skills.description")}</p>
      </div>
      <button
        type="button"
        className={styles.cmpIconButton}
        onClick={onClose}
        aria-label={t("chat.skills.close")}
      >
        <CloseIcon size={18} />
      </button>
    </header>
  );
}

/**
 * The skills manager: the library of chat skills and Jira templates on the left third, the open
 * Markdown file in the shared editor on the right two thirds.
 */
export function MarkdownSkillDialog({ skill, disabled, onClose, modelId }: DialogProps): ReactNode {
  const t = useTranslate();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const library = useMarkdownSkillLibrary(skill.refresh);
  const jira = useJiraTemplates(library);
  const workspace = useSkillWorkspace(library);
  // Unsaved text is never lost by closing: the person first agrees to discard it.
  const close = (): void => workspace.guard(onClose);
  useCloseOnEscape(dialog, close);
  useDialogTabTrap(dialog);
  useModalInteractionLock({ initialFocusRef: dialog });
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
        <DialogHeader titleId={titleId} onClose={close} />
        <div className={styles.cmpManager}>
          <SkillLibraryPane library={library} skill={skill} jira={jira} workspace={workspace} />
          <SkillWorkspacePane
            library={library}
            skill={skill}
            jira={jira}
            workspace={workspace}
            disabled={disabled}
            modelId={modelId}
          />
        </div>
      </dialog>
    </div>,
    document.body,
  );
}
