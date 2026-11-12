import type { ReactNode } from "react";

import { RetryMessage } from "./CodingWorkbenchChanges";
import styles from "./CodingWorkbenchWindow.module.css";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { WorkbenchExecutionLocationState } from "./useWorkbenchExecutionLocation";

// The checkout notice beside the repository selector. A failed binding shows its error and Retry
// alone, as the start blocker does: a reload that runs meanwhile adds no second "Preparing" line,
// which would contradict the error and move the selector when the reload ends.
export function LocationBindingNotices({
  locationState,
}: {
  readonly locationState: WorkbenchExecutionLocationState;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
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
