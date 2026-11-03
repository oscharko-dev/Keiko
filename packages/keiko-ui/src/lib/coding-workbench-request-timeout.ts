// A runtime request the Coding Workbench gave up on at its own client-side deadline (#4109). The BFF
// accepted it and never answered in time, so no server line can describe it. The report is a closed
// shape the server records at warn as `client.coding-workbench.request-timed-out`: the call kind and
// the deadline it ran out of, under the failed request's correlation id. A preempted request (Stop
// took its place) is not a timeout and is never reported through here.
import type { ClientCodingRuntimeCall } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "./client-diagnostics";

export function reportCodingWorkbenchRequestTimeout(
  call: ClientCodingRuntimeCall,
  deadlineMs: number,
  correlationId: string,
): void {
  reportClientDiagnostic(`[keiko] coding workbench request timed out: ${call}`, {
    codingRequestTimeout: { call, deadlineMs },
    correlationId,
  });
}
