// Raw built-in capability registry data.
//
// Keiko intentionally ships no customer or deployment-specific model ids. Private model
// capabilities are supplied by local config or discovered at runtime during UI onboarding.

import type { ModelCapability } from "./types.js";

export const CAPABILITY_DATA: readonly ModelCapability[] = [];
