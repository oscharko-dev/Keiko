// Re-exported product version. The authoritative source is KEIKO_PRODUCT_VERSION in
// @oscharko-dev/keiko-contracts. SDK_VERSION is surfaced by the local BFF in healthcheck
// route responses. After issue #426 the legacy src shims were deleted, so the deep
// re-export risk that originally motivated a duplicate literal no longer applies.
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";
export const SDK_VERSION: string = KEIKO_PRODUCT_VERSION;
