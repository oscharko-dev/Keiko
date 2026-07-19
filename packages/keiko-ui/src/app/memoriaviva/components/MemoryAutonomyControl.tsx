"use client";

import { useId, type ReactNode } from "react";
import { CODING_WORKBENCH_MODES, type CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import styles from "./memory-autonomy-control.module.css";

const MODE_KEYS = {
  "governed-assist": {
    label: "memoria.settings.mode.governedAssist.label",
    description: "memoria.settings.mode.governedAssist.description",
  },
  "supervised-coding": {
    label: "memoria.settings.mode.supervisedCoding.label",
    description: "memoria.settings.mode.supervisedCoding.description",
  },
  "autonomous-delivery": {
    label: "memoria.settings.mode.autonomousDelivery.label",
    description: "memoria.settings.mode.autonomousDelivery.description",
  },
} as const;

interface ModeOptionProps {
  readonly groupId: string;
  readonly mode: CodingWorkbenchMode;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
  readonly t: I18nTranslate;
}

function ModeOption({
  groupId,
  mode,
  selected,
  disabled,
  onChange,
  t,
}: ModeOptionProps): ReactNode {
  const id = `${groupId}-${mode}`;
  const keys = MODE_KEYS[mode];
  return (
    <label
      className={styles.option}
      data-selected={selected}
      htmlFor={id}
      aria-label={t(keys.label)}
    >
      <input
        id={id}
        type="radio"
        name={groupId}
        value={mode}
        checked={selected}
        disabled={disabled}
        onChange={() => onChange(mode)}
      />
      <span className={styles.optionText}>
        <strong>{t(keys.label)}</strong>
        <span>{t(keys.description)}</span>
      </span>
    </label>
  );
}

interface MemoryAutonomyControlProps {
  readonly mode: CodingWorkbenchMode;
  readonly disabled: boolean;
  readonly error: "hydrate" | "persist" | null;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}

export function MemoryAutonomyControl({
  mode,
  disabled,
  error,
  onChange,
}: MemoryAutonomyControlProps): ReactNode {
  const t = useTranslate();
  const groupId = `${useId()}-memory-autonomy-mode`;
  return (
    <div className={styles.root}>
      <div className={styles.heading}>
        <strong>{t("memoria.settings.mode.label")}</strong>
        <span>{t("memoria.settings.mode.help")}</span>
      </div>
      <div className={styles.group} role="radiogroup" aria-label={t("memoria.settings.mode.group")}>
        {CODING_WORKBENCH_MODES.map((option) => (
          <ModeOption
            key={option}
            groupId={groupId}
            mode={option}
            selected={mode === option}
            disabled={disabled}
            onChange={onChange}
            t={t}
          />
        ))}
      </div>
      {error === null ? null : (
        <p className={styles.error} role="alert">
          {t(`memoria.settings.mode.${error}Error`)}
        </p>
      )}
    </div>
  );
}
