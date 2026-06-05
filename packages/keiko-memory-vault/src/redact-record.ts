// Boundary redaction for memory records. Applies the caller-supplied redactString to every
// free-text field that may carry secret-shaped content. Keys redacted:
//   - body
//   - tags[]
//   - structured payload (string-list items / key-value entries)
//   - provenance.captureRationale
//   - staleReason
//   - retentionHint.notes
//   - edge.provenanceSummary
//   - tombstone.reason
//
// This is defence-in-depth, NOT a substitute for the capture-policy gate in #207. The contract
// validator runs FIRST (so we never persist a structurally bad record); redaction runs SECOND on
// the validator-approved record so the only string transformation between contract-valid input
// and SQL bind is this redact step.

import type {
  MemoryEdge,
  MemoryRecord,
  MemoryRetentionHint,
  MemoryStructuredPayload,
} from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryTombstone } from "./types.js";

type Redactor = (input: string) => string;

function redactPayload(
  payload: MemoryStructuredPayload,
  redact: Redactor,
): MemoryStructuredPayload {
  switch (payload.kind) {
    case "string-list":
      return { kind: "string-list", items: payload.items.map(redact) };
    case "key-value":
      return {
        kind: "key-value",
        entries: payload.entries.map((e) => ({ key: e.key, value: redact(e.value) })),
      };
  }
}

function redactRetentionHint(hint: MemoryRetentionHint, redact: Redactor): MemoryRetentionHint {
  const base: { policyKey: string; retainUntil?: number; notes?: string } = {
    policyKey: hint.policyKey,
  };
  if (hint.retainUntil !== undefined) base.retainUntil = hint.retainUntil;
  if (hint.notes !== undefined) base.notes = redact(hint.notes);
  return base;
}

export function redactMemoryRecord(record: MemoryRecord, redact: Redactor): MemoryRecord {
  const prov = record.provenance;
  const newProvenance: MemoryRecord["provenance"] = {
    ...prov,
    ...(prov.captureRationale !== undefined
      ? { captureRationale: redact(prov.captureRationale) }
      : {}),
  };
  const out: MemoryRecord = {
    ...record,
    body: redact(record.body),
    tags: record.tags.map(redact),
    provenance: newProvenance,
    ...(record.payload !== undefined ? { payload: redactPayload(record.payload, redact) } : {}),
    ...(record.staleReason !== undefined ? { staleReason: redact(record.staleReason) } : {}),
    ...(record.retentionHint !== undefined
      ? { retentionHint: redactRetentionHint(record.retentionHint, redact) }
      : {}),
  };
  return out;
}

export function redactMemoryEdge(edge: MemoryEdge, redact: Redactor): MemoryEdge {
  if (edge.provenanceSummary === undefined) return edge;
  return { ...edge, provenanceSummary: redact(edge.provenanceSummary) };
}

export function redactTombstone(t: MemoryTombstone, redact: Redactor): MemoryTombstone {
  if (t.reason === undefined) return t;
  return { ...t, reason: redact(t.reason) };
}
