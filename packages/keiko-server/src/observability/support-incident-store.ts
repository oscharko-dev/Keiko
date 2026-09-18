// The local SupportIncident store (#3533): `<stateDir>/support-incidents/`, one closed-grammar,
// owner-private JSON record per incident candidate.
//
// It uses the keiko-security safe-artifact primitives exactly as the Activity Log store does for
// its pin records: the directory is created owner-only (0700) and is the trusted root; every read,
// exclusive create, and removal goes through `openSafeArtifactFile`/`removeSafeArtifactFile`, which
// re-verify the directory chain and bind the operation to a regular, owner-matched, single-link
// file. Only names of the closed grammar (`incident-<32 hex>.json`) are ever opened or removed, so
// a planted or foreign file is never touched. The residual same-user race window is the one the
// Activity Log store documents; the store never grows unbounded because the caller enforces the
// count quota and every record is bounded to MAX_SUPPORT_INCIDENT_RECORD_BYTES.
//
// Records are immutable once published (exclusive create, never replaced). A crash can leave at
// most a torn record, which fails the closed-schema parse and is reported as `invalid` so the
// caller removes it — the same recovery the Activity Log applies to an unreadable pin record. A
// record of another schema version (for example one a newer Keiko wrote before a downgrade) is
// never interpreted: it counts as unreadable and is swept the same way, which keeps the store
// bounded; its Activity Log pin still lapses at the pin's own expiry.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  SafeArtifactFileError,
  openSafeArtifactFile,
  removeSafeArtifactFile,
} from "@oscharko-dev/keiko-security/fs-hardening";
import {
  MAX_SUPPORT_INCIDENT_RECORD_BYTES,
  SUPPORT_INCIDENT_DIRECTORY_NAME,
  isSupportIncidentId,
  parseSupportIncidentFileName,
  parseSupportIncidentFingerprintClaimFileName,
  parseSupportIncidentRecord,
  parseSupportIncidentSlotClaimFileName,
  supportIncidentFileName,
  supportIncidentFingerprintClaimFileName,
  supportIncidentSlotClaimFileName,
  type SupportIncidentRecord,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

// The records are control metadata about Activity Log evidence, never a report or the evidence.
const ARTIFACT_CLASS = "manifest";

export interface SupportIncidentStoreEntry {
  readonly incidentId: string;
  readonly sizeBytes: number;
  // `undefined` when the record is unreadable or outside the closed schema (torn or foreign).
  readonly record: SupportIncidentRecord | undefined;
}

export function supportIncidentDirectory(stateDir: string): string {
  return join(stateDir, SUPPORT_INCIDENT_DIRECTORY_NAME);
}

/** Creates the owner-private store directory when absent and returns it (the trusted root). */
export function ensureSupportIncidentDirectory(stateDir: string): string {
  const directory = supportIncidentDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function regularFileSize(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function readDirectoryNames(directory: string): readonly string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function readBoundedText(descriptor: number): string | undefined {
  const size = fstatSync(descriptor).size;
  if (size <= 0 || size > MAX_SUPPORT_INCIDENT_RECORD_BYTES) return undefined;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, offset, size - offset, offset);
    if (count <= 0) return undefined;
    offset += count;
  }
  return buffer.toString("utf8");
}

function readRecord(
  path: string,
  directory: string,
  incidentId: string,
): SupportIncidentRecord | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(path, {
      artifactClass: ARTIFACT_CLASS,
      mode: "read",
      trustedRoot: directory,
    });
    const text = readBoundedText(descriptor);
    if (text === undefined) return undefined;
    const record = parseSupportIncidentRecord(JSON.parse(text));
    return record?.incidentId === incidentId ? record : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Every closed-grammar regular file in the store, oldest record first (ties by id). Unreadable
 * records are listed with `record: undefined` so the caller counts and recovers them.
 */
export function listSupportIncidentEntries(stateDir: string): readonly SupportIncidentStoreEntry[] {
  const directory = supportIncidentDirectory(stateDir);
  const entries: SupportIncidentStoreEntry[] = [];
  for (const name of readDirectoryNames(directory)) {
    // parseSupportIncidentFileName also recognizes the fingerprint- and slot-claim grammars (so
    // state-paths.ts's ownership predicate covers them too); only a real 32-hex incident id names
    // a record here, so a claim's fingerprint or slot-index string is never mistaken for one.
    const incidentId = parseSupportIncidentFileName(name);
    if (incidentId === undefined || !isSupportIncidentId(incidentId)) continue;
    const path = join(directory, name);
    const sizeBytes = regularFileSize(path);
    if (sizeBytes === undefined) continue;
    entries.push({ incidentId, sizeBytes, record: readRecord(path, directory, incidentId) });
  }
  return entries.sort(
    (left, right) =>
      (left.record?.createdAtMs ?? 0) - (right.record?.createdAtMs ?? 0) ||
      left.incidentId.localeCompare(right.incidentId, "en-US"),
  );
}

/** One record by id through the same hardened read, or `undefined` when absent or unreadable. */
export function readSupportIncidentRecord(
  stateDir: string,
  incidentId: string,
): SupportIncidentRecord | undefined {
  if (!isSupportIncidentId(incidentId)) return undefined;
  const directory = supportIncidentDirectory(stateDir);
  const path = join(directory, supportIncidentFileName(incidentId));
  return regularFileSize(path) === undefined ? undefined : readRecord(path, directory, incidentId);
}

function writeAllBytes(descriptor: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(descriptor, payload, offset, payload.length - offset);
    if (written <= 0) throw new SafeArtifactFileError(ARTIFACT_CLASS, "write-failed");
    offset += written;
  }
}

/** The serialized record, or `undefined` when it would exceed the per-record byte bound. */
export function serializeSupportIncidentRecord(record: SupportIncidentRecord): Buffer | undefined {
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  return payload.length <= MAX_SUPPORT_INCIDENT_RECORD_BYTES ? payload : undefined;
}

/** Publishes one record exclusively and durably; an existing name is never replaced. */
export function writeSupportIncidentRecord(
  directory: string,
  payload: Buffer,
  incidentId: string,
): void {
  const descriptor = openSafeArtifactFile(join(directory, supportIncidentFileName(incidentId)), {
    artifactClass: ARTIFACT_CLASS,
    mode: "exclusive-create",
    trustedRoot: directory,
  });
  try {
    writeAllBytes(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Removes one closed-grammar record through the handle-checked removal primitive. */
export function removeSupportIncidentRecord(stateDir: string, incidentId: string): void {
  const directory = supportIncidentDirectory(stateDir);
  removeSafeArtifactFile(join(directory, supportIncidentFileName(incidentId)), {
    artifactClass: ARTIFACT_CLASS,
    trustedRoot: directory,
  });
}

// ─── Cross-process dedup and quota claims (#3533 review 4050606506) ────────────────────────────
//
// The incident record's own exclusive-create only ever protected its random incident-id file
// name, never a defect fingerprint or the store's count quotas that two processes could each read
// as "still free" before either published. A claim file's NAME is the atomic arbiter instead: an
// exclusive-create on a fingerprint- or slot-keyed name can succeed for only one caller --
// kernel-guaranteed, the same primitive the incident record itself already trusts. Its whole
// content is the incidentId it was claimed for, so a loser can read who holds it, and dismissal or
// expiry release it through that same stored reference. A claim whose referenced incident no
// longer exists (a crash between claiming and writing the record, or a cleanup that missed it) is
// an orphan; `listSupportIncidentClaims` lets the caller sweep those the same way it recovers a
// torn incident record.

// No claim at this path is the common, expected outcome for most fingerprints and slots (most
// were simply never claimed), so it is checked first and treated as a plain `undefined`, never a
// caught failure. A file that exists but cannot be read (permission, corruption, a same-instant
// removal after this check) is a genuine anomaly and propagates: support-incident-store.ts never
// imports the evidence sink (server-log.ts also reaches this module, and reporting from here would
// cycle back through it), so every caller that can legitimately hit that anomaly reports it itself.
function readClaimIncidentId(path: string, directory: string): string | undefined {
  if (regularFileSize(path) === undefined) return undefined;
  const descriptor = openSafeArtifactFile(path, {
    artifactClass: ARTIFACT_CLASS,
    mode: "read",
    trustedRoot: directory,
  });
  try {
    const text = readBoundedText(descriptor);
    return text !== undefined && isSupportIncidentId(text) ? text : undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Exclusive-creates `fileName` with `incidentId` as its whole content. `false` (never throws for
 * this one outcome) means another occurrence already holds it -- a real cross-process race, or a
 * same-process retry -- so the caller reads the holder instead of publishing a second record.
 */
function claimSupportIncidentFile(
  directory: string,
  fileName: string,
  incidentId: string,
): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSafeArtifactFile(join(directory, fileName), {
      artifactClass: ARTIFACT_CLASS,
      mode: "exclusive-create",
      trustedRoot: directory,
    });
  } catch (error) {
    if (error instanceof SafeArtifactFileError && error.kind === "target-exists") return false;
    throw error;
  }
  try {
    writeAllBytes(descriptor, Buffer.from(incidentId, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

/** Best-effort, idempotent removal: a claim that is already gone is not an error. */
function removeClaimIfPresent(directory: string, fileName: string): void {
  const path = join(directory, fileName);
  if (regularFileSize(path) === undefined) return;
  removeSafeArtifactFile(path, { artifactClass: ARTIFACT_CLASS, trustedRoot: directory });
}

/** Atomically claims the defectFingerprint's dedup slot for `incidentId`, or `false` if held. */
export function claimSupportIncidentFingerprint(
  stateDir: string,
  defectFingerprint: string,
  incidentId: string,
): boolean {
  const directory = supportIncidentDirectory(stateDir);
  return claimSupportIncidentFile(
    directory,
    supportIncidentFingerprintClaimFileName(defectFingerprint),
    incidentId,
  );
}

/** The incidentId currently holding `defectFingerprint`'s claim, or `undefined`. */
export function readSupportIncidentFingerprintClaim(
  stateDir: string,
  defectFingerprint: string,
): string | undefined {
  const directory = supportIncidentDirectory(stateDir);
  return readClaimIncidentId(
    join(directory, supportIncidentFingerprintClaimFileName(defectFingerprint)),
    directory,
  );
}

export function releaseSupportIncidentFingerprintClaim(
  stateDir: string,
  defectFingerprint: string,
): void {
  removeClaimIfPresent(
    supportIncidentDirectory(stateDir),
    supportIncidentFingerprintClaimFileName(defectFingerprint),
  );
}

/** Atomically claims quota slot `slotIndex` for `incidentId`, or `false` if another id holds it. */
export function claimSupportIncidentSlot(
  stateDir: string,
  slotIndex: number,
  incidentId: string,
): boolean {
  const directory = supportIncidentDirectory(stateDir);
  return claimSupportIncidentFile(
    directory,
    supportIncidentSlotClaimFileName(slotIndex),
    incidentId,
  );
}

export function releaseSupportIncidentSlot(stateDir: string, slotIndex: number): void {
  removeClaimIfPresent(
    supportIncidentDirectory(stateDir),
    supportIncidentSlotClaimFileName(slotIndex),
  );
}

export interface SupportIncidentClaimEntry {
  readonly fileName: string;
  // `undefined` when the claim is unreadable or torn -- an orphan by construction.
  readonly incidentId: string | undefined;
}

/** Every fingerprint- and slot-claim file in the store, for the orphan sweep. */
export function listSupportIncidentClaims(stateDir: string): readonly SupportIncidentClaimEntry[] {
  const directory = supportIncidentDirectory(stateDir);
  const entries: SupportIncidentClaimEntry[] = [];
  for (const name of readDirectoryNames(directory)) {
    const isClaim =
      parseSupportIncidentFingerprintClaimFileName(name) !== undefined ||
      parseSupportIncidentSlotClaimFileName(name) !== undefined;
    if (!isClaim) continue;
    entries.push({
      fileName: name,
      incidentId: readClaimIncidentId(join(directory, name), directory),
    });
  }
  return entries;
}

/** Removes one claim file by its exact, already-validated name (the orphan sweep). */
export function removeSupportIncidentClaimFile(stateDir: string, fileName: string): void {
  removeClaimIfPresent(supportIncidentDirectory(stateDir), fileName);
}
