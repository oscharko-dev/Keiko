import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import {
  CODING_WORKBENCH_MODES,
  resolveEffectiveCodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";

/** One option owner for Coding and Chat; explanations remain specific to each surface. */
export function autonomyOptions(
  t: (key: `codingWorkbench.mode.${CodingWorkbenchMode}.label`) => string,
  describe?: (mode: CodingWorkbenchMode) => string,
  ceiling: CodingWorkbenchMode = "autonomous-delivery",
): readonly {
  readonly value: CodingWorkbenchMode;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
}[] {
  return CODING_WORKBENCH_MODES.map((mode) => ({
    value: mode,
    label: t(`codingWorkbench.mode.${mode}.label`),
    ...(describe === undefined ? {} : { description: describe(mode) }),
    disabled: resolveEffectiveCodingWorkbenchMode(mode, ceiling) !== mode,
  }));
}
