"use client";
import { useId, type ReactNode } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";

const LABELS = {
  "governed-assist": "agentLauncher.mode.governedAssist.label",
  "supervised-coding": "agentLauncher.mode.supervisedCoding.label",
  "autonomous-delivery": "agentLauncher.mode.autonomousDelivery.label",
} as const;

export function AutonomyModeSelect({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: CodingWorkbenchMode;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}): ReactNode {
  const t = useTranslate();
  const id = useId();
  return (
    <label htmlFor={id}>
      {label}
      <select
        id={id}
        className="scope-grounding-select"
        value={value}
        onChange={(event) => {
          const mode = CODING_WORKBENCH_MODES.find((item) => item === event.target.value);
          if (mode !== undefined) onChange(mode);
        }}
      >
        {CODING_WORKBENCH_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(LABELS[mode])}
          </option>
        ))}
      </select>
    </label>
  );
}
