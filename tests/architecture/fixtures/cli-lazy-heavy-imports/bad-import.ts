/**
 * INTENTIONAL GEN-PERF-CLI-001 VIOLATION FIXTURE
 *
 * Proves the CLI lazy-loading gate is live: a keiko-cli module statically
 * value-importing a heavy workspace package graph must be rejected. Type-only
 * imports and dynamic import() (the lazy-modules.ts loaders) below are the
 * sanctioned forms and must NOT fire the rule — they pin the allowed shapes.
 */
import { createSession } from "@oscharko-dev/keiko-harness";

import type { ModelPort } from "@oscharko-dev/keiko-harness";

export const violation = createSession;
export type AllowedTypeOnly = ModelPort;
export const allowedDynamic = (): Promise<unknown> => import("@oscharko-dev/keiko-server");
