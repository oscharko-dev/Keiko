"use client";
import type {
  CodingWorkbenchScheduleAction,
  CodingWorkbenchScheduleControlResponse,
  CodingWorkbenchSchedulesResponse,
} from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "./http";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

// #4271: a Coding History task's scheduled continuations (ADR-0137 D10).
const ROOT = "/api/coding-workbench/runtime/schedules";

export async function fetchCodingSchedules(
  taskId: string,
  signal?: AbortSignal,
): Promise<CodingWorkbenchSchedulesResponse> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(`${ROOT}?taskId=${encodeURIComponent(taskId)}`, {
    signal: signal ?? AbortSignal.timeout(15_000),
  });
}

export async function controlCodingSchedule(
  taskId: string,
  scheduleId: string,
  action: CodingWorkbenchScheduleAction,
): Promise<CodingWorkbenchScheduleControlResponse> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(`${ROOT}/${encodeURIComponent(scheduleId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ taskId }),
    signal: AbortSignal.timeout(15_000),
  });
}
