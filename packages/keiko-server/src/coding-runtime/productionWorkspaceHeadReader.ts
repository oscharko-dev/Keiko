import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HEAD_BYTES = 4_096;
const PACKED_REFS_BYTES = 1_048_576;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF = /^refs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

/** Reads a live Git HEAD without a shell or ambient executable lookup. */
export function readProductionWorkspaceHead(
  workspaceRoot: string,
  repositoryRoot: string,
): string | undefined {
  try {
    const workspace = realpathSync(workspaceRoot);
    const commonRoot = resolveCommonRoot(repositoryRoot);
    const gitDir = resolveGitDir(workspace, commonRoot);
    if (gitDir === undefined) return undefined;
    const head = boundedText(join(gitDir, "HEAD"), HEAD_BYTES)?.trim();
    if (head === undefined) return undefined;
    if (SHA.test(head)) return head;
    const reference = head.startsWith("ref: ") ? head.slice(5) : "";
    if (!safeRef(reference)) return undefined;
    return readReference(gitDir, commonRoot, reference);
  } catch {
    return undefined;
  }
}

function resolveCommonRoot(repositoryRoot: string): string {
  const repository = realpathSync(repositoryRoot);
  const dotGit = join(repository, ".git");
  if (lstatSync(dotGit).isSymbolicLink()) throw new Error("repository-git-dir-invalid");
  if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
  const pointer = parseGitPointer(boundedText(dotGit, HEAD_BYTES));
  if (pointer === undefined) throw new Error("repository-git-dir-invalid");
  return realpathSync(resolve(repository, pointer));
}

function resolveGitDir(workspaceRoot: string, commonRoot: string): string | undefined {
  const dotGit = join(workspaceRoot, ".git");
  if (lstatSync(dotGit).isSymbolicLink()) return undefined;
  const pointed = resolve(workspaceRoot, parseGitPointer(boundedText(dotGit, HEAD_BYTES)) ?? "");
  if (!statSync(dotGit).isDirectory() && lstatSync(pointed).isSymbolicLink()) return undefined;
  const gitDir = statSync(dotGit).isDirectory() ? realpathSync(dotGit) : realpathSync(pointed);
  if (!contained(commonRoot, gitDir)) return undefined;
  return gitDir;
}

function readReference(gitDir: string, commonRoot: string, reference: string): string | undefined {
  const local = readLooseReference(gitDir, reference);
  if (local !== undefined) return local;
  const commonDir = resolveCommonDir(gitDir, commonRoot);
  const common = readLooseReference(commonDir, reference);
  if (common !== undefined) return common;
  return readPackedReference(commonDir, reference);
}

function resolveCommonDir(gitDir: string, commonRoot: string): string {
  const pointer = boundedText(join(gitDir, "commondir"), HEAD_BYTES)?.trim();
  if (pointer === undefined || pointer.length === 0) return commonRoot;
  const pointed = resolve(gitDir, pointer);
  if (lstatSync(pointed).isSymbolicLink()) throw new Error("git-common-dir-invalid");
  const candidate = realpathSync(pointed);
  if (!contained(commonRoot, candidate) && candidate !== commonRoot) {
    throw new Error("git-common-dir-invalid");
  }
  return candidate;
}

function readLooseReference(root: string, reference: string): string | undefined {
  try {
    const candidate = resolve(root, reference);
    if (!contained(root, dirname(candidate)) || realpathSync(candidate) !== candidate)
      return undefined;
    const value = boundedText(candidate, HEAD_BYTES)?.trim();
    return value !== undefined && SHA.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readPackedReference(root: string, reference: string): string | undefined {
  const packed = boundedText(join(root, "packed-refs"), PACKED_REFS_BYTES);
  if (packed === undefined) return undefined;
  for (const line of packed.split(/\r?\n/u)) {
    if (line.startsWith("#") || line.startsWith("^") || line.length === 0) continue;
    const separator = line.indexOf(" ");
    if (separator < 0 || line.slice(separator + 1) !== reference) continue;
    const value = line.slice(0, separator);
    return SHA.test(value) ? value : undefined;
  }
  return undefined;
}

function boundedText(path: string, maxBytes: number): string | undefined {
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseGitPointer(value: string | undefined): string | undefined {
  const pointer = value?.trim();
  if (!pointer?.startsWith("gitdir: ")) return undefined;
  const path = pointer.slice(8);
  return path.length > 0 && !path.includes("\0") ? path : undefined;
}

function safeRef(reference: string): boolean {
  return REF.test(reference) && !reference.includes("..") && !reference.includes("//");
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
