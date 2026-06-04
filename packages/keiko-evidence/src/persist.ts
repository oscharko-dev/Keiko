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

import { isAbsolute, resolve } from "node:path";
import { buildEvidenceManifest } from "./build.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import { buildEvidenceReport, type EvidenceReport } from "./report.js";
import { applyRetention } from "./retention.js";
import { createNodeEvidenceStore, resolveEvidenceDir } from "./store.js";
import type {
  EvidenceBuildInput,
  EvidenceDeps,
  EvidenceManifest,
  RetentionPolicy,
} from "./types.js";
import { DEFAULT_RETENTION } from "./types.js";

export interface PersistResult {
  readonly manifest: EvidenceManifest;
  readonly location: string;
  readonly report: EvidenceReport;
}

function defaultEvidenceDir(input: EvidenceBuildInput, env: EvidenceDeps["env"]): string {
  const configured = resolveEvidenceDir(undefined, env);
  return isAbsolute(configured) ? configured : resolve(input.manifest.workingDirectory, configured);
}

export function persistEvidence(
  input: EvidenceBuildInput,
  deps: EvidenceDeps,
  retention: RetentionPolicy = DEFAULT_RETENTION,
): PersistResult {
  const env = deps.env ?? {};
  // The builder is already redacted-by-construction (incl. the deep-redact of embedded summaries);
  // re-apply the redactor over every string leaf here as IDEMPOTENT defense in depth, so a builder
  // bug that missed a field still cannot persist a secret.
  const manifest = buildEvidenceManifest(input, deps);
  const redact = createAuditRedactor(input.redaction ?? {}, env);
  const safeManifest = deepRedactStrings(manifest, redact) as EvidenceManifest;
  const json = JSON.stringify(safeManifest, null, 2);
  // C5/AC#6: with no explicit store, persist to the predictable local node store (resolved dir incl.
  // KEIKO_EVIDENCE_DIR), NOT an in-memory store that would silently discard the evidence. Tests
  // inject createInMemoryEvidenceStore explicitly so they never write to the repository tree.
  const store = deps.store ?? createNodeEvidenceStore(defaultEvidenceDir(input, deps.env));
  const location = store.put(safeManifest.run.runId, json);
  applyRetention(store, retention);
  return { manifest: safeManifest, location, report: buildEvidenceReport(safeManifest, location) };
}
