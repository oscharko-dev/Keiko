"use client";

import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { DynamicChunkLoadFailure } from "../DynamicChunkLoadFailure";
import type { ChatMarkdownSkill } from "../hooks/useChatMarkdownSkill";
import styles from "./MarkdownSkillControl.module.css";

const MarkdownSkillDialog = dynamic(
  () => import("./MarkdownSkillDialog").then((module) => module.MarkdownSkillDialog),
  { ssr: false, loading: DynamicChunkLoadFailure },
);

export function MarkdownSkillControl({
  skill,
  disabled,
  modelId,
}: {
  readonly skill: ChatMarkdownSkill | undefined;
  readonly disabled: boolean;
  readonly modelId?: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  if (skill?.chatId === undefined) return null;
  return (
    <div className={styles.cmpControls}>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {t("chat.skills.title")}
      </button>
      <SelectedSkillChip skill={skill} disabled={disabled} onOpen={() => setOpen(true)} />
      {skill.failed && skill.requireNoSkill !== true ? (
        <span role="alert">{t("chat.skills.requestError")}</span>
      ) : null}
      {open ? (
        <MarkdownSkillDialog
          modelId={modelId}
          skill={skill}
          disabled={disabled}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SelectedSkillChip({
  skill,
  disabled,
  onOpen,
}: {
  readonly skill: ChatMarkdownSkill;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  const t = useTranslate();
  const selected = skill.view?.selection.skill;
  if (!selected) return null;
  return (
    <span className={styles.cmpChip}>
      <button type="button" onClick={onOpen} title={t("chat.skills.protected")}>
        <span className={styles.cmpChipName}>
          {skill.view?.availability === "available"
            ? skill.view.name
            : t("chat.skills.unavailable")}
        </span>
        <span className={styles.cmpRevision}> · v{selected.revision}</span>
      </button>
      <button
        type="button"
        aria-label={t("chat.skills.remove")}
        disabled={disabled || skill.busy}
        onClick={() => {
          void skill.select(null).catch(() => undefined);
        }}
      >
        ×
      </button>
    </span>
  );
}
