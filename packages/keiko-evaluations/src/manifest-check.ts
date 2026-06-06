// Manifest validity predicate for the audit-completeness dimension (ADR-0012 D6). A run scores a
// pass only when it produced a well-formed, schema-versioned EvidenceManifest with every REQUIRED
// section present. This re-reads the persisted JSON (the store's serialized, redacted form) and
// asserts the structural invariants without trusting the in-memory builder. Pure string/JSON parsing.

import { EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-evidence";

const REQUIRED_TOP_LEVEL: readonly string[] = [
  "evidenceSchemaVersion",
  "run",
  "model",
  "usageTotals",
  "stateTransitions",
  "toolCalls",
  "commandExecutions",
];

const REQUIRED_RUN_FIELDS: readonly string[] = [
  "runId",
  "fingerprint",
  "harnessVersion",
  "taskType",
  "outcome",
  "startedAt",
  "finishedAt",
  "durationMs",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isManifestValid(rawJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || parsed.evidenceSchemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    return false;
  }
  if (!REQUIRED_TOP_LEVEL.every((key) => key in parsed)) {
    return false;
  }
  const run = parsed.run;
  if (!isRecord(run) || !REQUIRED_RUN_FIELDS.every((key) => key in run)) {
    return false;
  }
  const model = parsed.model;
  return isRecord(model) && typeof model.modelId === "string";
}
