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
/**
 * Adapts a `PrDescriptionReceiptStore` (expected-version compare-and-swap) to the plain
 * `recordStatus`/`readStatus` hook shape `PrDescriptionServiceOptions` accepts, so the durable
 * receipt store can back the application service without either side depending on the other's
 * full type. Matches `PrDescriptionServiceOptions["recordStatus"]`/`["readStatus"]` structurally.
 */
export interface PrDescriptionReceiptStatusHooks {
  readonly recordStatus: (
    context: PrDescriptionContext,
    status: PrDescriptionApplicationStatus,
  ) => boolean;
  readonly readStatus: (
    context: PrDescriptionContext,
  ) => PrDescriptionApplicationStatus | undefined;
}
