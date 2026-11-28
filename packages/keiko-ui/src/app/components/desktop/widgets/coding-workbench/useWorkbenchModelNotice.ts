import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import type { ChatSessionCatalog } from "../../context/ChatSessionContext";
import { useModelActivation, type ModelActivation } from "@/lib/useModelActivation";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { savedCodingModel } from "./codingModelPreference";
import { visibleAlert } from "./codingWorkbenchLabels";
import {
  configuredCatalogModels,
  workbenchModelReadiness,
  type WorkbenchModelReadiness,
} from "./codingWorkbenchModelReadiness";

export interface WorkbenchModelNotice {
  /** The one alert sentence, or null; its wording follows the model's readiness fact. */
  readonly alert: string | null;
  readonly modelReadiness: WorkbenchModelReadiness | null;
  readonly modelActivation: ModelActivation;
}

/**
 * The Workbench's alert and its in-place model activation (U-12, #4491): which sentence the alert
 * carries ("not activated yet" or "did not pass its readiness check") and the person's own
 * activation, which runs the same check as Settings > Models. While it runs, the "checking" state
 * replaces the alert instead of repeating it.
 */
export function useWorkbenchModelNotice(input: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly catalog: ChatSessionCatalog | null;
  readonly t: CodingWorkbenchTranslate;
  readonly setupVisible: boolean;
  readonly authorityError: string | null;
  /** The branch the checkout moved to outside Keiko since the window last read it (U-39). */
  readonly checkoutBranchChangedTo?: string | null;
}): WorkbenchModelNotice {
  const { state, t } = input;
  const modelActivation = useModelActivation("coding-workbench");
  const modelReadiness = workbenchModelReadiness({
    state,
    models: configuredCatalogModels(input.catalog),
    savedModelId: savedCodingModel(),
    activation: modelActivation.state,
  });
  const alert =
    modelActivation.state.status === "running"
      ? null
      : visibleAlert(
          state,
          t,
          input.setupVisible,
          input.authorityError,
          modelReadiness,
          input.checkoutBranchChangedTo ?? null,
        );
  return { alert, modelReadiness, modelActivation };
}
