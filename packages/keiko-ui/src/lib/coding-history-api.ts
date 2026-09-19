"use client";
import type {
  CodingHistoryDetail,
  CodingHistoryTask,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { bffFetchJson } from "./http";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

const ROOT = "/api/coding-workbench/history";
export const CODING_HISTORY_CHANGED = "keiko:coding-history-changed";

export async function fetchCodingHistory(): Promise<readonly CodingHistoryTask[]> {
  await codingAppSessionPairingSettled();
  const result = await bffFetchJson<{ tasks: readonly CodingHistoryTask[] }>(ROOT, {
    signal: AbortSignal.timeout(15_000),
  });
  return result.tasks;
}

export async function fetchCodingTask(id: string): Promise<CodingHistoryDetail> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(`${ROOT}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
}

export async function updateCodingTask(
  id: string,
  patch: { readonly title?: string; readonly status?: "active" | "completed" },
): Promise<CodingHistoryTask> {
  await codingAppSessionPairingSettled();
  const result = await bffFetchJson<{ task: CodingHistoryTask }>(
    `${ROOT}/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
  return result.task;
}
