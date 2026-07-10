export const MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE = 64;

export interface EditorAgentReconciliationEntry {
  readonly file: string;
  readonly kind: "create" | "modify" | "delete";
}

export interface EditorAgentReconciliationRequest {
  readonly requestId: number;
  readonly entries: readonly EditorAgentReconciliationEntry[];
}

export interface EditorAgentReconciliationPane {
  readonly id: string;
  readonly openFiles: readonly string[];
}

export type EditorAgentReconciliationQueues = Readonly<
  Record<string, readonly EditorAgentReconciliationRequest[]>
>;

function targetsRequest(
  pane: EditorAgentReconciliationPane,
  sourcePaneId: string,
  request: EditorAgentReconciliationRequest,
): boolean {
  if (pane.id === sourcePaneId) return false;
  const files = new Set(request.entries.map((entry) => entry.file));
  return pane.openFiles.some((file) => files.has(file));
}

function compactRequests(
  requests: readonly EditorAgentReconciliationRequest[],
  latestRequestId: number,
): readonly EditorAgentReconciliationRequest[] {
  const entries = new Map<string, EditorAgentReconciliationEntry>();
  for (const request of requests) {
    for (const entry of request.entries) entries.set(entry.file, entry);
  }
  return [{ requestId: latestRequestId, entries: [...entries.values()] }];
}

export function enqueueEditorAgentReconciliation(
  current: EditorAgentReconciliationQueues,
  panes: readonly EditorAgentReconciliationPane[],
  sourcePaneId: string,
  request: EditorAgentReconciliationRequest,
): EditorAgentReconciliationQueues {
  let changed = false;
  const next: Record<string, readonly EditorAgentReconciliationRequest[]> = { ...current };
  for (const pane of panes) {
    if (!targetsRequest(pane, sourcePaneId, request)) continue;
    changed = true;
    const queued = [...(current[pane.id] ?? []), request];
    next[pane.id] =
      queued.length <= MAX_EDITOR_AGENT_RECONCILIATION_REQUESTS_PER_PANE
        ? queued
        : compactRequests(queued, request.requestId);
  }
  return changed ? next : current;
}

export function completeEditorAgentReconciliation(
  current: EditorAgentReconciliationQueues,
  paneId: string,
  requestId: number,
): EditorAgentReconciliationQueues {
  const queue = current[paneId];
  if (queue?.[0]?.requestId !== requestId) return current;
  const next = { ...current };
  const remaining = queue.slice(1);
  if (remaining.length === 0) delete next[paneId];
  else next[paneId] = remaining;
  return next;
}

export function pruneEditorAgentReconciliation(
  current: EditorAgentReconciliationQueues,
  paneIds: ReadonlySet<string>,
): EditorAgentReconciliationQueues {
  const next: Record<string, readonly EditorAgentReconciliationRequest[]> = {};
  let changed = false;
  for (const [paneId, requests] of Object.entries(current)) {
    if (paneIds.has(paneId)) next[paneId] = requests;
    else changed = true;
  }
  return changed ? next : current;
}
