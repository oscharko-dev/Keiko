import { posix as path } from "node:path";
import { readWorkspaceFile } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import { isDenied } from "./ignore.js";
import { resolveWithinWorkspace } from "./paths.js";
import { containedRealPathInfo } from "./realpath.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import { gatherCandidates, probeBinary } from "./repoSearchScan.js";
import { normalizeScopePath } from "./endpointContractPaths.js";

export interface SourceFile {
  readonly scopePath: string;
  readonly text: string;
}

const CLIENT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function isEndpointSource(scopePath: string): boolean {
  const ext = path.extname(scopePath).toLowerCase();
  return ext === ".java" || CLIENT_EXTENSIONS.has(ext);
}

async function readEndpointSource(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  scopePath: string,
): Promise<SourceFile | undefined> {
  try {
    const absolute = resolveWithinWorkspace(scope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, scope.workspace.root, absolute);
    if (isDenied(normalizeScopePath(contained.realRelative))) return undefined;
    const stat = fs.stat(contained.path);
    if (await probeBinary(fs, contained.path, stat.size)) return undefined;
    const text = readWorkspaceFile(
      scope.workspace,
      scopePath,
      { maxBytes: limits.maxBytesPerFileScanned },
      fs,
    ).text;
    return { scopePath, text };
  } catch {
    return undefined;
  }
}

export async function endpointSourceFiles(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
): Promise<readonly SourceFile[]> {
  const out: SourceFile[] = [];
  const candidates = gatherCandidates(scope, limits, fs).files.map((file) => file.relativePath);
  for (const scopePath of candidates) {
    if (!isEndpointSource(scopePath)) continue;
    const file = await readEndpointSource(scope, limits, fs, scopePath);
    if (file !== undefined) out.push(file);
  }
  return out;
}
