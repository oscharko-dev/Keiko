import { MessagePort } from "node:worker_threads";
import { isNonEmptyString, isRecord } from "@oscharko-dev/keiko-contracts/runtime/coding-context";
import type { ProcessScopeWorkerData } from "@oscharko-dev/keiko-security/process-scope-worker";

export const USEARCH_CONTROL = Object.freeze({
  state: 0,
  command: 1,
  requestSequence: 2,
  responseSequence: 3,
  candidateLimit: 4,
  resultCount: 5,
  error: 6,
  length: 7,
});

export const USEARCH_STATE = Object.freeze({
  building: 0,
  ready: 1,
  closed: 2,
  failed: -1,
});

export const USEARCH_COMMAND = Object.freeze({
  idle: 0,
  search: 1,
  close: 2,
});

export const USEARCH_ERROR = Object.freeze({
  none: 0,
  runtimeInvalid: 1,
  buildFailed: 2,
  searchFailed: 3,
});

export type UsearchWorkerMessage =
  | { readonly kind: "build-complete" }
  | { readonly kind: "search-complete"; readonly sequence: number };

export interface UsearchWorkerData {
  readonly processScope?: ProcessScopeWorkerData;
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly expectedVersion: string;
  readonly dimensions: number;
  readonly rowCount: number;
  readonly connectivity: number;
  readonly expansionAdd: number;
  readonly expansionSearch: number;
  readonly controlBuffer: SharedArrayBuffer;
  readonly keysBuffer: SharedArrayBuffer;
  readonly vectorsBuffer: SharedArrayBuffer;
  readonly queryBuffer: SharedArrayBuffer;
  readonly resultKeysBuffer: SharedArrayBuffer;
  readonly resultDistancesBuffer: SharedArrayBuffer;
}

const WORKER_DATA_TEXT = ["binaryPath", "binarySha256", "expectedVersion"] as const;
const WORKER_DATA_INTEGERS = [
  "dimensions",
  "rowCount",
  "connectivity",
  "expansionAdd",
  "expansionSearch",
] as const;
const WORKER_DATA_BUFFERS = [
  "controlBuffer",
  "keysBuffer",
  "vectorsBuffer",
  "queryBuffer",
  "resultKeysBuffer",
  "resultDistancesBuffer",
] as const;

function isProcessScopeData(value: unknown): value is ProcessScopeWorkerData {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Number.isSafeInteger(value.pid) &&
    value.port instanceof MessagePort
  );
}

/** The worker's startup data arrives as a structured clone; every field is checked before use. */
export function isUsearchWorkerData(value: unknown): value is UsearchWorkerData {
  if (!isRecord(value)) return false;
  return (
    (value.processScope === undefined || isProcessScopeData(value.processScope)) &&
    WORKER_DATA_TEXT.every((key) => isNonEmptyString(value[key])) &&
    WORKER_DATA_INTEGERS.every((key) => Number.isSafeInteger(value[key])) &&
    WORKER_DATA_BUFFERS.every((key) => value[key] instanceof SharedArrayBuffer)
  );
}
