"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchRuntimeInboxAction } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { useCodingWorkbenchInbox } from "@/lib/useCodingWorkbenchInbox";
import { CodingWorkbenchInbox } from "./CodingWorkbenchInbox";

export interface CodingWorkbenchInboxPanelProps {
  readonly runId: string | undefined;
  /** The run's turn is running: the only time the runtime holds messages it has not taken yet. */
  readonly running: boolean;
  readonly revision: number | undefined;
  /** Changes when the turn takes a waiting message (`deliveredMessageSignal`). */
  readonly deliveredSignal: number | null;
  /** A runtime mutation is in flight: the controls wait instead of racing it. */
  readonly busy: boolean;
  readonly onAction: (action: CodingWorkbenchRuntimeInboxAction, itemId: string) => void;
}

/**
 * The messages waiting for the running turn (S07), read from their authenticated channel and shown
 * above the composer with Cancel and Send now. The hook and the list live here so the Workbench
 * window only mounts one element; an action goes through the window's one mutation queue.
 */
export function CodingWorkbenchInboxPanel({
  runId,
  running,
  revision,
  deliveredSignal,
  busy,
  onAction,
}: CodingWorkbenchInboxPanelProps): ReactNode {
  const inbox = useCodingWorkbenchInbox({ runId, live: running, revision, deliveredSignal });
  return (
    <CodingWorkbenchInbox
      status={inbox.status}
      items={inbox.items}
      busy={busy}
      onCancel={(itemId): void => onAction("cancel", itemId)}
      onSendNow={(itemId): void => onAction("promote", itemId)}
      onRetry={inbox.retry}
    />
  );
}
