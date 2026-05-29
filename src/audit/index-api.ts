// Evidence index/list API (ADR-0010 D5). listEvidence enumerates and loadEvidence loads past runs
// reading ONLY the contained base dir via the EvidenceStore — never scanning arbitrary workspace
// files. Because the persisted JSON is redacted by construction (D3), the loaded data is
// redacted-by-construction: there is no un-redaction path. A manifest whose evidenceSchemaVersion is
// not a recognised version is reported with a typed error (D5), not silently coerced. This is the
// #13 UI seam.

import type { RunOutcome, TaskType } from "../harness/types.js";
import { EvidenceReadError, EvidenceSchemaError } from "./errors.js";
import type { EvidenceStore } from "./store.js";
import type { EvidenceManifest } from "./types.js";
import { EVIDENCE_SCHEMA_VERSION } from "./types.js";

export interface EvidenceListEntry {
  readonly runId: string;
  readonly taskType: TaskType;
  readonly outcome: RunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
}

// Parses raw JSON and verifies the schema version before trusting the shape. We narrow on the
// version discriminant exactly as harness consumers narrow on the event schemaVersion (D2).
// JSON.parse can throw a raw SyntaxError on a truncated/hand-edited manifest; the parse is a system
// boundary (reading developer-writable files), so catching it and re-throwing a typed AuditError is
// correct — the CLI maps AuditError to an exit code instead of leaking an unhandled stack (C1).
function parseJson(json: string, runId: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new EvidenceReadError(`evidence manifest is not valid JSON: ${runId}`);
  }
}

function parseManifest(json: string, runId: string): EvidenceManifest {
  const parsed: unknown = parseJson(json, runId);
  if (typeof parsed !== "object" || parsed === null) {
    throw new EvidenceSchemaError(`evidence manifest is not an object: ${runId}`, "none");
  }
  const version = (parsed as { readonly evidenceSchemaVersion?: unknown }).evidenceSchemaVersion;
  if (version !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceSchemaError(
      `unrecognised evidence schema version for ${runId}`,
      typeof version === "string" ? version : "none",
    );
  }
  return parsed as EvidenceManifest;
}

function toListEntry(manifest: EvidenceManifest): EvidenceListEntry {
  return {
    runId: manifest.run.runId,
    taskType: manifest.run.taskType,
    outcome: manifest.run.outcome,
    startedAt: manifest.run.startedAt,
    finishedAt: manifest.run.finishedAt,
  };
}

export function listEvidence(store: EvidenceStore): readonly EvidenceListEntry[] {
  const entries: EvidenceListEntry[] = [];
  for (const runId of store.list()) {
    const json = store.get(runId);
    if (json === undefined) {
      continue;
    }
    entries.push(toListEntry(parseManifest(json, runId)));
  }
  return entries;
}

export function loadEvidence(store: EvidenceStore, runId: string): EvidenceManifest | undefined {
  const json = store.get(runId);
  if (json === undefined) {
    return undefined;
  }
  return parseManifest(json, runId);
}
