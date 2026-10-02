import { createHash } from "node:crypto";
import {
  defectFingerprintPreimage,
  type DefectFingerprintInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

/**
 * The deterministic, versioned defectFingerprint: SHA-256 over the canonical contract preimage.
 * Shared by the incident store that records it and the report reader that checks it, so neither
 * restates the formula.
 */
export function computeDefectFingerprint(input: DefectFingerprintInput): string {
  return createHash("sha256").update(defectFingerprintPreimage(input), "utf8").digest("hex");
}
