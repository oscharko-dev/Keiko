/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Deliberately violates direction rule 8: the browser-tier UI package must not value-import
 * Node-only domain packages. The rule fires three times here, pinning three distinct Node-domain
 * boundaries (cf. the workflows fixture, which intentionally fires twice):
 *   1. keiko-tools — a Node-only package that does not also trigger the UI model-gateway trust rules.
 *   2. keiko-quality-intelligence — the pure-domain leaf (ADR-0023 D14). The native Quality
 *      Intelligence UI (issue #280) must reach QI only through keiko-contracts wire shapes and the
 *      same-origin BFF, never by value-importing the Node-side domain package.
 *   3. keiko-local-knowledge — the source-ingestion/runtime domain the QI RunLauncher draws on. The
 *      UI must consume it via the @/lib/local-knowledge-api BFF client, never the Node package.
 *
 * The two QI/LK lines guard against a regression that re-introduces a Node-domain reach-through into
 * a future QI UI surface; without them the direction-8 to.path would silently omit the two packages
 * most relevant to the QI UI feature.
 */
import { violationTarget } from "../../../../packages/keiko-tools/src/index.js";
import * as qiDomain from "../../../../packages/keiko-quality-intelligence/src/index.js";
import * as lkDomain from "../../../../packages/keiko-local-knowledge/src/index.js";

export const violation: string =
  typeof violationTarget === "string"
    ? violationTarget
    : "intentional ADR-0019 violation fixture (ui browser boundary)";

export const qiViolation: string = typeof qiDomain;
export const lkViolation: string = typeof lkDomain;
