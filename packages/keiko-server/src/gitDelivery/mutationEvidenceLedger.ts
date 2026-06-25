// Governed Git mutation EVIDENCE ledger (Issue #474, Epic #470).
//
// The durable, bounded, append-only sink the #472 orchestrator's idempotency-journal comment
// anticipates ("a durable journal — the evidence ledger, #474"). It records the content-free
// GitDeliveryEvidenceRecord produced by the keiko-tools builder for EVERY terminal outcome of a
// governed Git mutation — succeeded, blocked, rejected, failed, recovery-required, or held for
// approval — so a governance decision is auditable even when no mutation executed.
//
// Persistence shape: ONE ledger document per UTC date bucket (runId `git-delivery-evidence-YYYY-MM-DD`),
// mirroring memory-audit-handler.ts. Stores that expose EvidenceStore.update() serialize the
// read-append-write step so concurrent appenders never drop a record; stores without it fall back to
// get+put. The bucket is bounded to the most recent N records so a long-lived ledger cannot grow
// without limit.
//
// Redaction: each record is run through deepRedactStrings before it is serialized (defence-in-depth on
// top of the builder's by-construction content-free hashing). Persistence failures are caught and
// reported through an injectable sink; an audit-write failure must NEVER break the user's mutation.
// Corrupt ledger documents are never reset or overwritten — an append against a corrupt bucket fails
// closed and preserves the existing artifact for operator investigation.

import type { GitDeliveryEvidenceRecord } from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";

export const GIT_DELIVERY_EVIDENCE_RUNID_PREFIX = "git-delivery-evidence-" as const;

// Default bound on records retained per UTC date bucket. The most recent records are kept.
export const GIT_DELIVERY_EVIDENCE_DEFAULT_BUCKET_CAP = 500;

export interface GitDeliveryEvidenceLedgerDoc {
  readonly schemaVersion: typeof GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION;
  readonly records: readonly GitDeliveryEvidenceRecord[];
}

// UTC date-bucket runId. 22 chars (`git-delivery-evidence-` is 22) + 10 (`YYYY-MM-DD`) = 32, well
// under the evidence-store run-id length cap.
export function gitDeliveryEvidenceRunIdFor(nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `${GIT_DELIVERY_EVIDENCE_RUNID_PREFIX}${iso.slice(0, 10)}`;
}

export interface RecordGitDeliveryEvidenceOptions {
  readonly evidenceStore: EvidenceStore;
  // String-leaf redactor (deps.redactString / the audit redactor). Defence-in-depth over the
  // builder's by-construction hashing.
  readonly redactString: (input: string) => string;
  readonly maxRecordsPerBucket?: number | undefined;
  // Persistence-error sink; defaults to console.error. An audit-write failure never throws here.
  readonly onPersistError?: ((error: unknown) => void) | undefined;
}

function defaultOnPersistError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error("git-delivery evidence ledger: persistence failed", error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses an existing bucket document. Returns the records faithfully (they were written valid).
// Throws on gross corruption so the caller fails closed and preserves the artifact.
function parseExistingRecords(json: string | undefined): readonly GitDeliveryEvidenceRecord[] {
  if (json === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      "git-delivery evidence ledger is corrupt; refusing to overwrite existing audit evidence",
      { cause: error },
    );
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
    throw new Error(
      "git-delivery evidence ledger has an unexpected shape; refusing to overwrite existing audit evidence",
    );
  }
  return parsed.records as readonly GitDeliveryEvidenceRecord[];
}

function boundedDoc(
  existing: readonly GitDeliveryEvidenceRecord[],
  record: GitDeliveryEvidenceRecord,
  cap: number,
): GitDeliveryEvidenceLedgerDoc {
  const records = [...existing, record];
  return {
    schemaVersion: GIT_DELIVERY_EVIDENCE_SCHEMA_VERSION,
    records: cap > 0 && records.length > cap ? records.slice(records.length - cap) : records,
  };
}

function appendRecord(
  store: EvidenceStore,
  runId: string,
  record: GitDeliveryEvidenceRecord,
  cap: number,
): void {
  const append = (existingJson: string | undefined): string =>
    JSON.stringify(boundedDoc(parseExistingRecords(existingJson), record, cap));
  if (store.update !== undefined) {
    store.update(runId, append);
    return;
  }
  store.put(runId, append(store.get(runId)));
}

/**
 * Appends one governed Git mutation evidence record to its date-bucketed ledger. Redacts every string
 * leaf, bounds the bucket, and never throws into the caller's path. Returns nothing — audit recording
 * is best-effort and is reported (not propagated) on failure.
 */
export function recordGitDeliveryMutationEvidence(
  options: RecordGitDeliveryEvidenceOptions,
  record: GitDeliveryEvidenceRecord,
): void {
  const onPersistError = options.onPersistError ?? defaultOnPersistError;
  const cap = options.maxRecordsPerBucket ?? GIT_DELIVERY_EVIDENCE_DEFAULT_BUCKET_CAP;
  const safe = deepRedactStrings(record, options.redactString) as GitDeliveryEvidenceRecord;
  const runId = gitDeliveryEvidenceRunIdFor(record.recordedAtMs);
  try {
    appendRecord(options.evidenceStore, runId, safe, cap);
  } catch (error) {
    onPersistError(error);
  }
}
