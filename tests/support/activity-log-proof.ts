// Registry-linked executable proofs for the Activity Log (#3532).
//
// Every registered operation declares proof ids (`defineActivityLogOperation({ proofIds })`). A
// proof id RESOLVES when a test in the repository calls
//
//   expectActivityLogProof("<proof id>", persistedLine)
//
// with a literal id — `scripts/generate-op-catalog.mjs` discovers those calls from the test sources
// and reports every registered proof id that has none. What the call asserts is what makes the proof
// executable rather than documentary:
//
//   * `line` is ONE persisted line as the production file sink writes it — a JSON record carrying
//     the complete v2 identity envelope (schema/registry versions and digests of THIS build, the
//     product version, pid, instance id and seq). An event object, a buffered test-sink record or a
//     formatter call without identity cannot satisfy it, so a capture-only proof is impossible: the
//     line must have passed the real formatter's identity and registration validation;
//   * the line's operation is the operation that owns `proofId`, in its registered category;
//   * a causal operation carries a correlation id;
//   * every persisted field is declared by the registration and satisfies its closed contract.
//
// Failure messages name the proof id, the operation and the missing evidence — never a field value.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
  ACTIVITY_LOG_CATALOG_DIGEST,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  ACTIVITY_LOG_REGISTRY_VERSION,
  ACTIVITY_LOG_SCHEMA_DIGEST,
  isActivityLogInstanceId,
  isActivityLogProcessId,
  isActivityLogSequence,
  validateActivityLogOperationFields,
  type ActivityLogOperationRegistration,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

// Envelope and identity members of a persisted line; everything else is a registered field.
const PERSISTED_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "ts",
  "schemaVersion",
  "registryVersion",
  "schemaDigest",
  "catalogDigest",
  "buildClass",
  "releaseClass",
  "platformClass",
  "productVersion",
  "compatibilityState",
  "writerCapability",
  "pid",
  "instanceId",
  "seq",
  "level",
  "category",
  "op",
  "correlationId",
  "parentCorrelationId",
  "durationMs",
  "status",
  "errorKind",
]);

function registrationForProof(proofId: string): ActivityLogOperationRegistration {
  const registration = (
    ACTIVITY_LOG_OPERATION_REGISTRY as readonly ActivityLogOperationRegistration[]
  ).find((candidate) => candidate.proofIds.includes(proofId));
  if (registration === undefined) {
    throw new Error(`Activity Log proof ${proofId} is not declared by any registered operation.`);
  }
  return registration;
}

function parsePersistedLine(proofId: string, line: string): Record<string, unknown> {
  const text = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (text.length === 0 || text.includes("\n")) {
    throw new Error(`Activity Log proof ${proofId} needs exactly one persisted line.`);
  }
  const record: unknown = JSON.parse(text);
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error(`Activity Log proof ${proofId} line is not a persisted record.`);
  }
  return record as Record<string, unknown>;
}

// An envelope member is a field only when the registration itself declares a field of that name
// (the diagnostic record declares `parentCorrelationId`, for example).
function persistedFields(
  record: Record<string, unknown>,
  registration: ActivityLogOperationRegistration,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([name]) => !PERSISTED_ENVELOPE_KEYS.has(name) || registration.fields[name] !== undefined,
    ),
  );
}

function expectPersistedIdentity(
  proofId: string,
  op: string,
  record: Record<string, unknown>,
): void {
  const context = `Activity Log proof ${proofId} (${op})`;
  expect(record.schemaVersion, `${context}: schemaVersion`).toBe(2);
  expect(record.registryVersion, `${context}: registryVersion`).toBe(ACTIVITY_LOG_REGISTRY_VERSION);
  expect(record.schemaDigest, `${context}: schemaDigest`).toBe(ACTIVITY_LOG_SCHEMA_DIGEST);
  expect(record.catalogDigest, `${context}: catalogDigest`).toBe(ACTIVITY_LOG_CATALOG_DIGEST);
  expect(record.compatibilityState, `${context}: compatibilityState`).toBe("supported");
  expect(isActivityLogProcessId(record.pid), `${context}: pid`).toBe(true);
  expect(isActivityLogInstanceId(record.instanceId), `${context}: instanceId`).toBe(true);
  expect(isActivityLogSequence(record.seq), `${context}: seq`).toBe(true);
}

/**
 * Asserts that `line` is a production-persisted Activity Log line for the operation owning
 * `proofId` and returns the parsed record for the test's own evidence assertions. `proofId` must be
 * a string literal at the call site: the op-catalog generator resolves proofs from those literals.
 */
export function expectActivityLogProof(proofId: string, line: string): Record<string, unknown> {
  const registration = registrationForProof(proofId);
  const record = parsePersistedLine(proofId, line);
  const context = `Activity Log proof ${proofId} (${registration.op})`;
  expectPersistedIdentity(proofId, registration.op, record);
  expect(record.op, `${context}: op`).toBe(registration.op);
  expect(record.category, `${context}: category`).toBe(registration.category);
  if (registration.causal !== "none") {
    expect(typeof record.correlationId, `${context}: correlationId`).toBe("string");
  }
  expect(() => {
    validateActivityLogOperationFields(
      registration.op,
      registration.category,
      persistedFields(record, registration),
    );
  }, `${context}: registered fields`).not.toThrow();
  return record;
}

/**
 * Every persisted Activity Log line under `<stateDir>/logs`, file by file in name order. Reads the
 * whole directory rather than one file name, so a proof never depends on how the log is segmented.
 */
export function readPersistedActivityLog(stateDir: string): string {
  const directory = join(stateDir, "logs");
  return [...readdirSync(directory)]
    .sort((left, right) => (left < right ? -1 : 1))
    .filter((name) => lstatSync(join(directory, name)).isFile())
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("");
}

/** The persisted lines of a raw Activity Log file whose `op` is `op`, in file order. */
export function persistedActivityLogLines(raw: string, op: string): readonly string[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => {
      try {
        return (JSON.parse(line) as { readonly op?: unknown }).op === op;
      } catch {
        return false;
      }
    });
}
