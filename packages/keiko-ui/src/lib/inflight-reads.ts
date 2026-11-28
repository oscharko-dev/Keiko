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

/**
 * Ends every join window; a request that may change server state calls it before and after. A
 * healthy read still in flight keeps its joiners and its lifetime timer: it settles on its own,
 * and its joiners must not each send a duplicate GET at every write (nor a replacement that could
 * race the write and return data that predates it). Only a read that has already outlived
 * `INFLIGHT_READ_MAX_MS` (truly hung) is evicted now, so its joiners are freed at once and share one
 * replacement read, which begins after the write.
 */
export function endInflightReads(): void {
  const ended = [...sharedReads.values()];
  sharedReads.clear();
  for (const entry of ended) {
    if (Date.now() - entry.startedAt < INFLIGHT_READ_MAX_MS) continue;
    clearTimeout(entry.timer);
    entry.evict();
  }
}

/**
 * How long a shared read may stay joinable (U-45). A read that never settles (a request the BFF
 * accepted and never answered) used to keep its entry for good, so every later identical read
 * joined it and no request ever reached the network again. After this bound the entry is evicted
 * and the joiners still waiting start ONE replacement read between them (the first to expire
 * starts it, the others join it), so a hung server sees one duplicate request, not one per joiner.
 * The bound evicts; it does not abort the request: a caller that opts in must also carry its own
 * deadline or signal on the read (a read with its own signal is never shared at all), or the hung
 * request itself stays open.
 */
export const INFLIGHT_READ_MAX_MS = 15_000;

interface SharedRead {
  readonly response: Promise<Response>;
  readonly expired: Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  /** When the read began; a read older than `INFLIGHT_READ_MAX_MS` is hung. */
  readonly startedAt: number;
  /** Resolves `expired` now, ahead of the timer. */
  readonly evict: () => void;
}

const sharedReads = new Map<string, SharedRead>();

function share(key: string, read: Promise<Response>): void {
  let evict: () => void = () => undefined;
  const expired = new Promise<void>((resolve) => {
    evict = resolve;
  });
  const timer = setTimeout(evict, INFLIGHT_READ_MAX_MS);
  const entry: SharedRead = { response: read, expired, timer, evict, startedAt: Date.now() };
  sharedReads.set(key, entry);
  const release = (): void => {
    clearTimeout(timer);
    if (sharedReads.get(key) === entry) sharedReads.delete(key);
  };
  read.then(release, release);
  void expired.then(release);
}

// The read a joiner starts once the one it joined has outlived its bound: the first joiner to
// expire starts it and shares it, every later one joins that replacement.
function replacementRead(
  key: string,
  path: string,
  init: RequestInit | undefined,
): Promise<Response> {
  const current = sharedReads.get(key);
  if (current !== undefined) return joinSharedRead(key, path, init, current);
  const read = Promise.resolve(fetch(path, init));
  share(key, read);
  return read.then(copyOf);
}

// A joiner waits for the shared read, but never longer than that read may live. Whichever side
// loses the race is ignored: a response that settles after the bound is never cloned for nobody.
function joinSharedRead(
  key: string,
  path: string,
  init: RequestInit | undefined,
  shared: SharedRead,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    shared.response.then(
      (response) => {
        if (settled) return;
        settled = true;
        resolve(copyOf(response));
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    void shared.expired.then(async () => {
      if (settled) return;
      settled = true;
      try {
        resolve(await replacementRead(key, path, init));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
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
  const shared = sharedReads.get(key);
  if (shared !== undefined) return joinSharedRead(key, path, init, shared);
  const read = Promise.resolve(fetch(path, init));
  share(key, read);
  return read.then(copyOf);
}
