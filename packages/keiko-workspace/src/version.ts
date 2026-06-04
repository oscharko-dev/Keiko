// Version identifier for the workspace package. Pattern matches keiko-contracts /
// keiko-security / keiko-model-gateway: keep the literal type via `as const` so
// downstream assertions can pin on the exact string.
export const KEIKO_WORKSPACE_VERSION = "0.1.0" as const;
