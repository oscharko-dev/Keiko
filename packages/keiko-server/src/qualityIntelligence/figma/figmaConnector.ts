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
import { parseFigmaTarget, type FigmaTarget } from "./figmaUrl.js";
import { resolveReadiness, type FigmaNode, type ReadinessSignal } from "./figmaReadiness.js";

const FIGMA_API_ORIGIN = "https://api.figma.com";
const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_NODE_COUNT = 5000;
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface FigmaConnectorConfig {
  readonly accessToken?: string;
  readonly depth?: number;
  readonly releaseMarker?: string;
  readonly maxNodeCount?: number;
}

export interface FigmaEnv {
  readonly FIGMA_ACCESS_TOKEN?: string;
}

export interface FigmaConnectorDeps {
  readonly http: FigmaHttpPort;
  readonly env: FigmaEnv;
  readonly config?: FigmaConnectorConfig;
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
}

export interface FigmaConnector {
  fetchScopedNodes(url: string, options?: FigmaFetchOptions): Promise<FigmaScopedResult>;
}

const resolveToken = (deps: FigmaConnectorDeps): string => {
  const candidate = deps.config?.accessToken ?? deps.env.FIGMA_ACCESS_TOKEN ?? "";
  const token = candidate.trim();
  if (token.length === 0) throw new FigmaConnectorError("FIGMA_TOKEN_MISSING");
  return token;
};

const buildScopedUrl = (
  target: FigmaTarget,
  depth: number,
  version: string | undefined,
): string => {
  const url = new URL(`${FIGMA_API_ORIGIN}/v1/files/${encodeURIComponent(target.fileKey)}/nodes`);
  url.searchParams.set("ids", target.nodeId);
  url.searchParams.set("depth", String(depth));
  if (version !== undefined && version.length > 0) url.searchParams.set("version", version);
  return url.toString();
};

const statusToError = (status: number): FigmaConnectorError => {
  if (status === 404) return new FigmaConnectorError("FIGMA_NOT_FOUND");
  if (status === 401 || status === 403) return new FigmaConnectorError("FIGMA_INSUFFICIENT_SCOPE");
  if (status >= 500) return new FigmaConnectorError("FIGMA_UPSTREAM_UNAVAILABLE");
  return new FigmaConnectorError("FIGMA_INTERNAL");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractDocument = (body: unknown, nodeId: string): FigmaNode => {
  if (!isRecord(body) || !isRecord(body.nodes)) throw new FigmaConnectorError("FIGMA_INTERNAL");
  const entry = body.nodes[nodeId];
  if (entry === undefined) throw new FigmaConnectorError("FIGMA_NOT_FOUND");
  if (!isRecord(entry) || !isRecord(entry.document)) {
    throw new FigmaConnectorError("FIGMA_INTERNAL");
  }
  return entry.document as unknown as FigmaNode;
};

const countNodes = (node: FigmaNode): number => {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
};

const guardScopeSize = (node: FigmaNode, maxNodeCount: number): void => {
  if (countNodes(node) > maxNodeCount) throw new FigmaConnectorError("FIGMA_OVERSIZED_SCOPE");
};

export const createFigmaConnector = (deps: FigmaConnectorDeps): FigmaConnector => {
  const depth = deps.config?.depth ?? DEFAULT_DEPTH;
  const releaseMarker = deps.config?.releaseMarker;
  const maxNodeCount = deps.config?.maxNodeCount ?? DEFAULT_MAX_NODE_COUNT;

  const fetchScopedNodes = async (
    url: string,
    options: FigmaFetchOptions = {},
  ): Promise<FigmaScopedResult> => {
    const token = resolveToken(deps);
    const target = parseFigmaTarget(url);
    if (target === null) throw new FigmaConnectorError("FIGMA_MALFORMED_URL");

    const requestUrl = buildScopedUrl(target, depth, options.version);
    const response = await deps.http({ url: requestUrl, headers: { "X-Figma-Token": token } });
    if (response.status < 200 || response.status >= 300) throw statusToError(response.status);

    const document = extractDocument(response.json, target.nodeId);
    guardScopeSize(document, maxNodeCount);

    return {
      nodes: document,
      provenance: {
        fileKey: target.fileKey,
        nodeId: target.nodeId,
        version: options.version,
        fetchedAt: options.fetchedAt ?? EPOCH,
      },
      readiness: resolveReadiness(document, { version: options.version, releaseMarker }),
    };
  };

  return { fetchScopedNodes };
};
