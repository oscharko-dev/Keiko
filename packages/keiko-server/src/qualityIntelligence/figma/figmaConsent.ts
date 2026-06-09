// Recorded read-only-scope consent for the Figma connector (Epic #750, Issue #760).
//
// There is NO OAuth grant flow: the operator mints a least-privilege, READ-ONLY Personal Access
// Token out of band. Before the FIRST scoped fetch for a connected scope, the operator must
// explicitly acknowledge that the configured PAT is read-only and least-privilege; this module
// records that acknowledgement as durable evidence. The expected scopes are DISPLAY-ONLY — the
// connector cannot grant or widen anything; it only shows what a least-privilege read-only token
// covers so the operator can confirm before the first fetch.
//
// The consent record carries NO token, NO PII, and NO board id / link / content — only the opaque
// `scopeRef`, the acknowledged read-only flag, an optional operator label, and a timestamp. It is
// persisted through the SAME reused Evidence contained-store seam as the connector audit.

import {
  createNodeContainedJsonArtifactStore,
  type ContainedJsonArtifactStore,
} from "@oscharko-dev/keiko-evidence";
import { FigmaConnectorError } from "./figmaConnectorErrors.js";
import type { FigmaScopeRef } from "./figmaScopeRef.js";

export const FIGMA_CONSENT_SCHEMA_VERSION = 1 as const;
const FIGMA_CONSENT_SUFFIX = ".figma-consent.json";

/**
 * Display-only list of the least-privilege, read-only Figma scopes the connector relies on. Shown to
 * the operator before the first fetch so they can confirm the PAT they minted is read-only. The
 * connector reads files and renders images; it never writes. Figma PAT scopes are coarse, so this is
 * the human-readable expectation, not an enforced grant.
 */
export const EXPECTED_FIGMA_SCOPES: readonly string[] = ["files:read", "file_dev_resources:read"];

export interface FigmaScopeConsent {
  readonly figmaConsentSchemaVersion: typeof FIGMA_CONSENT_SCHEMA_VERSION;
  readonly scopeRef: FigmaScopeRef;
  /** Always true once recorded: the operator acknowledged the read-only, least-privilege scope. */
  readonly readOnlyAcknowledged: true;
  /** Display-only echo of the scopes acknowledged. No token, no board reference. */
  readonly acknowledgedScopes: readonly string[];
  readonly acknowledgedBy: string;
  readonly acknowledgedAt: string;
}

const parseConsent = (value: unknown): FigmaScopeConsent | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.figmaConsentSchemaVersion !== FIGMA_CONSENT_SCHEMA_VERSION) return undefined;
  if (typeof record.scopeRef !== "string" || record.readOnlyAcknowledged !== true) return undefined;
  return value as FigmaScopeConsent;
};

const storeFor = (evidenceDir: string): ContainedJsonArtifactStore<FigmaScopeConsent> =>
  createNodeContainedJsonArtifactStore(evidenceDir, FIGMA_CONSENT_SUFFIX, { parse: parseConsent });

export const loadReadOnlyConsent = (
  scopeRef: FigmaScopeRef,
  evidenceDir: string,
): FigmaScopeConsent | undefined => storeFor(evidenceDir).load(scopeRef);

export const hasReadOnlyConsent = (scopeRef: FigmaScopeRef, evidenceDir: string): boolean =>
  loadReadOnlyConsent(scopeRef, evidenceDir) !== undefined;

export interface RecordReadOnlyConsentInput {
  readonly scopeRef: FigmaScopeRef;
  readonly evidenceDir: string;
  readonly acknowledgedBy: string;
  readonly now: string;
}

/**
 * Record the operator's explicit acknowledgement of the read-only, least-privilege scope. Idempotent
 * by overwrite (re-acknowledging refreshes the timestamp). Returns the stored consent record.
 */
export const recordReadOnlyConsent = (input: RecordReadOnlyConsentInput): FigmaScopeConsent => {
  const consent: FigmaScopeConsent = {
    figmaConsentSchemaVersion: FIGMA_CONSENT_SCHEMA_VERSION,
    scopeRef: input.scopeRef,
    readOnlyAcknowledged: true,
    acknowledgedScopes: EXPECTED_FIGMA_SCOPES,
    acknowledgedBy: input.acknowledgedBy,
    acknowledgedAt: input.now,
  };
  storeFor(input.evidenceDir).record(input.scopeRef, consent);
  return consent;
};

/**
 * Gate the first fetch on recorded consent. Throws a coded, safe error when the operator has not yet
 * acknowledged the read-only scope for this connected scope. The connector calls this BEFORE token
 * materialisation so an unconsented scope never reaches Figma.
 */
export const assertReadOnlyConsent = (scopeRef: FigmaScopeRef, evidenceDir: string): void => {
  if (!hasReadOnlyConsent(scopeRef, evidenceDir)) {
    throw new FigmaConnectorError("FIGMA_CONSENT_REQUIRED");
  }
};
