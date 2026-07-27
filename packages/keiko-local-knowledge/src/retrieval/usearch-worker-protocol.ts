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

export interface UsearchWorkerData {
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
