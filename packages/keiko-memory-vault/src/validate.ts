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
