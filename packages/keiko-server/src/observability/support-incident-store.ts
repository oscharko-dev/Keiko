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
// caller removes it — the same recovery the Activity Log applies to an unreadable pin record.

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
  parseSupportIncidentFileName,
  parseSupportIncidentRecord,
  supportIncidentFileName,
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
    const incidentId = parseSupportIncidentFileName(name);
    if (incidentId === undefined) continue;
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
