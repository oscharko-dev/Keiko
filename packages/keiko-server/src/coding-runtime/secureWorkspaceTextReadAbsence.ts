import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Whether a workspace-relative path is provably not there, decided by the server because the native
 * secure-read helper cannot say (F27, #3876).
 *
 * The helper opens the root and then every component with `O_NOFOLLOW` and answers
 * `access-denied` for ANY open that fails: a missing file, a link, a file used as a directory, a
 * directory it may not read, an unusable root. It has no not-found status and its wire protocol is
 * pinned, so a missing file and a refused one look alike. That is the right answer to a read of
 * something that is there and the wrong one to the question a file creation asks, "is there nothing
 * here yet?": every creation through the replacement form was refused as `denied` and no live run
 * ever created a file.
 *
 * The answer is `absent` only when a no-follow walk from the root, one `lstat` per component,
 * reaches a component that does not exist while every component before it is a real directory on
 * the root's own device. Everything else is `undecided` and leaves the helper's denial standing:
 * the path exists, a component is a link (a dangling link at the final component included), a
 * directory is a file, the walk crossed onto another device, a probe failed for any reason other
 * than ENOENT, the root is not a real directory, or the request was aborted. The walk never probes
 * past a link or a missing component, so it does not look at what lives outside the workspace, and
 * it never claims that something exists.
 *
 * `absent` grants nothing. It is not a read, and it authorizes no write: the patch engine that
 * applies a created file re-validates containment, aliasing and the deny list and refuses to
 * overwrite a file that appeared in between (`packages/keiko-tools/src/patch.ts`). The walk is not
 * atomic, since a directory could be swapped for a link between two probes; the worst outcome is
 * `absent` for a path beyond that link, one bit about a location and no read, because the helper,
 * which opens every component relative to the previous handle, stays the authority for every read.
 */
export type WorkspacePathAbsence = "absent" | "undecided";

/** What one no-follow metadata probe reports; `dev` is exact so devices compare reliably. */
export interface WorkspacePathStat {
  readonly dev: bigint;
  isDirectory(): boolean;
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
  | { readonly kind: "other" };

const nodeLstat: WorkspacePathLstat = (absolutePath) => lstat(absolutePath, { bigint: true });

export async function proveWorkspacePathAbsent(
  request: WorkspacePathAbsenceRequest,
): Promise<WorkspacePathAbsence> {
  const probe = request.lstat ?? nodeLstat;
  const root = await probeComponent(probe, request.root);
  if (root.kind !== "directory") return "undecided";
  const verdict = await walkBelowRoot(probe, root.dev, request);
  // A request aborted while the walk ran proves nothing: the probes may describe a moment it left.
  return verdict === "absent" && request.signal?.aborted !== true ? "absent" : "undecided";
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
    if (request.signal?.aborted === true) return "undecided";
    current = join(current, directory);
    const found = await probeComponent(probe, current);
    if (found.kind === "missing") return "absent";
    if (found.kind !== "directory" || found.dev !== rootDevice) return "undecided";
  }
  const last = await probeComponent(probe, join(current, relativePath.slice(slash + 1)));
  return last.kind === "missing" ? "absent" : "undecided";
}

async function probeComponent(
  probe: WorkspacePathLstat,
  absolutePath: string,
): Promise<ProbedComponent> {
  try {
    const stat = await probe(absolutePath);
    return stat.isDirectory() ? { kind: "directory", dev: stat.dev } : { kind: "other" };
  } catch (error) {
    return isMissing(error) ? { kind: "missing" } : { kind: "other" };
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
