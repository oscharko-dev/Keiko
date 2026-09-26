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

import { readFileSync } from "node:fs";
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
import {
  formatRegisteredServerLogLine,
  listActivityLogFiles,
  serverLogProcessIdentity,
  type ServerLogEvent,
} from "@oscharko-dev/keiko-server/observability/server-log";

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

// The two channels a registered line reaches: the production file sink (a supported line of an
// active or degraded writer) and the emergency stderr notice the sink writes when it cannot persist
// (an incomplete line of an unavailable writer — never a file line).
type ProofChannel = "file-sink" | "stderr-notice";

function expectPersistedIdentity(
  proofId: string,
  op: string,
  record: Record<string, unknown>,
  channel: ProofChannel,
): void {
  const context = `Activity Log proof ${proofId} (${op})`;
  expect(record.schemaVersion, `${context}: schemaVersion`).toBe(2);
  expect(record.registryVersion, `${context}: registryVersion`).toBe(ACTIVITY_LOG_REGISTRY_VERSION);
  expect(record.schemaDigest, `${context}: schemaDigest`).toBe(ACTIVITY_LOG_SCHEMA_DIGEST);
  expect(record.catalogDigest, `${context}: catalogDigest`).toBe(ACTIVITY_LOG_CATALOG_DIGEST);
  expect(record.compatibilityState, `${context}: compatibilityState`).toBe(
    channel === "file-sink" ? "supported" : "incomplete",
  );
  if (channel === "stderr-notice") {
    expect(record.writerCapability, `${context}: writerCapability`).toBe("unavailable");
  }
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
  return expectRegisteredLine(proofId, line, "file-sink");
}

/**
 * Asserts that `line` is the emergency stderr notice the production sink writes when a line cannot
 * be persisted (`reportServerLogFailure`): this build's identity, an incomplete line of an
 * unavailable writer, and closed registered fields. Resolved by the generator like
 * `expectActivityLogProof`; `proofId` must be a string literal.
 */
export function expectActivityLogStderrProof(
  proofId: string,
  line: string,
): Record<string, unknown> {
  return expectRegisteredLine(proofId, line, "stderr-notice");
}

function expectRegisteredLine(
  proofId: string,
  line: string,
  channel: ProofChannel,
): Record<string, unknown> {
  const registration = registrationForProof(proofId);
  const record = parsePersistedLine(proofId, line);
  const context = `Activity Log proof ${proofId} (${registration.op})`;
  expectPersistedIdentity(proofId, registration.op, record, channel);
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

let proofLineSeq = 0;

/**
 * Serializes one event exactly as the production file sink does: `formatRegisteredServerLogLine`
 * revalidates the event's typed registration, its closed and bounded fields, and the complete v2
 * identity of this build before it formats a line. An event the real sink would refuse — an
 * unregistered plain object, a rejected field set, a registration that drifted from the generated
 * registry — throws here instead of becoming a proof line, so a package whose log port only hands
 * the test a captured event still proves what its production writer persists.
 */
export function formatActivityLogProofLine(event: object): string {
  proofLineSeq += 1;
  return formatRegisteredServerLogLine(event as ServerLogEvent, new Date(), {
    ...serverLogProcessIdentity(),
    seq: proofLineSeq,
  });
}

/**
 * Every persisted Activity Log line under `<stateDir>/logs`, read exactly as the production
 * reader enumerates the store: `listActivityLogFiles` applies the closed name grammar (log files
 * only, never pin records), the regular-file check, and the logical order (legacy files, then
 * segments by start, pid, instance and index). The fixture derives all of that from the production
 * entry point instead of restating it (AGENTS.md §7), so a proof never depends on how the log is
 * segmented. A file whose text does not end in a newline (a SIGKILLed writer's torn tail) is
 * terminated before the next file, so its fragment can never corrupt the next file's first record.
 */
export function readPersistedActivityLog(stateDir: string): string {
  return listActivityLogFiles(stateDir)
    .map((file) => {
      const text = readFileSync(file.path, "utf8");
      return text === "" || text.endsWith("\n") ? text : `${text}\n`;
    })
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
