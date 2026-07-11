// Issue #2245 (Epic #2238) — sync status/progress/change presentation atoms.
//
// Reuses the Epic #1856 / Issue #1893 manual-refresh presentation language verbatim: the global
// `lk-badge[data-state]` readiness badge, the dt/dd counts list, and the guidance-line list for
// remediation. Connector sync summaries therefore read exactly like Local Knowledge pod refreshes.
// Every value is a redacted count or closed enum — no item body, path, or URL is ever rendered.

import { Fragment, type ReactNode } from "react";
import type {
  AtlassianSyncChangeCounts,
  AtlassianSyncFailureReason,
  AtlassianSyncJobStatus,
  AtlassianSyncProgressCounts,
} from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { syncFailureReasonKey, syncStatusBadgeState, syncStatusLabelKey } from "./connector-labels";

const PROGRESS_ROWS: ReadonlyArray<readonly [keyof AtlassianSyncProgressCounts, MessageKey]> = [
  ["enumeratedItems", "atlassianConnectors.sync.progress.enumerated"],
  ["fetchedItems", "atlassianConnectors.sync.progress.fetched"],
  ["indexedItems", "atlassianConnectors.sync.progress.indexed"],
  ["skippedItems", "atlassianConnectors.sync.progress.skipped"],
  ["failedItems", "atlassianConnectors.sync.progress.failed"],
];

const CHANGE_ROWS: ReadonlyArray<readonly [keyof AtlassianSyncChangeCounts, MessageKey]> = [
  ["addedItems", "atlassianConnectors.sync.change.addedItems"],
  ["changedItems", "atlassianConnectors.sync.change.changedItems"],
  ["removedItems", "atlassianConnectors.sync.change.removedItems"],
  ["unchangedItems", "atlassianConnectors.sync.change.unchangedItems"],
  ["failedItems", "atlassianConnectors.sync.change.failedItems"],
  ["deniedItems", "atlassianConnectors.sync.change.deniedItems"],
];

export function JobStatusBadge({ status }: { readonly status: AtlassianSyncJobStatus }): ReactNode {
  const t = useTranslate();
  return (
    <span
      className="lk-badge"
      data-state={syncStatusBadgeState(status)}
      data-testid="acx-sync-badge"
    >
      {t(syncStatusLabelKey(status))}
    </span>
  );
}

export function SyncProgressCounts({
  progress,
}: {
  readonly progress: AtlassianSyncProgressCounts;
}): ReactNode {
  const t = useTranslate();
  return (
    <dl className="acx-counts" data-testid="acx-sync-progress">
      {PROGRESS_ROWS.map(([key, labelKey]) => (
        <Fragment key={key}>
          <dt>{t(labelKey)}</dt>
          <dd>{progress[key].toString()}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function SyncChangeCounts({
  counts,
}: {
  readonly counts: AtlassianSyncChangeCounts;
}): ReactNode {
  const t = useTranslate();
  return (
    <dl className="acx-counts" data-testid="acx-sync-changes">
      {CHANGE_ROWS.map(([key, labelKey]) => (
        <Fragment key={key}>
          <dt>{t(labelKey)}</dt>
          <dd>{counts[key].toString()}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function SyncDegradation({
  reasons,
}: {
  readonly reasons: readonly AtlassianSyncFailureReason[];
}): ReactNode {
  const t = useTranslate();
  if (reasons.length === 0) return null;
  return (
    <div className="acx-section" data-testid="acx-sync-degraded">
      <p className="acx-section-title">{t("atlassianConnectors.sync.degradedTitle")}</p>
      <ul className="acx-degraded">
        {reasons.map((reason) => (
          <li key={reason} data-reason={reason}>
            {t(syncFailureReasonKey(reason))}
          </li>
        ))}
      </ul>
    </div>
  );
}
