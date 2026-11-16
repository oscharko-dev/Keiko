// One network read for identical, concurrent BFF GETs.
//
// Several panes of the workspace mount at once and each reads the same route (the model catalog,
// the editor settings, a repository's branches, ...). Without a shared read every pane sends its own
// request, so one page load fans out into dozens of identical GETs. Both BFF transports (`fetchJson`
// in `api.ts`, `bffFetchJson` in `http.ts`) send their reads through `coalescedFetch`: a read that
// is identical to one still in flight joins it and receives a clone of its response.
//
// Only a read whose caller opted in joins (`shareInflight`): a deliberate refresh must read now.
// Even an opted-in read joins only when nothing about it is the caller's own:
//   - no caller-supplied abort signal (the joiner would inherit another caller's cancellation),
//   - no caller-named correlation id (that id must tie the caller's evidence to a server line, and
//     a joiner sends no request of its own).
// A state-changing request ends every join window when it starts and again when it settles, so a
// read issued after a write never receives a response that predates it.

import { CORRELATION_HEADER } from "./bff-correlation";

const inflight = new Map<string, Promise<Response>>();

export interface CoalescedReadOptions {
  /** `false` when the caller names its own correlation id or supplies its own abort signal. */
  readonly joinable: boolean;
}

/** Whether a read may join: the caller opted in and nothing about it is the caller's own. */
export function mayJoinInflightRead(request: {
  readonly shareInflight: boolean | undefined;
  readonly correlationId: string | undefined;
  readonly signal: AbortSignal | null | undefined;
}): boolean {
  return (
    request.shareInflight === true &&
    request.correlationId === undefined &&
    (request.signal ?? null) === null
  );
}

function isRead(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" && init?.body === undefined;
}

function readKey(path: string, init: RequestInit | undefined): string {
  const headers = [...new Headers(init?.headers).entries()]
    .filter(([name]) => name.toLowerCase() !== CORRELATION_HEADER.toLowerCase())
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([path, init?.cache ?? "", init?.credentials ?? "", headers]);
}

// A joiner and the first caller each read their own copy of the body. A fetch double without
// `clone` (a minimal test response) is handed out as is.
function copyOf(response: Response): Response {
  return typeof response.clone === "function" ? response.clone() : response;
}

/** Ends every join window; a request that may change server state calls it before and after. */
export function endInflightReads(): void {
  inflight.clear();
}

export function coalescedFetch(
  path: string,
  init: RequestInit | undefined,
  options: CoalescedReadOptions,
): Promise<Response> {
  if (!isRead(init)) {
    endInflightReads();
    const settle = (): void => {
      endInflightReads();
    };
    const write = Promise.resolve(fetch(path, init));
    write.then(settle, settle);
    return write;
  }
  if (!options.joinable) return Promise.resolve(fetch(path, init));
  const key = readKey(path, init);
  const shared = inflight.get(key);
  if (shared !== undefined) return shared.then(copyOf);
  const read = Promise.resolve(fetch(path, init));
  inflight.set(key, read);
  const settle = (): void => {
    if (inflight.get(key) === read) inflight.delete(key);
  };
  read.then(settle, settle);
  return read.then(copyOf);
}
