// Governed Figma snapshot-build orchestration (Epic #750, Issues #758, #760, #759).
//
// The snapshot route was a thin happy-path that bypassed the governance machinery the epic's children
// built and unit-tested: the encrypted PAT vault (#758), the read-only-scope consent gate + audit
// ledger + operational metrics (#760). This module wires them into ONE governed build so every
// production snapshot is consent-gated, audited (success AND coded failure), metric-bearing, and
// resolves the PAT with the correct vault > config > env precedence — without changing any connector,
// builder, or store behaviour. Figma is contacted ONLY inside the bounded build (the boundary holds).
//
// Token handling stays server-side: the vault token (when present) flows into the connector's
// X-Figma-Token header only; it never reaches a return value, log, audit entry, metric, or snapshot.
// The vault degrades gracefully — an unconfigured vault yields `undefined` and the build falls back to
// the config/env token, so the existing env-auth path keeps working unchanged.

import { join } from "node:path";
import {
  appendFigmaConnectorAudit,
  assertReadOnlyConsent,
  buildFigmaSnapshot,
  createDefaultFigmaHttpPort,
  createDefaultFigmaRenderPort,
  createFigmaConnector,
  createFigmaTokenStore,
  deriveFigmaScopeRef,
  FigmaConnectorError,
  observeFigmaSnapshot,
  parseFigmaTarget,
  recordReadOnlyConsent,
  resolveFigmaToken,
  resolveFigmaVaultKey,
  type FigmaConnectorMetrics,
  type FigmaHttpPort,
  type FigmaKeychainAccess,
  type FigmaProvenance,
  type FigmaRenderPort,
  type FigmaScopeCoverage,
  type FigmaScopeRef,
  type FigmaSnapshot,
  type ScopedPaginationLimits,
} from "./figma/index.js";
import { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { EnvSource } from "@oscharko-dev/keiko-security";
import type { OutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway/internal/http";

const FIGMA_VAULT_SUBDIR = "figma";
const FIGMA_TOKEN_VAULT_FILE = "figma-token.vault";

type ScreenIrResult = QualityIntelligenceFigma.ScreenIrResult;

export interface GovernedSnapshotDeps {
  readonly evidenceDir: string;
  readonly env: EnvSource;
  /** Wall-clock for consent + audit timestamps; injected so tests stay deterministic. */
  readonly now: string;
  /** When true, record the read-only-scope acknowledgement before the fetch (operator consent). */
  readonly acknowledgeReadOnly?: boolean;
  /** Deep scoped-pagination overrides (#837). */
  readonly pagination?: Partial<ScopedPaginationLimits>;
  /** Shared enterprise egress settings for Figma API + render downloads (#802). */
  readonly egress?: OutboundHttpEgressConfig | undefined;
  /**
   * Creation-time overrides forwarded to the default HTTP and render ports when no explicit
   * httpPort/renderPort is injected. Currently only `timeoutMs` (maps to
   * KEIKO_FIGMA_REQUEST_TIMEOUT_MS). Ignored when httpPort/renderPort are injected directly
   * (route tests supply fakes that honour their own timeouts).
   */
  readonly portOptions?: { readonly timeoutMs?: number };
  // Injectable transports + keychain so route tests run without real egress or the login keychain.
  readonly httpPort?: FigmaHttpPort;
  readonly renderPort?: FigmaRenderPort;
  readonly keychainAccess?: FigmaKeychainAccess;
}

export interface GovernedSnapshotResult {
  readonly provenance: FigmaProvenance;
  readonly coverage: FigmaScopeCoverage | undefined;
  readonly snapshot: FigmaSnapshot;
  readonly ir: ScreenIrResult;
  readonly metrics: FigmaConnectorMetrics;
  readonly scopeRef: FigmaScopeRef;
}

const tokenVaultDir = (evidenceDir: string): string => join(evidenceDir, FIGMA_VAULT_SUBDIR);
const tokenVaultPath = (evidenceDir: string): string =>
  join(tokenVaultDir(evidenceDir), FIGMA_TOKEN_VAULT_FILE);

/**
 * Read the encrypted-at-rest vault PAT (#758), or `undefined` when no vault token is stored or the
 * vault key cannot be resolved. Highest precedence in {@link resolveFigmaToken}. Never throws — a
 * missing/unreadable vault degrades to the config/env token rather than failing the build.
 */
export const readFigmaVaultToken = (deps: GovernedSnapshotDeps): string | undefined => {
  try {
    const { key } = resolveFigmaVaultKey(
      deps.env,
      tokenVaultDir(deps.evidenceDir),
      deps.keychainAccess,
    );
    return createFigmaTokenStore({ key, storePath: tokenVaultPath(deps.evidenceDir) }).read();
  } catch {
    return undefined;
  }
};

/** Build the encrypted token store for operator rotation/revocation (#758). */
export const figmaTokenStoreFor = (
  deps: Pick<GovernedSnapshotDeps, "env" | "evidenceDir" | "keychainAccess">,
): ReturnType<typeof createFigmaTokenStore> => {
  const { key } = resolveFigmaVaultKey(
    deps.env,
    tokenVaultDir(deps.evidenceDir),
    deps.keychainAccess,
  );
  return createFigmaTokenStore({ key, storePath: tokenVaultPath(deps.evidenceDir) });
};

// Count deterministic a11y findings (#812) on the cleaned IR — the metric the #760 audit surfaces.
// Coverage-notice items are excluded: they record what could NOT be checked, not a finding.
const a11yFindingsCount = (ir: ScreenIrResult): number => {
  let count = 0;
  for (const items of QualityIntelligenceFigma.deriveA11yTestItemsByScreen(ir.screens).values()) {
    for (const item of items) if (item.category === "a11y") count += 1;
  }
  return count;
};

// Record (when acknowledged) and assert read-only-scope consent BEFORE any token materialisation or
// egress — an unconsented scope never reaches Figma (#760). Throws FIGMA_CONSENT_REQUIRED if missing.
const gateConsent = (deps: GovernedSnapshotDeps, scopeRef: FigmaScopeRef): void => {
  if (deps.acknowledgeReadOnly === true) {
    recordReadOnlyConsent({
      scopeRef,
      evidenceDir: deps.evidenceDir,
      acknowledgedBy: "operator",
      now: deps.now,
    });
  }
  assertReadOnlyConsent(scopeRef, deps.evidenceDir);
};

type FigmaConnector = ReturnType<typeof createFigmaConnector>;
type FigmaScopedResult = Awaited<ReturnType<FigmaConnector["fetchScopedNodesDeep"]>>;

// Deep scoped fetch with audit-on-failure: a fetch failure is recorded as a coded audit entry before
// it propagates, so the audit ledger captures the action even when the egress never produced a build.
const auditedDeepFetch = async (
  connector: FigmaConnector,
  boardLink: string,
  deps: GovernedSnapshotDeps,
  scopeRef: FigmaScopeRef,
  action: "snapshot" | "resnapshot",
): Promise<FigmaScopedResult> => {
  try {
    return await connector.fetchScopedNodesDeep(boardLink, { fetchedAt: deps.now });
  } catch (error) {
    appendFigmaConnectorAudit({
      scopeRef,
      evidenceDir: deps.evidenceDir,
      action,
      outcome: "error",
      errorCode: error instanceof FigmaConnectorError ? error.code : "FIGMA_INTERNAL",
      now: deps.now,
    });
    throw error;
  }
};

/**
 * Run the governed snapshot-build for `boardLink`: resolve the vault>config>env PAT, gate on recorded
 * read-only consent BEFORE any Figma egress, perform the deep scoped-pagination fetch + render, and
 * audit + compute metrics. Throws a coded {@link FigmaConnectorError} on any failure (the route maps
 * it to a status) — a fetch failure is audited before it propagates, a render failure inside the
 * observed wrapper likewise. `isResnapshot` only changes the audited action label.
 */
export const governedSnapshotBuild = async (
  boardLink: string,
  deps: GovernedSnapshotDeps,
  isResnapshot = false,
): Promise<GovernedSnapshotResult> => {
  const target = parseFigmaTarget(boardLink);
  if (target === null) throw new FigmaConnectorError("FIGMA_MALFORMED_URL");
  const scopeRef = deriveFigmaScopeRef(target.fileKey, target.nodeId);
  const httpPort =
    deps.httpPort ?? createDefaultFigmaHttpPort(deps.egress, undefined, deps.portOptions);
  const renderPort =
    deps.renderPort ?? createDefaultFigmaRenderPort(deps.egress, undefined, deps.portOptions);
  const vaultToken = readFigmaVaultToken(deps);

  gateConsent(deps, scopeRef);

  // Render-token (vault > config > env). Throws FIGMA_TOKEN_MISSING when nothing is configured.
  const token = resolveFigmaToken({ vaultToken, envToken: deps.env.FIGMA_ACCESS_TOKEN });
  const connector = createFigmaConnector({
    http: httpPort,
    env: deps.env,
    ...(vaultToken !== undefined ? { vaultToken } : {}),
    config: { pagination: deps.pagination ?? {} },
  });

  const action = isResnapshot ? "resnapshot" : "snapshot";
  const scoped = await auditedDeepFetch(connector, boardLink, deps, scopeRef, action);
  const ir = QualityIntelligenceFigma.cleanScopedNodesToScreenIr(scoped.nodes);
  const observed = await observeFigmaSnapshot({
    ctx: { evidenceDir: deps.evidenceDir, now: deps.now },
    provenance: scoped.provenance,
    ir,
    // The snapshot-build itself is fully deterministic (no model) — the model-augmentation share is
    // the QI test-gen concern (#754). Here it is 0/0 → a 0 model-augmented share (100% deterministic).
    augmentation: { deterministic: 0, modelAugmented: 0 },
    extras: { a11yFindings: a11yFindingsCount(ir) },
    isResnapshot,
    run: () =>
      buildFigmaSnapshot({
        ir,
        provenance: scoped.provenance,
        token,
        imagesPort: httpPort,
        renderPort,
      }),
  });

  return {
    provenance: scoped.provenance,
    coverage: scoped.coverage,
    snapshot: observed.snapshot,
    ir,
    metrics: observed.metrics,
    scopeRef,
  };
};
