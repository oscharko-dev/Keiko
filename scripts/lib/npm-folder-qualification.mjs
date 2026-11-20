// What the npm folder package qualification and its publisher agree on: the named checks, the
// evidence shape and the repository whose public release is read. One owner, so the publisher can
// refuse evidence that lacks a check without importing the qualification run itself.

export const DEFAULT_REPOSITORY = "oscharko-dev/Keiko";
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_KIND = "keiko-npm-folder-package-qualification";

export const CHECK_NAMES = Object.freeze([
  "archive-checksum",
  "package-build",
  "extract-with-platform-tool",
  "first-start-installs",
  "health-reports-version",
  "installation-record-matches-lockfile",
  "coding-runtime-package",
  "second-start-reports-running",
  "folder-unchanged-outside-node-modules",
  "stop-exits-clean",
  "no-process-left",
  "activity-log-lifecycle",
]);
