// Validator-gate helpers. Wraps the contract validators from @oscharko-dev/keiko-contracts/memory
// in throw-on-failure form so the vault factory stays imperative. The structured failure list is
// preserved on the thrown MemoryStorageValidationError so the caller can branch on `.failures`.

import {
  validateMemoryEdge,
  validateMemoryRecord,
  validateMemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryEdge, MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { MemoryStorageValidationError, type MemoryStorageValidationFailure } from "./errors.js";
import { ALLOWED_EMBEDDING_METRICS, MAX_EMBEDDING_DIMENSIONS } from "./embeddings.js";
import type { DeleteMemoryOptions, MemoryEmbeddingInput } from "./types.js";

function toFailures(errors: readonly string[]): readonly MemoryStorageValidationFailure[] {
  return errors.map((message) => ({ path: [], message }));
}

export function gateMemoryRecord(record: MemoryRecord): MemoryRecord {
  const result = validateMemoryRecord(record);
  if (!result.ok) {
    throw new MemoryStorageValidationError("Invalid memory record.", toFailures(result.errors));
  }
  return result.value;
}

export function gateMemoryEdge(edge: MemoryEdge): MemoryEdge {
  const result = validateMemoryEdge(edge);
  if (!result.ok) {
    throw new MemoryStorageValidationError("Invalid memory edge.", toFailures(result.errors));
  }
  return result.value;
}

export function gateMemoryScope(scope: MemoryScope): MemoryScope {
  const result = validateMemoryScope(scope);
  if (!result.ok) {
    throw new MemoryStorageValidationError("Invalid memory scope.", toFailures(result.errors));
  }
  // validateMemoryScope's signature returns `MemoryValidation<undefined>` — it asserts shape but
  // does not narrow. The input has the type we promised so we return it directly.
  return scope;
}

function collectEmbeddingErrors(input: MemoryEmbeddingInput): readonly string[] {
  const errors: string[] = [];
  if (input.provider.length === 0) errors.push("embedding.provider must be non-empty");
  if (input.modelId.length === 0) errors.push("embedding.modelId must be non-empty");
  if (input.vector.length === 0) errors.push("embedding.vector must have at least one dimension");
  if (input.vector.length > MAX_EMBEDDING_DIMENSIONS) {
    errors.push(
      `embedding.vector length ${String(input.vector.length)} exceeds maximum ${String(MAX_EMBEDDING_DIMENSIONS)}`,
    );
  }
  if (!ALLOWED_EMBEDDING_METRICS.includes(input.metric)) {
    errors.push(`embedding.metric must be one of ${ALLOWED_EMBEDDING_METRICS.join("|")}`);
  }
  return errors;
}

export function gateEmbeddingInput(input: MemoryEmbeddingInput): MemoryEmbeddingInput {
  const errors = collectEmbeddingErrors(input);
  if (errors.length > 0) {
    throw new MemoryStorageValidationError("Invalid embedding input.", toFailures(errors));
  }
  return input;
}

export function gateDeleteOptions(options: DeleteMemoryOptions): DeleteMemoryOptions {
  const errors: string[] = [];
  if (options.forgetterSurface.length === 0) {
    errors.push("deleteOptions.forgetterSurface must be non-empty");
  }
  if (!Number.isFinite(options.nowMs) || options.nowMs < 0) {
    errors.push("deleteOptions.nowMs must be a finite non-negative number");
  }
  if (errors.length > 0) {
    throw new MemoryStorageValidationError("Invalid delete options.", toFailures(errors));
  }
  return options;
}
