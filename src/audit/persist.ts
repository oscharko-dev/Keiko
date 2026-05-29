// Top-level orchestration (ADR-0010 D11, D9): build -> deep re-redact (defense in depth) ->
// store.put -> applyRetention -> buildEvidenceReport. This is the single entry the CLI and the SDK
// call to write evidence. It is the supported SDK persist entry (the harness is NOT modified — the
// reuse-unchanged rule is absolute; AC #6 "SDK runs write evidence" is satisfied here and at the CLI
// layer, not by editing runAgent).
//
// Defense-in-depth redaction (coordinator refinement, replacing the ADR's serialized-string pass):
// the builder is redacted-by-construction (primary), and this layer re-applies the redactor to EVERY
// STRING LEAF of the assembled manifest object via a generic deep walk BEFORE JSON.stringify. This is
// idempotent and cannot break JSON structure (a serialized-string re-redaction could miss
// JSON-escaped secrets and risk corrupting the document). It catches a secret smuggled in through a
// verbatim-embedded summary (context/verification) that the builder does not itself redact.

import { buildEvidenceManifest } from "./build.js";
import { createAuditRedactor } from "./redaction.js";
import { buildEvidenceReport, type EvidenceReport } from "./report.js";
import { applyRetention } from "./retention.js";
import { createInMemoryEvidenceStore } from "./store.js";
import type {
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceManifest,
  RetentionPolicy,
} from "./types.js";
import { DEFAULT_RETENTION } from "./types.js";

type Redactor = (input: string) => string;

// Recursively re-redacts every string leaf, rebuilding arrays/objects so the input is never mutated
// and the JSON structure is preserved exactly. Bounded by the manifest's (finite) nesting depth.
function deepRedact(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, redact));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepRedact(child, redact);
    }
    return out;
  }
  return value;
}

export interface PersistResult {
  readonly manifest: EvidenceManifest;
  readonly location: string;
  readonly report: EvidenceReport;
}

export function persistEvidence(
  input: EvidenceBuildInput,
  deps: EvidenceDeps,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): PersistResult {
  const env = deps.env ?? {};
  const manifest = buildEvidenceManifest(input, deps);
  const redact = createAuditRedactor(input.redaction ?? {}, env);
  const safeManifest = deepRedact(manifest, redact) as EvidenceManifest;
  const json = JSON.stringify(safeManifest, null, 2);
  const store = deps.store ?? createInMemoryEvidenceStore();
  const location = store.put(safeManifest.run.runId, json);
  applyRetention(store, retention);
  return { manifest: safeManifest, location, report: buildEvidenceReport(safeManifest, location) };
}
