import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseActivityLogFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";

/**
 * The Activity Log of an end-to-end run, kept as failure evidence (#4355). CI run 43596154016 failed
 * with a page snapshot only: the server's own account of the turn (which receipt state it reached, why
 * a deadline cancelled) was in a state directory nobody uploaded. The existing failure upload takes
 * `test-results/`, so the log is copied there.
 *
 * The copy is an allowlist, never a directory copy: only regular files whose name is an Activity Log
 * segment in the closed grammar of `keiko-contracts` (`parseActivityLogFileName`) are taken, so the
 * uploaded directory holds nothing but the log (the state directory also holds the Chat store, the
 * gateway configuration and Jira fixture state). The log itself is body-free by contract (ADR-0173);
 * a byte bound keeps a runaway log from turning into a runaway artifact.
 */
export const ACTIVITY_LOG_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;

export interface ActivityLogEvidenceCopy {
  readonly copied: number;
  readonly skipped: number;
  readonly bytes: number;
}

export function copyActivityLogEvidence(
  source: string,
  destination: string,
  maxBytes = ACTIVITY_LOG_EVIDENCE_MAX_BYTES,
): ActivityLogEvidenceCopy {
  if (!existsSync(source)) return { copied: 0, skipped: 0, bytes: 0 };
  // The directory itself must be a real directory, not a link to somewhere else.
  const directory = lstatSync(source);
  if (!directory.isDirectory() || realpathSync(source) !== source) return skipAll(source);
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (const name of readdirSync(source).sort()) {
    const path = join(source, name);
    const stat = lstatSync(path);
    const admitted =
      stat.isFile() &&
      parseActivityLogFileName(name) !== undefined &&
      bytes + stat.size <= maxBytes;
    if (!admitted) {
      skipped++;
      continue;
    }
    if (copied === 0) mkdirSync(destination, { recursive: true });
    copyFileSync(path, join(destination, name));
    copied++;
    bytes += stat.size;
  }
  return { copied, skipped, bytes };
}

function skipAll(source: string): ActivityLogEvidenceCopy {
  return { copied: 0, skipped: readdirSync(source).length, bytes: 0 };
}
