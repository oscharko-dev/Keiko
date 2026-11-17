import { startFilesNavigationEvidence } from "@/lib/files-navigation-evidence";
import type { WorkspaceWatchClientState } from "./useWorkspaceWatch";

/** A read can acknowledge only the root and exact watch snapshot it set out to refresh. */
export function beginWorkspaceWatchRecovery(
  watch: { readonly current: WorkspaceWatchClientState },
  correlationId: string,
): (outcome: "applied" | "failed" | "cancelled") => void {
  const snapshot = watch.current;
  if (!snapshot.snapshotRequired) return (): void => undefined;
  const settle = startFilesNavigationEvidence("editor watch recovery", correlationId);
  return (outcome): void => {
    if (outcome !== "applied") {
      settle(undefined, outcome);
      return;
    }
    if (watch.current.acknowledgeSnapshot !== snapshot.acknowledgeSnapshot) {
      settle(undefined, "stale");
      return;
    }
    settle(undefined, snapshot.acknowledgeSnapshot() ? "applied" : "stale");
  };
}
