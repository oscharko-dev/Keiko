// The EvidenceStore PORT + node adapter (ADR-0010 D4). A single manifest-record-typed port
// (read+write+list+delete) keeps all real IO in one auditable place and makes the layer testable
// with an in-memory store. We deliberately introduce a new port rather than reuse the #6
// WorkspaceWriter, which has no read/list capability that D5 requires.
//
// Safety: the node adapter realpath-contains its base dir once at construction (reusing the #5/#6
// primitives), every filename is derived from a VALIDATED runId (assertValidRunId), and the
// resolved child path is re-checked to remain inside the contained base dir before any write,
// read, or delete. Writes are atomic (temp + rename, same dir = same filesystem). list() returns
// only real `<runId>.json` files and never follows a symlink (lstat skip).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nodeWorkspaceFs, type WorkspaceFs } from "../workspace/fs.js";
import { resolveWithinWorkspace } from "../workspace/paths.js";
import { assertContainedRealPath } from "../workspace/realpath.js";
import { EvidenceWriteError } from "./errors.js";
import { assertValidRunId } from "./runid.js";

const MANIFEST_SUFFIX = ".json";

// The workspace-relative default evidence base dir (ADR-0010 D4): predictable, local, .gitignored.
export const DEFAULT_EVIDENCE_DIR = "./.keiko/evidence";

// Single source of the output-location precedence (ADR-0010 D4): an explicit value (CLI
// --evidence-dir) wins over the KEIKO_EVIDENCE_DIR env var, which wins over the default. Shared by
// the CLI run command and the SDK persistEvidence default so both resolve identically.
export function resolveEvidenceDir(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string {
  return explicit ?? env?.KEIKO_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR;
}

export interface EvidenceStore {
  // Persist one manifest atomically under the base dir, named <runId>.json. Returns the path.
  readonly put: (runId: string, json: string) => string;
  // List runIds present in the base dir (deterministic, sorted), reading ONLY the base dir.
  readonly list: () => readonly string[];
  // Load one manifest's raw JSON by runId, or undefined if absent.
  readonly get: (runId: string) => string | undefined;
  // Delete one ledger-created manifest by runId (retention, D6). No-op if absent.
  readonly delete: (runId: string) => void;
}

// ─── In-memory store (tests) ──────────────────────────────────────────────────────

export function createInMemoryEvidenceStore(): EvidenceStore {
  const data = new Map<string, string>();
  return {
    put: (runId: string, json: string): string => {
      assertValidRunId(runId);
      data.set(runId, json);
      return `${runId}${MANIFEST_SUFFIX}`;
    },
    list: (): readonly string[] => [...data.keys()].sort(),
    get: (runId: string): string | undefined => {
      assertValidRunId(runId);
      return data.get(runId);
    },
    delete: (runId: string): void => {
      assertValidRunId(runId);
      data.delete(runId);
    },
  };
}

// ─── Node adapter ──────────────────────────────────────────────────────────────────

// Resolves the base dir, creates it if absent, then realpath-contains it against itself so the
// returned path is the canonical (symlink-followed) base every child path is checked against.
function prepareBaseDir(baseDir: string, fs: WorkspaceFs): string {
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch (error) {
    throw new EvidenceWriteError(
      `cannot create evidence directory: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return fs.realPath(baseDir);
}

// Returns the realpath-contained absolute path of <runId>.json inside the base dir, or throws if it
// would escape. The runId is validated first so no separator/`..`/NUL can reach the join.
function containedManifestPath(runId: string, realBase: string, fs: WorkspaceFs): string {
  assertValidRunId(runId);
  const lexical = resolveWithinWorkspace(realBase, `${runId}${MANIFEST_SUFFIX}`);
  return assertContainedRealPath(fs, realBase, lexical, `${runId}${MANIFEST_SUFFIX}`);
}

function isManifestName(name: string): boolean {
  if (!name.endsWith(MANIFEST_SUFFIX)) {
    return false;
  }
  const runId = name.slice(0, name.length - MANIFEST_SUFFIX.length);
  try {
    assertValidRunId(runId);
    return true;
  } catch {
    return false;
  }
}

function listManifestRunIds(realBase: string): readonly string[] {
  const runIds: string[] = [];
  for (const entry of readdirSync(realBase, { withFileTypes: true })) {
    // Never follow a symlink: only count entries the ledger itself wrote as regular files.
    if (entry.isSymbolicLink() || !entry.isFile() || !isManifestName(entry.name)) {
      continue;
    }
    runIds.push(entry.name.slice(0, entry.name.length - MANIFEST_SUFFIX.length));
  }
  return runIds.sort();
}

function atomicWrite(target: string, json: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    // O_EXCL ("wx"): refuse to open through a pre-planted symlink at the temp path, closing the
    // temp-vs-final containment asymmetry (the final target is realpath-contained, the temp was
    // not). A randomUUID suffix never collides, so "wx" never spuriously fails.
    writeFileSync(temp, json, { encoding: "utf8", flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `evidence write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

export function createNodeEvidenceStore(
  baseDir: string,
  fs: WorkspaceFs = nodeWorkspaceFs,
  randomSuffix: () => string = randomUUID,
): EvidenceStore {
  const realBase = prepareBaseDir(baseDir, fs);
  return {
    put: (runId: string, json: string): string => {
      const target = containedManifestPath(runId, realBase, fs);
      atomicWrite(target, json, randomSuffix);
      return target;
    },
    list: (): readonly string[] => listManifestRunIds(realBase),
    get: (runId: string): string | undefined => {
      assertValidRunId(runId);
      const target = join(realBase, `${runId}${MANIFEST_SUFFIX}`);
      if (lstatSync(target, { throwIfNoEntry: false })?.isFile() !== true) {
        return undefined;
      }
      return readFileSync(target, "utf8");
    },
    delete: (runId: string): void => {
      const target = containedManifestPath(runId, realBase, fs);
      rmSync(target, { force: true });
    },
  };
}
