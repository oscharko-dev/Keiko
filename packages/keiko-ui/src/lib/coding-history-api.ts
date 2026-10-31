"use client";
import {
  CODING_TASK_EXPORT_MAX_BYTES,
  CODING_TASK_IMPORT_MAX_BYTES,
  CODING_TASK_IMPORT_SOURCES,
  type CodingHistoryDetail,
  type CodingHistoryTask,
  type CodingTaskExportFormat,
  type CodingTaskExportResponse,
  type CodingTaskImportResponse,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { ApiError } from "./api";
import { bffFetchJson } from "./http";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { saveTextDownload } from "./browser-download";

const ROOT = "/api/coding-workbench/history";
export const CODING_HISTORY_CHANGED = "keiko:coding-history-changed";

export async function fetchCodingHistory(): Promise<readonly CodingHistoryTask[]> {
  await codingAppSessionPairingSettled();
  const result = await bffFetchJson<{ tasks: readonly CodingHistoryTask[] }>(ROOT, {
    signal: AbortSignal.timeout(15_000),
  });
  return result.tasks;
}

export async function fetchCodingTask(
  id: string,
  correlationId?: string,
): Promise<CodingHistoryDetail> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(
    `${ROOT}/${encodeURIComponent(id)}`,
    { signal: AbortSignal.timeout(15_000) },
    correlationId === undefined ? undefined : { correlationId },
  );
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

const EXPORT_FILE_NAME = /^keiko-coding-task-[A-Za-z0-9._-]{1,48}\.(?:json|md)$/u;
const EXPORT_MEDIA_TYPES = {
  json: "application/json",
  markdown: "text/markdown",
} as const satisfies Record<CodingTaskExportFormat, CodingTaskExportResponse["mediaType"]>;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExportIdentity(file: Record<string, unknown>, format: CodingTaskExportFormat): boolean {
  return (
    file.format === format &&
    file.mediaType === EXPORT_MEDIA_TYPES[format] &&
    typeof file.fileName === "string" &&
    EXPORT_FILE_NAME.test(file.fileName)
  );
}

function hasExportContent(file: Record<string, unknown>): boolean {
  return (
    typeof file.content === "string" &&
    isCount(file.messageCount) &&
    isCount(file.byteCount) &&
    file.byteCount <= CODING_TASK_EXPORT_MAX_BYTES &&
    new TextEncoder().encode(file.content).byteLength === file.byteCount &&
    typeof file.truncated === "boolean"
  );
}

function isExportFile(
  value: unknown,
  format: CodingTaskExportFormat,
): value is CodingTaskExportResponse {
  if (typeof value !== "object" || value === null) return false;
  const file: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return hasExportIdentity(file, format) && hasExportContent(file);
}

/**
 * The user-controlled local export of a task (#3904): the server answers with the redacted file's
 * exact text, which {@link saveCodingTaskExport} hands to the browser's own download path. A
 * response that is not the file asked for is a contract failure, never a download.
 */
export async function exportCodingTask(
  id: string,
  format: CodingTaskExportFormat,
  correlationId?: string,
): Promise<CodingTaskExportResponse> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(
    `${ROOT}/${encodeURIComponent(id)}/export?format=${format}`,
    { signal: AbortSignal.timeout(30_000) },
    {
      validator: (_path, value): CodingTaskExportResponse => {
        if (!isExportFile(value, format))
          throw new ApiError("CONTRACT_VALIDATION_FAILED", "Invalid coding task export", 502);
        return value;
      },
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  );
}

const IMPORT_SOURCES: ReadonlySet<unknown> = new Set(CODING_TASK_IMPORT_SOURCES);

function isImportedTask(value: unknown): value is CodingHistoryTask {
  if (typeof value !== "object" || value === null) return false;
  const task: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
    typeof task.title === "string" &&
    task.origin === "imported"
  );
}

function isImportResponse(value: unknown): value is CodingTaskImportResponse {
  if (typeof value !== "object" || value === null) return false;
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    isImportedTask(result.task) &&
    IMPORT_SOURCES.has(result.source) &&
    isCount(result.messageCount) &&
    result.messageCount > 0 &&
    isCount(result.omittedMessageCount) &&
    isCount(result.skippedMessageCount)
  );
}

/**
 * The user-controlled local import of a saved task (#3904 AC4): the file the person picked goes to
 * the local server only, which stores its cleaned conversation as a new task. A file above the
 * bound is refused before it is read.
 */
export async function importCodingTask(
  file: Blob,
  correlationId?: string,
): Promise<CodingTaskImportResponse> {
  if (file.size > CODING_TASK_IMPORT_MAX_BYTES)
    throw new ApiError("CODING_HISTORY_IMPORT_TOO_LARGE", "The file is too large to import", 413);
  const text = await file.text();
  await codingAppSessionPairingSettled();
  const result = await bffFetchJson(
    `${ROOT}/import`,
    { method: "POST", body: text, signal: AbortSignal.timeout(60_000) },
    {
      validator: (_path, value): CodingTaskImportResponse => {
        if (!isImportResponse(value))
          throw new ApiError("CONTRACT_VALIDATION_FAILED", "Invalid coding task import", 502);
        return value;
      },
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  );
  window.dispatchEvent(new Event(CODING_HISTORY_CHANGED));
  return result;
}

/** Saves the file through the browser's download path; nothing leaves the device. */
export function saveCodingTaskExport(
  file: Pick<CodingTaskExportResponse, "content" | "fileName" | "mediaType">,
): void {
  saveTextDownload(file);
}
