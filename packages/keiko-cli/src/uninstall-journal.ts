import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPortableTarget, type PortableTarget } from "./portable-shared.js";

/**
 * Written before the first file of a managed installation is removed, and removed with the rest of
 * the state. It lets a second `keiko uninstall` find an installation a first run left partly
 * removed: the tree attestation of a Windows generation breaks with the first deleted file, so a
 * partial installation can no longer be attested the ordinary way. It holds digests the
 * registration already records and a platform label, never a path.
 */
export const UNINSTALL_JOURNAL_FILE = "portable-uninstall-journal.json";

const JOURNAL_MAX_BYTES = 4096;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface UninstallJournal {
  readonly schemaVersion: 1;
  readonly platformTarget: PortableTarget;
  readonly setupManifestSha256: string;
  readonly installRootIdentitySha256: string;
}

export function uninstallJournalPath(stateDir: string): string {
  return join(stateDir, UNINSTALL_JOURNAL_FILE);
}

export function writeUninstallJournal(stateDir: string, journal: UninstallJournal): void {
  writeFileSync(uninstallJournalPath(stateDir), `${JSON.stringify(journal)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isJournal(value: unknown): value is UninstallJournal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.platformTarget === "string" &&
    isPortableTarget(record.platformTarget) &&
    typeof record.setupManifestSha256 === "string" &&
    SHA256.test(record.setupManifestSha256) &&
    typeof record.installRootIdentitySha256 === "string" &&
    SHA256.test(record.installRootIdentitySha256)
  );
}

/** The journal, or undefined when there is none or it is not a valid one: that names no removal. */
export function readUninstallJournal(stateDir: string): UninstallJournal | undefined {
  const path = uninstallJournalPath(stateDir);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size > JOURNAL_MAX_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isJournal(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
