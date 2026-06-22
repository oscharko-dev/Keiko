/**
 * INTENTIONAL ADR-0042 VIOLATION FIXTURE
 *
 * Deliberately violates the browser-tier rule for `@oscharko-dev/keiko-editor`: the editor package
 * must not value-import Node-only domain packages (`adr-0042-editor-not-node-domain-values`,
 * mirroring ADR-0019 direction rule 8 for keiko-ui). This fixture value-imports the canonical
 * model-gateway boundary plus each ADR-0042 audit-gap target that exists in this repo:
 * memory-vault, memory-capture, memory-consolidation, memory-governance, memory-retrieval,
 * verification, and keiko-ui internals. `scripts/arch-check-negative.mjs` proves the rule fires
 * by name for each edge (expected count: 8).
 *
 * Type-only imports of `@oscharko-dev/keiko-contracts` remain allowed and are exercised by the real
 * package source (`packages/keiko-editor/src`); only value imports of the Node-domain set fire.
 */
import * as modelGateway from "../../../../packages/keiko-model-gateway/src/index.js";
import * as memoryCapture from "../../../../packages/keiko-memory-capture/src/index.js";
import * as memoryConsolidation from "../../../../packages/keiko-memory-consolidation/src/index.js";
import * as memoryGovernance from "../../../../packages/keiko-memory-governance/src/index.js";
import * as memoryRetrieval from "../../../../packages/keiko-memory-retrieval/src/index.js";
import * as memoryVault from "../../../../packages/keiko-memory-vault/src/index.js";
import * as verification from "../../../../packages/keiko-verification/src/index.js";
import * as uiInternals from "../../../../packages/keiko-ui/src/lib/format.js";

// Use the namespace import as a value so the edge is a value import (not type-only), mirroring the
// ui-browser fixture; this is what fires adr-0042-editor-not-node-domain-values.
export const violation: string = [
  typeof modelGateway,
  typeof memoryCapture,
  typeof memoryConsolidation,
  typeof memoryGovernance,
  typeof memoryRetrieval,
  typeof memoryVault,
  typeof verification,
  typeof uiInternals,
].join(":");
