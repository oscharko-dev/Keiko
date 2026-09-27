// The closed file grammar of the rebuildable segment-manifest store (#3531).
//
// `<stateDir>/activity-log-manifests/` holds one derived, rebuildable manifest per sealed Activity
// Log segment, named `manifest-<segmentId>.json` with the segment id of the shared Activity Log
// grammar (keiko-contracts `activity-log-files.ts`). Nothing else in that directory is Keiko's: the
// store, the state-path ownership scan, `keiko uninstall --state` and `keiko repair` all classify
// through this one predicate, so an operator file placed there is never read, changed or deleted.
// This module stays dependency-light because the ownership scan loads it on every CLI start.

import { parseActivityLogSegmentId } from "@oscharko-dev/keiko-contracts/runtime/observability";

export const ACTIVITY_LOG_MANIFEST_DIRECTORY_NAME = "activity-log-manifests";

const MANIFEST_FILE_PATTERN = /^manifest-(.+)\.json$/u;

export function segmentManifestFileName(segmentId: string): string {
  if (parseActivityLogSegmentId(segmentId) === undefined) {
    throw new RangeError("invalid Activity Log segment id");
  }
  return `manifest-${segmentId}.json`;
}

/** The segment id a closed-grammar manifest file name carries, else `undefined`. */
export function parseSegmentManifestFileName(name: string): string | undefined {
  const segmentId = MANIFEST_FILE_PATTERN.exec(name)?.[1];
  return segmentId !== undefined && parseActivityLogSegmentId(segmentId) !== undefined
    ? segmentId
    : undefined;
}

export function isSegmentManifestFileName(name: string): boolean {
  return parseSegmentManifestFileName(name) !== undefined;
}
