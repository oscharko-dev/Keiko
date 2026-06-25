// Governed Git delivery deployment-capability gate (Issue #473, Epic #470).
//
// A PURE, DEFAULT-FALSE predicate that decides whether this deployment is trusted to serve the
// governed Git delivery action-sheet surface. It mirrors the QI connector-authorisation pattern
// (qualityIntelligence/connectorAuthorization.ts): authorisation defaults to FALSE and only flips on
// an explicit, exact match — no reflection, no string coercion, no truthiness.
//
// Capability source: an environment flag read from `deps.env`. The action-sheet endpoint is a
// read-only/computational surface; gating it behind a deployment-owned env flag (never a request
// field, never client-asserted) keeps the AUTHORITY RULE (AC1) intact — the trust decision is the
// deployment's, not the caller's. An env flag (rather than a gateway-config flag) is chosen because
// the gateway config has no governed-Git-delivery field today and this surface is independent of the
// model gateway; the flag is the single, auditable on-switch for the whole #470 surface in the BFF.
//
// When the predicate returns false the projection produces a `blocked` action sheet with cause
// `provider-not-ready` (handled by buildGitDeliveryActionSheet when providerReady=false) rather than
// an error — a degraded-but-200 response, consistent with the QI connector routes.

import type { UiHandlerDeps } from "../deps.js";

// The single, deployment-owned on-switch for the governed Git delivery surface. The value must be the
// exact string "true"; any other value (including "1", "TRUE", or absent) leaves the surface off.
export const GIT_DELIVERY_ENABLED_ENV_FLAG = "KEIKO_GIT_DELIVERY_ENABLED" as const;

const isExplicitTrueFlag = (value: string | undefined): boolean => value === "true";

/**
 * True only when the deployment explicitly enabled the governed Git delivery surface via
 * `KEIKO_GIT_DELIVERY_ENABLED=true`. Pure, default-false, no IO. Reads ONLY trusted server-side env —
 * never a request field.
 */
export const isGitDeliveryTrusted = (deps: Pick<UiHandlerDeps, "env">): boolean =>
  isExplicitTrueFlag(deps.env[GIT_DELIVERY_ENABLED_ENV_FLAG]);
