import {
  evaluateMemorySuppression,
  type MemoryRecord,
  type MemorySuppressionResult,
} from "@oscharko-dev/keiko-contracts/memory";
import { GovernanceError } from "./errors.js";

export type {
  MemorySuppressionReason as SuppressionReason,
  MemorySuppressionResult as SuppressionResult,
} from "@oscharko-dev/keiko-contracts/memory";

export interface SuppressionOptions {
  readonly staleConfidenceThreshold?: number;
}

export function isMemorySuppressedFromRetrieval(
  memory: MemoryRecord,
  nowMs: number,
  options: SuppressionOptions = {},
): MemorySuppressionResult {
  const staleConfidenceThreshold = options.staleConfidenceThreshold ?? 0.3;
  const result = evaluateMemorySuppression(memory, nowMs, staleConfidenceThreshold);
  if (result !== "invalid-threshold") return result;
  throw new GovernanceError(
    "invalid-threshold",
    `staleConfidenceThreshold must be a finite number in [0, 1] (got ${String(staleConfidenceThreshold)})`,
  );
}
