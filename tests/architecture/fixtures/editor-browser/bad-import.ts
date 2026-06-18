/**
 * INTENTIONAL ADR-0042 VIOLATION FIXTURE
 *
 * Deliberately violates the browser-tier rule for `@oscharko-dev/keiko-editor`: the editor package
 * must not value-import Node-only domain packages (`adr-0042-editor-not-node-domain-values`,
 * mirroring ADR-0019 direction rule 8 for keiko-ui). This fixture value-imports
 * `@oscharko-dev/keiko-model-gateway` — the canonical boundary the browser tier must never cross,
 * because the gateway is the single governed path for productive model calls — so
 * `scripts/arch-check-negative.mjs` can prove the rule fires by name (expected count: 1).
 *
 * Type-only imports of `@oscharko-dev/keiko-contracts` remain allowed and are exercised by the real
 * package source (`packages/keiko-editor/src`); only value imports of the Node-domain set fire.
 */
import * as modelGateway from "../../../../packages/keiko-model-gateway/src/index.js";

// Use the namespace import as a value so the edge is a value import (not type-only), mirroring the
// ui-browser fixture; this is what fires adr-0042-editor-not-node-domain-values.
export const violation: string = typeof modelGateway;
