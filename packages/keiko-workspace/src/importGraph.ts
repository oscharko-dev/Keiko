// Import-graph adapter (Epic #177, Issue #180). Pure-JS regex extractor: scans discovered
// files for ESM imports/re-exports and CJS requires, emits an EvidenceAtom for each file
// whose specifier matches the query text. Fixed, anchored, non-nested-quantifier regexes
// keep the scan ReDoS-safe; the binary probe and read cap come from the shared workspace
// primitives. Stays within ADR-0019 rule 3b: imports only @oscharko-dev/keiko-contracts,
// sibling workspace modules, and Node stdlib (node:crypto).

import { createHash } from "node:crypto";
import type { EvidenceAtom, RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { looksBinary } from "./binaryDetect.js";
import { readWorkspaceFile } from "./discovery.js";
import { RepoSearchInvalidQueryError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
import { buildAtom, gatherCandidates } from "./repoSearchScan.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type { StructuralAdapter, StructuralAdapterDeps } from "./structuralAdapters.js";

function queryFingerprint(query: RetrievalQuery): string {
  const canonical = JSON.stringify({ kind: query.kind, text: query.text });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ESM static imports: import X from "y"; import * as X from "y"; import "y"; import { X } from "y".
// [ \t]+\S+ tokens in the import clause avoid ReDoS: [ \t] and \S are complementary so the engine
// never tries alternative splits. [ \t] (not \s) prevents the clause from crossing newlines.
const ESM_IMPORT = /^\s*import(?:[ \t]+\S+(?:[ \t]+\S+)*[ \t]+from)?\s+["']([^"'\n]+)["']/gm;
// ESM re-exports: export * from "y"; export { X } from "y".
const ESM_REEXPORT = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/gm;
// CommonJS: require("y").
const CJS_REQUIRE = /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const BINARY_PROBE_BYTES = 512;

interface ScanContext {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly limits: SearchLimits;
  readonly query: RetrievalQuery;
  readonly fingerprint: string;
  readonly startMs: number;
  readonly nowMs: () => number;
}

async function probeBinary(fs: WorkspaceFs, abs: string, size: number): Promise<boolean> {
  const cap = Math.min(BINARY_PROBE_BYTES, size);
  if (cap === 0) {
    return false;
  }
  if (fs.readFileBytes !== undefined) {
    return looksBinary(await fs.readFileBytes(abs, cap));
  }
  const text = fs.readFileUtf8(abs);
  return looksBinary(new TextEncoder().encode(text.slice(0, cap)));
}

function specifierMatches(specifier: string, query: RetrievalQuery): boolean {
  if (query.kind === "exact-symbol") {
    return specifier === query.text;
  }
  return specifier.toLowerCase().includes(query.text.toLowerCase());
}

function scoreFor(specifier: string, query: RetrievalQuery): number {
  return specifier === query.text ? 1.0 : 0.7;
}

function lineNumberOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

interface Hit {
  readonly specifier: string;
  readonly line: number;
}

function collectHits(text: string, query: RetrievalQuery): readonly Hit[] {
  const hits: Hit[] = [];
  for (const regex of [ESM_IMPORT, ESM_REEXPORT, CJS_REQUIRE]) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null = regex.exec(text);
    while (m !== null) {
      const specifier = m[1] ?? "";
      if (specifierMatches(specifier, query)) {
        hits.push({ specifier, line: lineNumberOf(text, m.index) });
      }
      m = regex.exec(text);
    }
  }
  return hits;
}

function emitHitAtom(ctx: ScanContext, relativePath: string, hit: Hit): EvidenceAtom {
  return buildAtom({
    scopeId: ctx.scope.scopeId,
    scopePath: relativePath,
    lineRange: { startLine: hit.line, endLine: hit.line },
    provenanceKind: "structural",
    tool: "import-graph",
    queryFingerprint: ctx.fingerprint,
    score: scoreFor(hit.specifier, ctx.query),
    emittedAtMs: ctx.nowMs(),
  });
}

function elapsedOver(ctx: ScanContext): boolean {
  return ctx.nowMs() - ctx.startMs > ctx.limits.elapsedMsMax;
}

async function scanFileForImports(
  ctx: ScanContext,
  relativePath: string,
  atoms: EvidenceAtom[],
): Promise<void> {
  const abs = resolveWithinWorkspace(ctx.scope.workspace.root, relativePath);
  const containedAbs = assertContainedRealPath(ctx.fs, ctx.scope.workspace.root, abs, "scope");
  const stat = ctx.fs.stat(containedAbs);
  if (stat.hardLinkCount !== undefined && stat.hardLinkCount > 1) {
    return;
  }
  if (await probeBinary(ctx.fs, containedAbs, stat.size)) {
    return;
  }
  const content = readWorkspaceFile(
    ctx.scope.workspace,
    relativePath,
    { maxBytes: ctx.limits.maxBytesPerFileScanned },
    ctx.fs,
  );
  const hits = collectHits(content.text, ctx.query);
  for (const hit of hits) {
    if (atoms.length >= ctx.limits.maxMatchesReturned) {
      return;
    }
    atoms.push(emitHitAtom(ctx, relativePath, hit));
  }
}

export const importGraphAdapter: StructuralAdapter = {
  name: "import-graph",
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
        `import-graph adapter does not accept query kind: ${query.kind}`,
      );
    }
    const ctx: ScanContext = {
      scope,
      fs,
      limits,
      query,
      fingerprint: queryFingerprint(query),
      startMs: (deps?.nowMs ?? Date.now)(),
      nowMs: deps?.nowMs ?? Date.now,
    };
    const candidateSet = gatherCandidates(scope, limits, fs);
    const atoms: EvidenceAtom[] = [];
    for (const file of candidateSet.files) {
      if (atoms.length >= limits.maxMatchesReturned || elapsedOver(ctx)) {
        break;
      }
      await scanFileForImports(ctx, file.relativePath, atoms);
    }
    return atoms;
  },
};
