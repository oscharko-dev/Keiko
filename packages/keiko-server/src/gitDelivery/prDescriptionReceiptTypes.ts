import type { PrDescriptionApplicationStatus } from "@oscharko-dev/keiko-contracts/runtime/pr-description-application";
import type { PrDescriptionContext } from "./prDescriptionTypes.js";

export type PrDescriptionReceiptRead =
  | { readonly ok: true; readonly version: null; readonly status?: never }
  | { readonly ok: true; readonly version: string; readonly status: PrDescriptionApplicationStatus }
  | { readonly ok: false; readonly reason: "storage-unavailable" | "receipt-conflict" };
export interface PrDescriptionReceiptStore {
  readStatus(context: PrDescriptionContext): PrDescriptionReceiptRead;
  recordStatus(
    context: PrDescriptionContext,
    status: PrDescriptionApplicationStatus,
    expectedVersion: string | null,
  ): PrDescriptionReceiptRead;
}
