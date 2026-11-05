import type { MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
import { validateMemoryRecord } from "@oscharko-dev/keiko-contracts/runtime/memory";

// The vault's caller gate (`gateMemoryRecord`, which runs `validateMemoryRecord`) and its
// physical write capture each read `validity.validUntil`. These helpers reach the physical
// capture with input the caller gate admitted, the only window in which the two can disagree
// (#3918, REVIEW-3918-057). The gate's read count comes from the production validator itself.

const ADMITTED_VALID_UNTIL = 1_800_000_000_000;

function validatorValidUntilReads(record: MemoryRecord): number {
  let reads = 0;
  const validity = { validFrom: record.validity.validFrom };
  Object.defineProperty(validity, "validUntil", {
    enumerable: true,
    get: (): number => {
      reads += 1;
      return ADMITTED_VALID_UNTIL;
    },
  });
  validateMemoryRecord({ ...record, validity });
  return reads;
}

// A validity whose `validUntil` answers the caller gate's reads with an admitted value and every
// later read, the physical capture's, through `later`.
export function validityChangingAfterGate(
  record: MemoryRecord,
  later: () => number,
): MemoryRecord["validity"] {
  const gateReads = validatorValidUntilReads(record);
  let reads = 0;
  const validity = { validFrom: record.validity.validFrom };
  Object.defineProperty(validity, "validUntil", {
    enumerable: true,
    get: (): number => {
      reads += 1;
      return reads <= gateReads ? ADMITTED_VALID_UNTIL : later();
    },
  });
  return validity;
}

// A record that the caller gate admits and whose physical capture then reads an invalid
// `validUntil`, so the physical admission refuses it.
export function invalidAfterGateRecord(record: MemoryRecord): MemoryRecord {
  return { ...record, validity: validityChangingAfterGate(record, () => -1) };
}
