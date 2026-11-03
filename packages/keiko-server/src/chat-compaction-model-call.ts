import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { CancelledError, TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";
import { depsRoot } from "./request-deps-root.js";

interface ScopedCompactionWork {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface CompactionWorkScope {
  stopped: boolean;
  readonly pending: Set<ScopedCompactionWork>;
}

const compactionWorkScopes = new WeakMap<object, CompactionWorkScope>();

function compactionScope(scope: object): CompactionWorkScope {
  const root = depsRoot(scope);
  let state = compactionWorkScopes.get(root);
  if (state === undefined) {
    state = { stopped: false, pending: new Set() };
    compactionWorkScopes.set(root, state);
  }
  return state;
}

export function chatCompactionWorkStopped(scope: object): boolean {
  return compactionWorkScopes.get(depsRoot(scope))?.stopped === true;
}

/** Keep detached summaries inside the handler graph's existing disposal lifecycle. */
export function beginChatCompactionWork(
  scope: object,
): { readonly signal: AbortSignal; readonly finish: () => void } | undefined {
  const state = compactionScope(scope);
  if (state.stopped) return undefined;
  let complete = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const work = { controller: new AbortController(), done };
  state.pending.add(work);
  return {
    signal: work.controller.signal,
    finish: (): void => {
      state.pending.delete(work);
      complete();
    },
  };
}

export async function stopChatCompactionWork(scope: object): Promise<void> {
  const state = compactionScope(scope);
  state.stopped = true;
  const pending = [...state.pending];
  for (const work of pending) work.controller.abort();
  await Promise.all(pending.map((work) => work.done));
}

/** Bound both background continuity and foreground prompt summarization, including stalled ports. */
export async function callChatCompactionModel(
  call: ModelPort["call"],
  request: GatewayCallRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<NormalizedResponse> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = (): void => {
      controller.abort();
      reject(new CancelledError("Chat compaction was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError("Chat compaction exceeded its time budget."));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([call(request, controller.signal), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel !== undefined) signal.removeEventListener("abort", cancel);
  }
}
