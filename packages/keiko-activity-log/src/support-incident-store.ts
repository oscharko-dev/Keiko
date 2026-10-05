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
// byte-derived reservation capacity and every record is bounded to MAX_SUPPORT_INCIDENT_RECORD_BYTES.
//
// Records are immutable once published (exclusive create, never replaced). A crash can leave at
// most a torn record, which fails the closed-schema parse and is reported as `invalid` so the
// caller removes it — the same recovery the Activity Log applies to an unreadable pin record. A
// record of another schema version (for example one a newer Keiko wrote before a downgrade) is
// never interpreted: it counts as unreadable and is swept the same way, which keeps the store
// bounded; its Activity Log pin still lapses at the pin's own expiry.

import {
  type BigIntStats,
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
  assertSafeArtifactAncestors,
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
  // The file's mtime: a record is exclusive-created before its bytes are written, so an unreadable
  // record this young may still be mid-write by another process rather than torn.
  readonly modifiedAtMs: number;
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

interface RegularFileState {
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

function regularFileState(path: string): RegularFileState | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function regularFileSize(path: string): number | undefined {
  return regularFileState(path)?.sizeBytes;
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
    const state = regularFileState(path);
    if (state === undefined) continue;
    entries.push({ incidentId, ...state, record: readRecord(path, directory, incidentId) });
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
  const path = join(directory, supportIncidentFileName(incidentId));
  const descriptor = openSafeArtifactFile(path, {
    artifactClass: ARTIFACT_CLASS,
    mode: "exclusive-create",
    trustedRoot: directory,
  });
  try {
    writeAllBytes(descriptor, payload);
    fsyncSync(descriptor);
  } catch (error) {
    removeFailedPublication(path, directory, descriptor, error);
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function publicationAndCleanupError(
  publicationError: unknown,
  cleanupError: unknown,
): AggregateError {
  return new AggregateError(
    [publicationError, cleanupError],
    "Support incident publication and owned cleanup failed",
    { cause: publicationError },
  );
}

function removeFailedPublication(
  path: string,
  directory: string,
  ownedDescriptor: number,
  publicationError: unknown,
): void {
  try {
    const owned = fstatSync(ownedDescriptor, { bigint: true });
    removeSafeArtifactFile(
      path,
      { artifactClass: ARTIFACT_CLASS, trustedRoot: directory },
      (target): boolean => {
        const current = fstatSync(target, { bigint: true });
        return current.dev === owned.dev && current.ino === owned.ino;
      },
    );
  } catch (cleanupError) {
    throw publicationAndCleanupError(publicationError, cleanupError);
  }
}

function artifactLeafIsAbsent(
  path: string,
  directory: string,
  originalDirectory: BigIntStats,
): boolean {
  assertSafeArtifactAncestors(path, ARTIFACT_CLASS);
  const root = lstatSync(directory, { bigint: true });
  return (
    root.isDirectory() &&
    !root.isSymbolicLink() &&
    root.dev === originalDirectory.dev &&
    root.ino === originalDirectory.ino &&
    root.uid === originalDirectory.uid &&
    root.mode === originalDirectory.mode &&
    lstatSync(path, { throwIfNoEntry: false }) === undefined
  );
}

function peerRemovalFailure(error: unknown): boolean {
  return (
    error instanceof SafeArtifactFileError &&
    (error.kind === "open-failed" ||
      error.kind === "unsafe-target" ||
      error.kind === "target-mutated")
  );
}

function removeIncidentArtifact(
  path: string,
  directory: string,
  shouldRemove?: (descriptor: number) => boolean,
): void {
  assertSafeArtifactAncestors(path, ARTIFACT_CLASS);
  const originalDirectory = lstatSync(directory, { bigint: true });
  try {
    removeSafeArtifactFile(
      path,
      { artifactClass: ARTIFACT_CLASS, trustedRoot: directory },
      shouldRemove,
    );
  } catch (error) {
    // A peer can unlink before open or while the descriptor is held. Only confirmed leaf
    // absence beneath the same safe directory completes that idempotent cleanup.
    if (peerRemovalFailure(error) && artifactLeafIsAbsent(path, directory, originalDirectory))
      return;
    throw error;
  }
}

/** Removes one closed-grammar record through the handle-checked removal primitive. */
export function removeSupportIncidentRecord(stateDir: string, incidentId: string): void {
  const directory = supportIncidentDirectory(stateDir);
  removeIncidentArtifact(join(directory, supportIncidentFileName(incidentId)), directory);
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
// caught failure. A peer unlink between inspection and open is also confirmed as absence.
// A present file that cannot be read (permission or corruption) remains an anomaly and propagates: support-incident-store.ts never
// imports the evidence sink (server-log.ts also reaches this module, and reporting from here would
// cycle back through it), so every caller that can legitimately hit that anomaly reports it itself.
/** A claim as read: the occurrence holding it, and when it was claimed. */
export interface SupportIncidentClaim {
  // `undefined` when the claim is unreadable or torn. A claim is exclusive-created before its id is
  // written, so a torn claim this young may still be mid-write by its holder.
  readonly incidentId: string | undefined;
  // The claim file's mtime: when its holder claimed it.
  readonly claimedAtMs: number;
}

function openClaim(path: string, directory: string): number | undefined {
  try {
    return openSafeArtifactFile(path, {
      artifactClass: ARTIFACT_CLASS,
      mode: "read",
      trustedRoot: directory,
    });
  } catch (error) {
    if (error instanceof SafeArtifactFileError && error.kind === "open-failed") {
      assertSafeArtifactAncestors(path, ARTIFACT_CLASS);
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
    }
    throw error;
  }
}

function readClaim(path: string, directory: string): SupportIncidentClaim | undefined {
  const state = regularFileState(path);
  if (state === undefined) return undefined;
  const descriptor = openClaim(path, directory);
  if (descriptor === undefined) return undefined;
  try {
    const text = readBoundedText(descriptor);
    return {
      incidentId: text !== undefined && isSupportIncidentId(text) ? text : undefined,
      claimedAtMs: state.modifiedAtMs,
    };
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

function claimOwnerMatches(descriptor: number, owner: string | undefined): boolean {
  const text = readBoundedText(descriptor);
  const current = text !== undefined && isSupportIncidentId(text) ? text : undefined;
  return current === owner;
}

interface ExpectedClaimOwner {
  readonly incidentId: string | undefined;
  readonly claimedAtMs?: number;
}

/** An absent claim is idempotent; a changed owner or mtime remains untouched. */
function removeClaimIfPresent(
  directory: string,
  fileName: string,
  expected?: ExpectedClaimOwner,
): void {
  const path = join(directory, fileName);
  removeIncidentArtifact(
    path,
    directory,
    expected === undefined
      ? undefined
      : (descriptor): boolean =>
          claimOwnerMatches(descriptor, expected.incidentId) &&
          (expected.claimedAtMs === undefined ||
            fstatSync(descriptor).mtimeMs === expected.claimedAtMs),
  );
}

function expectedClaimOwner(incidentId: string | undefined): ExpectedClaimOwner | undefined {
  if (incidentId === undefined) return undefined;
  if (!isSupportIncidentId(incidentId)) throw new TypeError("Invalid incident claim owner");
  return { incidentId };
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

/** The claim currently held on `defectFingerprint`, or `undefined` when it is free. */
export function readSupportIncidentFingerprintClaim(
  stateDir: string,
  defectFingerprint: string,
): SupportIncidentClaim | undefined {
  const directory = supportIncidentDirectory(stateDir);
  return readClaim(
    join(directory, supportIncidentFingerprintClaimFileName(defectFingerprint)),
    directory,
  );
}

export function releaseSupportIncidentFingerprintClaim(
  stateDir: string,
  defectFingerprint: string,
  expectedIncidentId?: string,
): void {
  removeClaimIfPresent(
    supportIncidentDirectory(stateDir),
    supportIncidentFingerprintClaimFileName(defectFingerprint),
    expectedClaimOwner(expectedIncidentId),
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

/** One occupied slot owner; recovery never needs to open unrelated fingerprint claims. */
export function readSupportIncidentSlotClaim(
  stateDir: string,
  slotIndex: number,
): SupportIncidentClaim | undefined {
  const directory = supportIncidentDirectory(stateDir);
  return readClaim(join(directory, supportIncidentSlotClaimFileName(slotIndex)), directory);
}

export function releaseSupportIncidentSlot(
  stateDir: string,
  slotIndex: number,
  expectedIncidentId?: string,
): void {
  removeClaimIfPresent(
    supportIncidentDirectory(stateDir),
    supportIncidentSlotClaimFileName(slotIndex),
    expectedClaimOwner(expectedIncidentId),
  );
}

export interface SupportIncidentClaimEntry extends SupportIncidentClaim {
  readonly fileName: string;
}

/** Occupancy needs names only; a foreign or concurrently released claim is never opened. */
export function listSupportIncidentSlotIndexes(stateDir: string): readonly number[] {
  return readDirectoryNames(supportIncidentDirectory(stateDir)).flatMap((name) => {
    const index = parseSupportIncidentSlotClaimFileName(name);
    return index === undefined ? [] : [index];
  });
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
    // A claim removed between the listing and this read is already gone: nothing to sweep.
    const claim = readClaim(join(directory, name), directory);
    if (claim !== undefined) entries.push({ fileName: name, ...claim });
  }
  return entries;
}

/** Removes one claim file by its exact, already-validated name (the orphan sweep). */
export function removeSupportIncidentClaimFile(
  stateDir: string,
  fileName: string,
  expected?: SupportIncidentClaim,
): void {
  removeClaimIfPresent(supportIncidentDirectory(stateDir), fileName, expected);
}
