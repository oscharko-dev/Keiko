"use client";
import type { CodingWorkbenchGatewayServiceRepairResponse } from "@oscharko-dev/keiko-contracts";
import { bffFetchJson } from "./http";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";

// The Workbench's Repair of the Windows runtime gateway (ADR-0043 D19). Windows asks the person
// for approval itself, so the request waits as long as that dialog is open, within the server's
// own bound.
const REPAIR_ROUTE = "/api/coding-workbench/runtime/gateway-service/repair";
const REPAIR_TIMEOUT_MS = 16 * 60_000;

export async function repairCodingGatewayService(): Promise<CodingWorkbenchGatewayServiceRepairResponse> {
  await codingAppSessionPairingSettled();
  return bffFetchJson(REPAIR_ROUTE, {
    method: "POST",
    body: "{}",
    signal: AbortSignal.timeout(REPAIR_TIMEOUT_MS),
  });
}
