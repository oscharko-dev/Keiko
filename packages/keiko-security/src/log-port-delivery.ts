// Security owns injected runtime port execution; contracts retains the bounded loss ledger.
import { recordActivityLogLoss } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { sha256Hex } from "./hashing.js";
import { reportActivityLogPortWarning, securityErrorKind } from "./log-port.js";

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

/** Reports one failed sink per caller-owned state without counting its notice as another loss. */
export function reportActivityLogPortFailure<
  Event,
  Sink extends { readonly write: (event: Event) => void },
>(
  sink: Sink,
  droppedOp: string,
  cause: unknown,
  reportedSinks: WeakSet<Sink>,
  produceNotice: (droppedOpDigest: string, errorKind: string) => Event,
): void {
  if (reportedSinks.has(sink)) return;
  reportedSinks.add(sink);
  const errorKind = securityErrorKind(cause);
  const droppedOpDigest = sha256Hex(droppedOp).slice(0, 16);
  try {
    sink.write(produceNotice(droppedOpDigest, errorKind));
  } catch {
    reportActivityLogPortWarning(droppedOpDigest, errorKind);
  }
}
