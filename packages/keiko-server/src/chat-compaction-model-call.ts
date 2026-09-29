import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { CancelledError, TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";

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
