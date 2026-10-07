import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the server found out about a workspace-relative path, decided by the server because the
 * native secure-read helper cannot say (F27, #3876).
 *
 * The helper opens the root and then every component with `O_NOFOLLOW` and answers
 * `access-denied` for ANY open that fails: a missing file, a link, a file used as a directory, a
 * directory it may not read, an unusable root. It has no not-found status and its wire protocol is
 * pinned, so a missing file and a refused one look alike. That is the right answer to a read of
 * something that is there and the wrong one to the question a file creation asks, "is there nothing
 * here yet?": every creation through the replacement form was refused as `denied` and no live run
 * ever created a file.
 *
 * The verdict is `absent` only when a no-follow walk from the root, one `lstat` per component,
 * reaches a component that does not exist while every component before it is a real directory on
 * the root's own device. Every other verdict leaves the helper's denial standing and names why the
 * walk could not say the path was absent, as one closed word (#3873 review: a creation refused as
 * `denied` could not be told apart in the log from a link, a path that exists or an unprobeable
 * directory, and the troubleshooting entry could only list the possibilities):
 *
 * - `exists`: the path is there: a file, or a directory at the final component.
 * - `link`: a component is a link: in the chain, or at the final component (a dangling link
 *   included, which `stat` would call absent and `lstat` sees as the link it is).
 * - `not-directory`: a component before the final one is not a directory, a file used as one.
 * - `foreign-device`: a directory in the chain lives on another device than the root (a mount).
 * - `probe-failed`: a metadata probe failed for any reason other than ENOENT (a directory that
 *   lost its search bit, an I/O error): the walk says nothing about the path, and the closed word
 *   never carries the error text or the path.
 * - `root-unusable`: the workspace root itself is not a real directory the walk can start from.
 * - `aborted`: the request was aborted or timed out while the walk ran, which discards an absence
 *   it reached: the probes may describe a moment the request left.
 *
 * The walk never probes past a link or a missing component, so it does not look at what lives
 * outside the workspace, and it never claims that something exists beyond what it saw itself.
 *
 * `absent` grants nothing. It is not a read, and it authorizes no write: the patch engine that
 * applies a created file re-validates containment, aliasing and the deny list and refuses to
 * overwrite a file that appeared in between (`packages/keiko-tools/src/patch.ts`). The walk is not
 * atomic, since a directory could be swapped for a link between two probes; the worst outcome is
 * `absent` for a path beyond that link, one bit about a location and no read, because the helper,
 * which opens every component relative to the previous handle, stays the authority for every read.
 */
export const WORKSPACE_PATH_ABSENCE_VERDICTS = [
  "absent",
  "exists",
  "link",
  "not-directory",
  "foreign-device",
  "probe-failed",
  "root-unusable",
  "aborted",
] as const;

export type WorkspacePathAbsence = (typeof WORKSPACE_PATH_ABSENCE_VERDICTS)[number];

/** What one no-follow metadata probe reports; `dev` is exact so devices compare reliably. */
export interface WorkspacePathStat {
  readonly dev: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** A metadata probe that never follows a link in the final component of its path. */
export type WorkspacePathLstat = (absolutePath: string) => Promise<WorkspacePathStat>;

export interface WorkspacePathAbsenceRequest {
  readonly root: string;
  /** Already validated by the caller: non-empty `/`-separated components, none `.`, `..` or empty. */
  readonly relativePath: string;
  readonly signal?: AbortSignal | undefined;
  /** Test seam; production uses `node:fs/promises` `lstat`. */
  readonly lstat?: WorkspacePathLstat | undefined;
}

type ProbedComponent =
  | { readonly kind: "missing" }
  | { readonly kind: "directory"; readonly dev: bigint }
  | { readonly kind: "link" }
  | { readonly kind: "other" }
  | { readonly kind: "failed" };

const nodeLstat: WorkspacePathLstat = (absolutePath) => lstat(absolutePath, { bigint: true });

export async function proveWorkspacePathAbsent(
  request: WorkspacePathAbsenceRequest,
): Promise<WorkspacePathAbsence> {
  const probe = request.lstat ?? nodeLstat;
  const root = await probeComponent(probe, request.root);
  if (root.kind !== "directory") return "root-unusable";
  const verdict = await walkBelowRoot(probe, root.dev, request);
  // A request aborted while the walk ran proves nothing: the probes may describe a moment it left.
  return verdict === "absent" && request.signal?.aborted === true ? "aborted" : verdict;
}

async function walkBelowRoot(
  probe: WorkspacePathLstat,
  rootDevice: bigint,
  request: WorkspacePathAbsenceRequest,
): Promise<WorkspacePathAbsence> {
  const { relativePath } = request;
  const slash = relativePath.lastIndexOf("/");
  const directories = slash === -1 ? [] : relativePath.slice(0, slash).split("/");
  let current = request.root;
  for (const directory of directories) {
    if (request.signal?.aborted === true) return "aborted";
    current = join(current, directory);
    const verdict = chainVerdict(await probeComponent(probe, current), rootDevice);
    if (verdict !== undefined) return verdict;
  }
  return finalVerdict(await probeComponent(probe, join(current, relativePath.slice(slash + 1))));
}

// A component before the final one: only a real directory on the root's own device lets the walk go
// on (`undefined`); a missing one ends it as absent, and anything else names why it cannot say.
function chainVerdict(
  found: ProbedComponent,
  rootDevice: bigint,
): WorkspacePathAbsence | undefined {
  switch (found.kind) {
    case "directory":
      return found.dev === rootDevice ? undefined : "foreign-device";
    case "missing":
      return "absent";
    case "link":
      return "link";
    case "other":
      return "not-directory";
    case "failed":
      return "probe-failed";
  }
}

// The final component is the path itself: missing is the absence the walk looked for, a link is
// named as one, and whatever else is there exists.
function finalVerdict(found: ProbedComponent): WorkspacePathAbsence {
  switch (found.kind) {
    case "missing":
      return "absent";
    case "link":
      return "link";
    case "failed":
      return "probe-failed";
    case "directory":
    case "other":
      return "exists";
  }
}

async function probeComponent(
  probe: WorkspacePathLstat,
  absolutePath: string,
): Promise<ProbedComponent> {
  try {
    const stat = await probe(absolutePath);
    if (stat.isSymbolicLink()) return { kind: "link" };
    return stat.isDirectory() ? { kind: "directory", dev: stat.dev } : { kind: "other" };
  } catch (error) {
    return isMissing(error) ? { kind: "missing" } : { kind: "failed" };
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
