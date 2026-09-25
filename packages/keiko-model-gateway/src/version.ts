// Package version constant. Pinned at the workspace package's package.json version. Promoted to
// a `const` string-literal type so downstream tests/assertions stay byte-exact.
export const KEIKO_MODEL_GATEWAY_VERSION = "1.1.7" as const;
