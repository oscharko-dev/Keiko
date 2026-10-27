"use client";
import type { ReactNode } from "react";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  isCodingWorkbenchMode,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import KeikoSelect from "./KeikoSelect";
import { autonomyOptions } from "./autonomyOptions";

export function AutonomyModeSelect({
  label,
  value,
  ceiling = "governed-assist",
  onChange,
}: {
  readonly label: string;
  readonly value: CodingWorkbenchMode;
  readonly ceiling?: CodingWorkbenchMode;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <KeikoSelect
      value={value}
      ariaLabel={label}
      menuTitle={label}
      showTriggerDescription={false}
      sections={[{ options: autonomyOptions(t, undefined, ceiling) }]}
      onValueChange={(mode) => {
        if (
          isCodingWorkbenchMode(mode) &&
          resolveEffectiveCodingWorkbenchMode(mode, ceiling) === mode
        )
          onChange(mode);
      }}
    />
  );
}
