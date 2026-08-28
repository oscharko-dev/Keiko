export const KEIKO_CONTRACTS_VERSION = "0.3.17" as const;

// Single-source product version. Surfaced as `keiko --version`, in the BFF healthcheck response,
// and as the SDK's exported `SDK_VERSION` constant. Kept in the contracts leaf so every consumer
// reaches it through one stable import path. Bump in lockstep with the root package.json version.
export const KEIKO_PRODUCT_VERSION = "0.3.17" as const;
