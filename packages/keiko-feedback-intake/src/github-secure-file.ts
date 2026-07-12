import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

const SAFE_FILE_ERROR = "GitHub App secure configuration is unavailable";

export function readSecureOperatorFile(path: string, maximumBytes: number): Uint8Array {
  let descriptor: number | undefined;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") throw new Error(SAFE_FILE_ERROR);
    const before = lstatSync(path);
    if (before.isSymbolicLink()) throw new Error(SAFE_FILE_ERROR);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(descriptor);
    const valid = [
      after.isFile(),
      after.nlink === 1,
      (after.mode & 0o077) === 0,
      after.uid === process.getuid?.(),
      after.size > 0,
      after.size <= maximumBytes,
      before.dev === after.dev,
      before.ino === after.ino,
    ].every(Boolean);
    if (!valid) throw new Error(SAFE_FILE_ERROR);
    return Uint8Array.from(readFileSync(descriptor));
  } catch {
    throw new Error(SAFE_FILE_ERROR);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
