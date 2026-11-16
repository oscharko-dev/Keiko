"use client";

import type { ReactNode } from "react";
import type { MarkdownSkillMetadata } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import type { MarkdownSkillLibrary } from "./useMarkdownSkillLibrary";
import styles from "./MarkdownSkillControl.module.css";

/**
 * Chooses a stored skill or Jira template for the current chat, right in its list row. A selection
 * binds the saved revision; clearing it belongs to the chat's skill chip.
 */
export function SkillChatToggle({
  item,
  skill,
  library,
  disabled,
}: {
  readonly item: MarkdownSkillMetadata;
  readonly skill: ChatMarkdownSkill;
  readonly library: MarkdownSkillLibrary;
  readonly disabled: boolean;
}): ReactNode {
  const t = useTranslate();
  const selected = skill.view?.selection.skill;
  const active = selected?.id === item.id && selected.revision === item.revision;
  // aria-disabled, not disabled: a keyboard user keeps focus while the selection runs, so Escape
  // still reaches the dialog.
  const blocked = active || disabled || skill.busy || library.busy;
  return (
    <button
      type="button"
      className={active ? `${styles.cmpToggle} ${styles.cmpActive}` : styles.cmpToggle}
      aria-pressed={active}
      aria-disabled={blocked}
      onClick={() => {
        if (blocked) return;
        void skill
          .select({ id: item.id, revision: item.revision, digest: item.digest })
          .catch(() => undefined);
      }}
    >
      {active ? <span className={styles.cmpDot} aria-hidden="true" /> : null}
      {t(active ? "chat.skills.selected" : "chat.skills.useInChat")}
    </button>
  );
}
