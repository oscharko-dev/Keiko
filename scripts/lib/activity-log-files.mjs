// The repository tooling's one reader of a segmented Activity Log (#3530).
//
// Scripts and e2e support read what a product process persisted under `<stateDir>/logs/`: sealed
// and active segments plus any legacy `server.log` / `server-YYYY-MM-DD.log` files. The closed file
// grammar, the logical order and the one-name-per-segment rule come from keiko-contracts
// (`activity-log-files.ts`), the same functions the product's own readers use, so tooling never
// re-derives either from directory name order.
//
// Only regular files are read (lstat, never followed). A file that vanishes between the listing and
// the read (a retention pass, a seal's rename) is skipped. Every file's text is newline-terminated
// before the files are joined, so a torn tail can never merge with the next file's first line.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  orderActivityLogFileNames,
  readableActivityLogFileNames,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

/** The Activity Log directory of a Keiko state directory. */
export function activityLogDirectory(stateDir) {
  return join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
}

function listNames(logsDir) {
  try {
    return readdirSync(logsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function regularFileSize(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/**
 * The regular Activity Log files in `logsDir`, oldest first, one name per segment. `key` is the
 * segment id for a segment (it survives the seal's rename) and the file name for a legacy file.
 */
export function activityLogFiles(logsDir) {
  const files = [];
  for (const file of readableActivityLogFileNames(orderActivityLogFileNames(listNames(logsDir)))) {
    const path = join(logsDir, file.name);
    const sizeBytes = regularFileSize(path);
    if (sizeBytes === undefined) continue;
    files.push({ name: file.name, path, key: file.segmentId ?? file.name, sizeBytes });
  }
  return files;
}

function readBytesOrUndefined(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function terminated(text) {
  return text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
}

/** Every persisted line of the Activity Log in `logsDir`, oldest first. */
export function readActivityLogText(logsDir) {
  return readActivityLogSince(logsDir, new Map());
}

/** Byte sizes by stable file key, to read later only what was appended after this point. */
export function activityLogSnapshot(logsDir) {
  return new Map(activityLogFiles(logsDir).map((file) => [file.key, file.sizeBytes]));
}

/**
 * The lines persisted after `snapshot` was taken: new files whole, and the byte suffix of a file the
 * snapshot saw, matched by its stable key so a segment sealed in between is not read again. A file
 * smaller than its snapshot was replaced and is read whole.
 */
export function readActivityLogSince(logsDir, snapshot) {
  let text = "";
  for (const file of activityLogFiles(logsDir)) {
    const bytes = readBytesOrUndefined(file.path);
    if (bytes === undefined) continue;
    const seen = snapshot.get(file.key) ?? 0;
    const offset = seen <= bytes.length ? seen : 0;
    text += terminated(bytes.subarray(offset).toString("utf8"));
  }
  return text;
}
