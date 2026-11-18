import {
  evaluateMemorySuppression,
  type MemoryRecord,
  type MemorySuppressionResult,
} from "@oscharko-dev/keiko-contracts/memory";
import { RetrievalError } from "./errors.js";

export type {
  MemorySuppressionReason as SuppressionReason,
  MemorySuppressionResult as SuppressionResult,
} from "@oscharko-dev/keiko-contracts/memory";

export function isMemorySuppressed(
  memory: MemoryRecord,
  nowMs: number,
  staleConfidenceThreshold: number,
): MemorySuppressionResult {
  const result = evaluateMemorySuppression(memory, nowMs, staleConfidenceThreshold);
  if (result !== "invalid-threshold") return result;
  throw new RetrievalError(
    "invalid-threshold",
    `staleConfidenceThreshold must be a finite number in [0, 1] (got ${String(staleConfidenceThreshold)})`,
  );
}
