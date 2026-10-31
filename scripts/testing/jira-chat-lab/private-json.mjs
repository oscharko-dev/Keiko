import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function syncDirectory(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, serialized) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Keep the previous complete intent until its replacement is synced and atomically renamed. */
export function privateJson(path, value, exclusive = false) {
  const serialized = JSON.stringify(value);
  const directory = dirname(path);
  if (exclusive) {
    writeExclusive(path, serialized);
    syncDirectory(directory);
    return;
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeExclusive(temporary, serialized);
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}
