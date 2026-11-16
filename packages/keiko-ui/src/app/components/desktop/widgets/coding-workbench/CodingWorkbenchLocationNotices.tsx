import type { ReactNode } from "react";

import { RetryMessage } from "./CodingWorkbenchChanges";
import styles from "./CodingWorkbenchWindow.module.css";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { WorkbenchExecutionLocationState } from "./useWorkbenchExecutionLocation";

// The checkout notice beside the repository selector. A failed binding shows its error and Retry
// alone, as the start blocker does: a reload that runs meanwhile adds no second "Preparing" line,
// which would contradict the error and move the selector when the reload ends.
/**
 * The one sentence that says why the checkout cannot start. A refused folder is named as that (the
 * server's closed reason) with its one way out; only an unspecified failure keeps the generic
 * sentence, and no failure carries a second sentence that guesses another cause (#4371).
 */
export function locationBlockerKey(
  state: Pick<WorkbenchExecutionLocationState, "error" | "denied">,
): Parameters<CodingWorkbenchTranslate>[0] {
  if (state.denied) return "codingWorkbench.repository.deniedBlocker";
  return state.error
    ? "codingWorkbench.repository.locationError"
    : "codingWorkbench.repository.locationBinding";
}

export function LocationBindingNotices({
  locationState,
}: {
  readonly locationState: WorkbenchExecutionLocationState;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  // A refused folder is explained once, with its way out, by the repository selector's own help.
  if (locationState.denied) return null;
  if (locationState.error) {
    return (
      <RetryMessage
        text={t("codingWorkbench.repository.locationError")}
        className={styles.cmpRepositorySelectorNotice}
        role="alert"
        retry={{
          label: t("codingWorkbench.repository.retryLoad"),
          onRetry: locationState.retry,
        }}
      />
    );
  }
  if (!locationState.pending) return null;
  return (
    <output className={styles.cmpRepositorySelectorNotice}>
      {t("codingWorkbench.repository.locationBinding")}
    </output>
  );
}
