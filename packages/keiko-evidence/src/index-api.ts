// Evidence index/list API (ADR-0010 D5). listEvidence enumerates and loadEvidence loads past runs
// reading ONLY the contained base dir via the EvidenceStore — never scanning arbitrary workspace
// files. Because the persisted JSON is redacted by construction (D3), the loaded data is
// redacted-by-construction: there is no un-redaction path. A manifest whose evidenceSchemaVersion is
// not a recognised version is reported with a typed error (D5), not silently coerced. This is the
// #13 UI seam.

import type { RunOutcome } from "@oscharko-dev/keiko-contracts";
import { EvidenceReadError, EvidenceSchemaError } from "./errors.js";
import type { EvidenceStore } from "./store.js";
import type { EvidenceManifest, EvidenceTaskType } from "./types.js";
import { EVIDENCE_SCHEMA_VERSION } from "./types.js";

export interface EvidenceListEntry {
  readonly runId: string;
  readonly taskType: EvidenceTaskType;
  readonly outcome: RunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly modelId: string;
  readonly workspaceRoot?: string | undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  parent: Record<string, unknown>,
  key: string,
  runId: string,
): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new EvidenceSchemaError(
      `evidence manifest is missing object field ${key}: ${runId}`,
      "1",
    );
  }
  return value;
}

function requireArray(parent: Record<string, unknown>, key: string, runId: string): void {
  if (!Array.isArray(parent[key])) {
    throw new EvidenceSchemaError(`evidence manifest is missing array field ${key}: ${runId}`, "1");
  }
}

function requireString(parent: Record<string, unknown>, key: string, runId: string): void {
  if (typeof parent[key] !== "string") {
    throw new EvidenceSchemaError(
      `evidence manifest is missing string field ${key}: ${runId}`,
      "1",
    );
  }
}

function requireNumber(parent: Record<string, unknown>, key: string, runId: string): void {
  if (typeof parent[key] !== "number" || !Number.isFinite(parent[key])) {
    throw new EvidenceSchemaError(
      `evidence manifest is missing numeric field ${key}: ${runId}`,
      "1",
    );
  }
}

function requireOptionalRecord(parent: Record<string, unknown>, key: string, runId: string): void {
  const value = parent[key];
  if (value !== undefined && !isRecord(value)) {
    throw new EvidenceSchemaError(
      `evidence manifest has invalid object field ${key}: ${runId}`,
      "1",
    );
  }
}

function requireOptionalArray(parent: Record<string, unknown>, key: string, runId: string): void {
  const value = parent[key];
  if (value !== undefined && !Array.isArray(value)) {
    throw new EvidenceSchemaError(
      `evidence manifest has invalid array field ${key}: ${runId}`,
      "1",
    );
  }
}

function validateManifestShape(parsed: Record<string, unknown>, runId: string): void {
  const run = requireRecord(parsed, "run", runId);
  requireString(run, "runId", runId);
  requireString(run, "fingerprint", runId);
  requireString(run, "harnessVersion", runId);
  requireString(run, "taskType", runId);
  requireString(run, "outcome", runId);
  requireNumber(run, "startedAt", runId);
  requireNumber(run, "finishedAt", runId);
  requireNumber(run, "durationMs", runId);
  const model = requireRecord(parsed, "model", runId);
  requireString(model, "modelId", runId);
  requireString(model, "costClass", runId);
  const usage = requireRecord(parsed, "usageTotals", runId);
  requireNumber(usage, "promptTokens", runId);
  requireNumber(usage, "completionTokens", runId);
  requireNumber(usage, "requestCount", runId);
  requireNumber(usage, "totalLatencyMs", runId);
  requireArray(parsed, "stateTransitions", runId);
  requireArray(parsed, "toolCalls", runId);
  requireArray(parsed, "commandExecutions", runId);
  requireOptionalArray(parsed, "sandboxConfigurations", runId);
  requireOptionalArray(parsed, "verificationResults", runId);
  requireOptionalArray(parsed, "reasoning", runId);
  requireOptionalRecord(parsed, "context", runId);
  requireOptionalRecord(parsed, "patch", runId);
  requireOptionalRecord(parsed, "verification", runId);
  requireOptionalRecord(parsed, "failure", runId);
  requireOptionalRecord(parsed, "browser", runId);
  requireOptionalRecord(parsed, "connectedContext", runId);
  requireOptionalRecord(parsed, "contextAssembly", runId);
  requireOptionalArray(parsed, "compaction", runId);
}

// Validates an ALREADY-parsed manifest value (schema version + shape) and narrows it to
// EvidenceManifest. Split out from parseManifest so a caller that already parsed the JSON for its
// own purposes (listEntryOrSkip's evidenceSchemaVersion pre-check) can reuse that parse instead of
// paying for a second JSON.parse of the same string (KEIKO-0945).
function manifestFromParsed(parsed: Record<string, unknown>, runId: string): EvidenceManifest {
  const version = parsed.evidenceSchemaVersion;
  if (version !== EVIDENCE_SCHEMA_VERSION) {
    throw new EvidenceSchemaError(
      `unrecognised evidence schema version for ${runId}`,
      typeof version === "string" ? version : "none",
    );
  }
  validateManifestShape(parsed, runId);
  return parsed as unknown as EvidenceManifest;
}

function parseManifest(json: string, runId: string): EvidenceManifest {
  const parsed: unknown = parseJson(json, runId);
  if (!isRecord(parsed)) {
    throw new EvidenceSchemaError(`evidence manifest is not an object: ${runId}`, "none");
  }
  return manifestFromParsed(parsed, runId);
}

function toListEntry(manifest: EvidenceManifest): EvidenceListEntry {
  return {
    runId: manifest.run.runId,
    taskType: manifest.run.taskType,
    outcome: manifest.run.outcome,
    startedAt: manifest.run.startedAt,
    finishedAt: manifest.run.finishedAt,
    modelId: manifest.model.modelId,
    ...(manifest.context?.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: manifest.context.workspaceRoot }),
  };
}

// Enumeration is a per-entry question ("which runs can I show?"), so one unreadable, legacy or
// shape-invalid manifest is skipped instead of aborting the walk — a single restored backup,
// truncated write, or the first schema bump would otherwise blank the whole audit ledger. This
// covers BOTH failure shapes: `store.get` itself can throw EvidenceReadError for a genuine
// filesystem fault (e.g. an EACCES/read race on the node store), not only a value that reads
// successfully but fails to parse or validate. Any OTHER error still propagates: the list fails
// closed rather than passing a partial answer off as a complete one. loadEvidence keeps throwing,
// because one manifest is its whole answer.
function listEntryOrSkip(store: EvidenceStore, runId: string): EvidenceListEntry | undefined {
  try {
    const json = store.get(runId);
    if (json === undefined) {
      return undefined;
    }
    const parsed: unknown = parseJson(json, runId);
    if (!isRecord(parsed) || typeof parsed.evidenceSchemaVersion !== "string") {
      return undefined;
    }
    return toListEntry(manifestFromParsed(parsed, runId));
  } catch (error) {
    if (error instanceof EvidenceReadError || error instanceof EvidenceSchemaError) {
      return undefined;
    }
    throw error;
  }
}

export function listEvidence(store: EvidenceStore): readonly EvidenceListEntry[] {
  const entries: EvidenceListEntry[] = [];
  for (const runId of store.list()) {
    const entry = listEntryOrSkip(store, runId);
    if (entry !== undefined) {
      entries.push(entry);
    }
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
