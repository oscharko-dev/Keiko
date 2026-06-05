// Single source of truth for the package version. Pinned as a literal so consumers can
// import it for telemetry or evidence persistence without parsing package.json at runtime.
// Bump in lockstep with package.json on every release.
export const KEIKO_MEMORY_RETRIEVAL_VERSION = "0.1.0" as const;
