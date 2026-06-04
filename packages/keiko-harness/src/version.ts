// Package version. Kept in sync with packages/keiko-harness/package.json so consumers can
// observe the public-surface generation at runtime. This is the PACKAGE version, distinct
// from HARNESS_VERSION (the runtime/event-schema version that lives in @oscharko-dev/keiko-contracts
// — re-exported from the package barrel so consumers see a single import source).

export const KEIKO_HARNESS_VERSION = "0.1.0" as const;
