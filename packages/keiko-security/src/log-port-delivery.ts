// Security owns injected runtime port execution; contracts retains the bounded loss ledger.
import { recordActivityLogLoss } from "@oscharko-dev/keiko-contracts/runtime/observability";

/** Counts a lost synchronous port delivery before invoking its owning failure reporter. */
export function writeActivityLogPortEvent<
  Event,
  Sink extends { readonly write: (event: Event) => void },
>(
  sink: Sink | undefined,
  event: Event,
  onFailure: (sink: Sink, event: Event, cause: unknown) => void,
): void {
  if (sink === undefined) {
    recordActivityLogLoss("port-unwired");
    return;
  }
  try {
    sink.write(event);
  } catch (cause) {
    recordActivityLogLoss("port-sink-failed");
    onFailure(sink, event, cause);
  }
}
