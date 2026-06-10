// Figma connector — scoped fetch + ready-signal resolution (Epic #750, Issue #751).
//
// Server-side only, read-only PAT, REST API only (no SDK, no MCP, no OAuth, no webhooks).
// From a pasted board/section link it fetches ONLY the scoped node subtree via
// `GET /v1/files/:key/nodes?ids=&depth=[&version=]` — never the whole-file endpoint — and
// resolves an advisory readiness signal. Output is the raw scoped node tree (handed to the
// IR cleaner in #752) plus token-free provenance.
//
// Token handling: the PAT is resolved from an injected config override or the
// `FIGMA_ACCESS_TOKEN` env var. It is materialised into the `X-Figma-Token` header at the
// transport boundary only; it is never logged, never returned, and never placed in any
// error or provenance. The HTTP transport is the injectable FigmaHttpPort so a future
// proxy/custom-CA client (#802) slots in without touching this logic.

import { FigmaConnectorError } from "./figmaConnectorErrors.js";
import type { FigmaHttpPort } from "./figmaHttpPort.js";
import {
  DEFAULT_FIGMA_RETRY_POLICY,
  fetchWithBackoff,
  realFigmaRetrySleep,
  type FigmaRetryPolicy,
  type FigmaRetrySleep,
} from "./figmaRetry.js";
import { parseFigmaTarget, type FigmaTarget } from "./figmaUrl.js";
import { resolveReadiness, type FigmaNode, type ReadinessSignal } from "./figmaReadiness.js";
import { classifyTokenFailure, resolveFigmaToken } from "./figmaTokenSource.js";
import {
  DEFAULT_SCOPED_PAGINATION_LIMITS,
  paginateScopedDocument,
  type FigmaScopeCoverage,
  type RawFigmaNode,
  type ScopedNodeFetcher,
  type ScopedPaginationLimits,
} from "./figmaScopedPagination.js";

const FIGMA_API_ORIGIN = "https://api.figma.com";
const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_NODE_COUNT = 5000;
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface FigmaConnectorConfig {
  readonly accessToken?: string;
  readonly depth?: number;
  readonly releaseMarker?: string;
  readonly maxNodeCount?: number;
  /**
   * Per-deployment overrides for the deep scoped-pagination budgets (#837). Any omitted field falls
   * back to {@link DEFAULT_SCOPED_PAGINATION_LIMITS}. Generic budgets — never tuned to a sample board.
   */
  readonly pagination?: Partial<ScopedPaginationLimits>;
}

export interface FigmaEnv {
  readonly FIGMA_ACCESS_TOKEN?: string;
}

export interface FigmaConnectorDeps {
  readonly http: FigmaHttpPort;
  readonly env: FigmaEnv;
  readonly config?: FigmaConnectorConfig;
  // Highest-precedence token source: the decrypted PAT from the encrypted vault (#758). When
  // absent the connector falls back to config then the FIGMA_ACCESS_TOKEN env var (the dev
  // default from #751), so the env-auth path keeps working unchanged with no vault entry.
  readonly vaultToken?: string;
  // Deterministic 429 backoff for the scoped fetch (#759); defaults to the bounded policy.
  readonly retryPolicy?: FigmaRetryPolicy;
  // Injectable wait seam so tests assert the backoff schedule without real delays.
  readonly sleep?: FigmaRetrySleep;
}

export interface FigmaFetchOptions {
  readonly version?: string;
  readonly fetchedAt?: string;
}

export interface FigmaProvenance {
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
}

export interface FigmaScopedResult {
  readonly nodes: FigmaNode;
  readonly provenance: FigmaProvenance;
  readonly readiness: ReadinessSignal;
  /**
   * Coverage telemetry, present only on the deep (`fetchScopedNodesDeep`) path (#837). Reports how
   * many screens were deep-fetched / truncated and the assembled node + fetch counts, so the build
   * can surface honest coverage instead of silently under-feeding the IR.
   */
  readonly coverage?: FigmaScopeCoverage;
}

export interface FigmaConnector {
  /** Single shallow scoped fetch (depth cap + oversize guard). Backwards-compatible entry point. */
  fetchScopedNodes(url: string, options?: FigmaFetchOptions): Promise<FigmaScopedResult>;
  /**
   * Bounded per-screen scoped-pagination fetch (#837): one shallow discovery fetch to enumerate
   * screens, then a bounded breadth-first deepening of each screen subtree so in-screen text survives
   * into the IR. Stays within the snapshot-build boundary; reports {@link FigmaScopeCoverage}.
   */
  fetchScopedNodesDeep(url: string, options?: FigmaFetchOptions): Promise<FigmaScopedResult>;
}

const resolveToken = (deps: FigmaConnectorDeps): string =>
  resolveFigmaToken({
    vaultToken: deps.vaultToken,
    configToken: deps.config?.accessToken,
    envToken: deps.env.FIGMA_ACCESS_TOKEN,
  });

const buildScopedUrl = (
  fileKey: string,
  nodeId: string,
  depth: number,
  version: string | undefined,
): string => {
  const url = new URL(`${FIGMA_API_ORIGIN}/v1/files/${encodeURIComponent(fileKey)}/nodes`);
  url.searchParams.set("ids", nodeId);
  url.searchParams.set("depth", String(depth));
  if (version !== undefined && version.length > 0) url.searchParams.set("version", version);
  return url.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Figma error bodies carry a short reason in `err` (occasionally `message`). We pass only that
// generic string to the structural classifier so a 403 resolves to the most specific coded error
// (expired / revoked / insufficient-scope) without ever surfacing the raw payload. The token is
// never part of a response body, so this cannot leak it.
const extractFigmaReason = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined;
  const reason = body.err ?? body.message;
  return typeof reason === "string" ? reason : undefined;
};

const statusToError = (status: number, body: unknown): FigmaConnectorError =>
  classifyTokenFailure(status, extractFigmaReason(body));

const extractDocument = (body: unknown, nodeId: string): RawFigmaNode => {
  if (!isRecord(body) || !isRecord(body.nodes)) throw new FigmaConnectorError("FIGMA_INTERNAL");
  const entry = body.nodes[nodeId];
  if (entry === undefined) throw new FigmaConnectorError("FIGMA_NOT_FOUND");
  if (!isRecord(entry) || !isRecord(entry.document)) {
    throw new FigmaConnectorError("FIGMA_INTERNAL");
  }
  return entry.document;
};

const countNodes = (node: RawFigmaNode): number => {
  let total = 1;
  for (const child of Array.isArray(node.children) ? node.children : []) total += countNodes(child);
  return total;
};

const guardScopeSize = (node: RawFigmaNode, maxNodeCount: number): void => {
  if (countNodes(node) > maxNodeCount) throw new FigmaConnectorError("FIGMA_OVERSIZED_SCOPE");
};

// A per-node deep fetch that hits one of these codes means the WHOLE build is compromised (auth lost,
// rate-limit exhausted, egress/TLS broken) — it must abort, not silently degrade a branch to shallow.
// Any other per-node failure (a transient 5xx or a vanished sub-node) is soft: that branch keeps its
// shallow content and the build proceeds with a truncation-aware coverage report.
const DEEP_FETCH_ABORT_CODES: ReadonlySet<string> = new Set([
  "FIGMA_TOKEN_MISSING",
  "FIGMA_TOKEN_INVALID",
  "FIGMA_TOKEN_EXPIRED",
  "FIGMA_TOKEN_REVOKED",
  "FIGMA_INSUFFICIENT_SCOPE",
  "FIGMA_CONSENT_REQUIRED",
  "FIGMA_RATE_LIMITED",
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_TLS_CA_FAILURE",
]);

// The resolved per-connector configuration, threaded into the module-level fetch functions so the
// factory closure stays small. Holds the injected transport + token sources + bounded policies.
interface ConnectorRuntime {
  readonly deps: FigmaConnectorDeps;
  readonly depth: number;
  readonly releaseMarker: string | undefined;
  readonly maxNodeCount: number;
  readonly retryPolicy: FigmaRetryPolicy;
  readonly sleep: FigmaRetrySleep;
  readonly paginationLimits: ScopedPaginationLimits;
}

// One scoped `nodes?ids=&depth=` fetch (with 429 backoff), returning the raw document. No oversize
// guard here — the shallow path applies it; the deep path is bounded by the pagination budgets. The
// token flows into the header only.
const fetchDocumentAt = async (
  rt: ConnectorRuntime,
  token: string,
  fileKey: string,
  nodeId: string,
  fetchDepth: number,
  version: string | undefined,
): Promise<RawFigmaNode> => {
  const requestUrl = buildScopedUrl(fileKey, nodeId, fetchDepth, version);
  const response = await fetchWithBackoff(
    () => rt.deps.http({ url: requestUrl, headers: { "X-Figma-Token": token } }),
    rt.retryPolicy,
    rt.sleep,
  );
  if (response.status < 200 || response.status >= 300) {
    throw statusToError(response.status, response.json);
  }
  return extractDocument(response.json, nodeId);
};

const provenanceFor = (target: FigmaTarget, options: FigmaFetchOptions): FigmaProvenance => ({
  fileKey: target.fileKey,
  nodeId: target.nodeId,
  version: options.version,
  fetchedAt: options.fetchedAt ?? EPOCH,
});

// RawFigmaNode → FigmaNode is a safe widening for the readiness reader (which tolerates absent fields).
const readinessFor = (
  rt: ConnectorRuntime,
  document: RawFigmaNode,
  version: string | undefined,
): ReadinessSignal =>
  resolveReadiness(document as unknown as FigmaNode, { version, releaseMarker: rt.releaseMarker });

const resolveTarget = (url: string): FigmaTarget => {
  const target = parseFigmaTarget(url);
  if (target === null) throw new FigmaConnectorError("FIGMA_MALFORMED_URL");
  return target;
};

const doFetchScopedNodes = async (
  rt: ConnectorRuntime,
  url: string,
  options: FigmaFetchOptions,
): Promise<FigmaScopedResult> => {
  const token = resolveToken(rt.deps);
  const target = resolveTarget(url);
  const document = await fetchDocumentAt(
    rt,
    token,
    target.fileKey,
    target.nodeId,
    rt.depth,
    options.version,
  );
  guardScopeSize(document, rt.maxNodeCount);
  return {
    nodes: document as unknown as FigmaNode,
    provenance: provenanceFor(target, options),
    readiness: readinessFor(rt, document, options.version),
  };
};

// The per-screen deepening fetcher: a hard (auth/rate/egress) code aborts the build; any other
// per-node failure degrades that branch to its shallow content (recorded as truncation in coverage).
const makeDeepFetcher = (
  rt: ConnectorRuntime,
  token: string,
  target: FigmaTarget,
  version: string | undefined,
): ScopedNodeFetcher => {
  return async (nodeId) => {
    try {
      return await fetchDocumentAt(
        rt,
        token,
        target.fileKey,
        nodeId,
        rt.paginationLimits.pageDepth,
        version,
      );
    } catch (err) {
      if (err instanceof FigmaConnectorError && DEEP_FETCH_ABORT_CODES.has(err.code)) throw err;
      return undefined;
    }
  };
};

const doFetchScopedNodesDeep = async (
  rt: ConnectorRuntime,
  url: string,
  options: FigmaFetchOptions,
): Promise<FigmaScopedResult> => {
  const token = resolveToken(rt.deps);
  const target = resolveTarget(url);

  // One shallow discovery fetch enumerates the screens (and resolves advisory readiness). No oversize
  // guard: a wide canvas is exactly what the deep path paginates. This is the FIRST, auth-establishing
  // egress; a hard failure here aborts before any per-screen fetch.
  const discovery = await fetchDocumentAt(
    rt,
    token,
    target.fileKey,
    target.nodeId,
    rt.depth,
    options.version,
  );
  const fetchNode = makeDeepFetcher(rt, token, target, options.version);
  const { document, coverage } = await paginateScopedDocument(
    discovery,
    fetchNode,
    rt.paginationLimits,
  );
  return {
    nodes: document as unknown as FigmaNode,
    provenance: provenanceFor(target, options),
    readiness: readinessFor(rt, document, options.version),
    coverage,
  };
};

export const createFigmaConnector = (deps: FigmaConnectorDeps): FigmaConnector => {
  const rt: ConnectorRuntime = {
    deps,
    depth: deps.config?.depth ?? DEFAULT_DEPTH,
    releaseMarker: deps.config?.releaseMarker,
    maxNodeCount: deps.config?.maxNodeCount ?? DEFAULT_MAX_NODE_COUNT,
    retryPolicy: deps.retryPolicy ?? DEFAULT_FIGMA_RETRY_POLICY,
    sleep: deps.sleep ?? realFigmaRetrySleep,
    paginationLimits: { ...DEFAULT_SCOPED_PAGINATION_LIMITS, ...deps.config?.pagination },
  };
  return {
    fetchScopedNodes: (url, options = {}) => doFetchScopedNodes(rt, url, options),
    fetchScopedNodesDeep: (url, options = {}) => doFetchScopedNodesDeep(rt, url, options),
  };
};
