import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { isProcessId } from "@oscharko-dev/keiko-security/process-scope";
import { isKeikoUiLaunchId } from "@oscharko-dev/keiko-contracts/runtime/ui-launch";
import { assertRegularSingleLinkFile, type PidRecord } from "./state-paths.js";

function privateDirectory(path: string): boolean {
  const status = lstatSync(path);
  return (
    status.isDirectory() && status.uid === process.getuid?.() && (status.mode & 0o777) === 0o700
  );
}

interface NativeUiIdentity {
  readonly pid?: number;
  readonly launchId?: string | undefined;
}

function validRecordedPid(line: string | undefined): boolean {
  return /^[1-9]\d*$/u.test(line ?? "") && isProcessId(Number(line));
}

function ownershipEnvelope(lines: readonly string[], record: NativeUiIdentity): boolean {
  return (
    lines.length === 6 &&
    lines[0] === "keiko-ui-runtime-v1" &&
    lines[2] === record.launchId &&
    validRecordedPid(lines[3]) &&
    lines[5] === ""
  );
}

function ownershipRecord(
  raw: string,
  record: NativeUiIdentity,
  phase: "owned" | "settled",
): boolean {
  const lines = raw.split("\n");
  if (!ownershipEnvelope(lines, record)) return false;
  if (phase === "settled" && record.pid === undefined && lines[4] === "not-started")
    return lines[1] === "0";
  return (
    validRecordedPid(lines[1]) &&
    (record.pid === undefined || lines[1] === String(record.pid)) &&
    lines[4] === (phase === "owned" ? "owned" : "reaped")
  );
}

function sameSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    after.nlink === 1n &&
    before.mode === after.mode &&
    before.uid === after.uid
  );
}

function readOwnershipRecord(
  path: string,
  record: NativeUiIdentity,
  phase: "owned" | "settled",
): boolean {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    assertRegularSingleLinkFile(descriptor, "native UI ownership record");
    const before = fstatSync(descriptor, { bigint: true });
    if (before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o777n) !== 0o600n)
      return false;
    const bytes = Buffer.alloc(160);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor, { bigint: true });
    return (
      count < bytes.length &&
      BigInt(count) === before.size &&
      sameSnapshot(before, after) &&
      sameSnapshot(before, lstatSync(path, { bigint: true })) &&
      ownershipRecord(bytes.subarray(0, count).toString(), record, phase)
    );
  } finally {
    closeSync(descriptor);
  }
}

/** Native ownership evidence is a lifecycle observation, never a branded server reap receipt. */
function nativeUiRecordMatches(
  stateDir: string,
  record: NativeUiIdentity,
  phase: "owned" | "settled",
): boolean {
  if (!isKeikoUiLaunchId(record.launchId)) return false;
  try {
    const hidden = join(stateDir, ".keiko"),
      directory = join(hidden, "ui-runtime");
    const directories = [stateDir, hidden, directory];
    if (!directories.every(privateDirectory)) return false;
    const snapshots = directories.map((path) => lstatSync(path, { bigint: true }));
    if (!readOwnershipRecord(join(directory, `${record.launchId}.receipt`), record, phase))
      return false;
    return directories.every((path, i) => {
      const before = snapshots[i],
        after = lstatSync(path, { bigint: true });
      return (
        before?.dev === after.dev &&
        before.ino === after.ino &&
        after.isDirectory() &&
        before.mode === after.mode &&
        before.uid === after.uid
      );
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export function nativeUiGenerationReaped(stateDir: string, record: PidRecord): boolean {
  return nativeUiRecordMatches(stateDir, record, "settled");
}

export function nativeUiGenerationOwned(stateDir: string, record: PidRecord): boolean {
  return nativeUiRecordMatches(stateDir, record, "owned");
}

export function nativeUiAttemptSettled(stateDir: string, launchId: string): boolean {
  return nativeUiRecordMatches(stateDir, { launchId }, "settled");
}

export function nativeUiLaunchIdUnused(stateDir: string, launchId: string): boolean {
  if (!isKeikoUiLaunchId(launchId)) return false;
  try {
    lstatSync(join(stateDir, ".keiko", "ui-runtime", `${launchId}.receipt`));
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return true;
    throw error;
  }
}
