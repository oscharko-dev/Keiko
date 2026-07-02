import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { RepoSearchInvalidQueryError } from "./errors.js";
import { buildAtom } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { WorkspaceFs } from "./fs.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";
import { buildEndpointContractGraph } from "./endpointContractGraph.js";
import type {
  EndpointClientCallContract,
  EndpointContractLink,
  EndpointRouteContract,
} from "./endpointContractTypes.js";

function queryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: query.kind, text: query.text, tool: "endpoint-contract-linker" }),
    )
    .digest("hex")
    .slice(0, 16);
}

function queryTerms(query: RetrievalQuery): readonly string[] {
  return query.text
    .toLowerCase()
    .split(/[^a-z0-9_/:.-]+/u)
    .filter((term) => term.length > 1);
}

function containsEndpointIntent(query: RetrievalQuery): boolean {
  return /\b(api|endpoint|route|fetch|axios|client|frontend|controller|rest)\b/iu.test(query.text);
}

function textMatchesQuery(text: string | undefined, terms: readonly string[]): boolean {
  if (text === undefined) return false;
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term));
}

function linkTypeTerms(link: EndpointContractLink): readonly string[] {
  return [link.route.responseType, link.route.requestType, link.clientCall.responseType].filter(
    (value): value is string => value !== undefined,
  );
}

function linkMatchesQuery(link: EndpointContractLink, query: RetrievalQuery): boolean {
  const terms = queryTerms(query);
  if (query.kind === "exact-symbol") {
    return linkTypeTerms(link).some((term) => textMatchesQuery(term, [query.text]));
  }
  if (containsEndpointIntent(query)) return true;
  return (
    textMatchesQuery(link.normalizedPath, terms) ||
    textMatchesQuery(link.route.handler, terms) ||
    textMatchesQuery(link.route.responseType, terms) ||
    textMatchesQuery(link.clientCall.responseType, terms) ||
    (link.dtoEvidence?.sharedFields.some((field) => textMatchesQuery(field, terms)) ?? false)
  );
}

function atomForRoute(
  scope: SearchScope,
  route: EndpointRouteContract,
  fingerprint: string,
  score: number,
  nowMs: () => number,
): EvidenceAtom {
  return buildAtom({
    scopeId: scope.scopeId,
    scopePath: route.scopePath,
    lineRange: { startLine: route.line, endLine: route.line },
    provenanceKind: "structural",
    tool: "endpoint-contract-linker",
    queryFingerprint: fingerprint,
    score,
    emittedAtMs: nowMs(),
  });
}

function atomForClient(
  scope: SearchScope,
  call: EndpointClientCallContract,
  fingerprint: string,
  score: number,
  nowMs: () => number,
): EvidenceAtom {
  return buildAtom({
    scopeId: scope.scopeId,
    scopePath: call.scopePath,
    lineRange: { startLine: call.line, endLine: call.line },
    provenanceKind: "structural",
    tool: "endpoint-contract-linker",
    queryFingerprint: fingerprint,
    score,
    emittedAtMs: nowMs(),
  });
}

function linkAtoms(
  scope: SearchScope,
  link: EndpointContractLink,
  fingerprint: string,
  nowMs: () => number,
): readonly EvidenceAtom[] {
  return [
    atomForRoute(scope, link.route, fingerprint, link.confidence, nowMs),
    atomForClient(scope, link.clientCall, fingerprint, link.confidence, nowMs),
  ];
}

export const endpointContractAdapter: StructuralAdapter = {
  name: "endpoint-contract-linker",
  isAvailable: (): Promise<boolean> => Promise.resolve(true),
  lookup: async (
    scope: SearchScope,
    query: RetrievalQuery,
    limits: SearchLimits,
    fs: WorkspaceFs,
    deps?: StructuralAdapterDeps,
  ): Promise<readonly EvidenceAtom[]> => {
    if (query.kind !== "natural-language" && query.kind !== "exact-symbol") {
      throw new RepoSearchInvalidQueryError(
        `endpoint-contract-linker adapter does not accept query kind: ${query.kind}`,
      );
    }
    const nowMs = deps?.nowMs ?? Date.now;
    const fingerprint = queryFingerprint(query);
    const graph = await buildEndpointContractGraph(scope, limits, fs);
    const atoms = graph.links
      .filter((link) => linkMatchesQuery(link, query))
      .flatMap((link) => linkAtoms(scope, link, fingerprint, nowMs));
    return atoms.slice(0, Math.min(limits.maxMatchesReturned, query.maxResults));
  },
};
