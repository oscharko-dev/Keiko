// Server-owned approval for repository-authored package scripts, now persisted (issue #2521,
// ADR-0147 D3/D8). A grant is bound to the registered project's canonical root, the resolved
// workspace root, and the exact package.json digest observed when the human approved it, and is
// stored as a canonical, revisioned WorkspaceTrustRecord in the uiDb (one transaction domain). Any
// manifest or root change invalidates the grant — persisting a restricted record at a newer revision
// so a restored older manifest never resurrects it — before either the command runner or editor
// verification can execute a script. Trust survives server restarts; an absent store trusts nothing.
//
// The public interface and the derived binary decider `(projectId, workspace) => boolean` are
// unchanged: consumers keep their existing fail-closed decider seams. The canonical binding derivation
// lives in ./workspaceTrust/canonicalTrustIdentity.ts; the row persistence lives in the UiStore.

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CodedHttpError,
  httpStatusFor,
  projectCommandTaskTrustState,
  validateWorkspaceManifest,
  validateWorkspaceTrustRecord,
  WORKSPACE_TRUST_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts";
import type {
  WorkspaceFact,
  WorkspaceManifest,
  WorkspaceTrustAssessment,
  WorkspaceTrustBasisDigest,
  WorkspaceTrustBinding,
  WorkspaceTrustLevel,
  WorkspaceTrustReason,
  WorkspaceTrustRecord,
  WorkspaceTrustStatus,
} from "@oscharko-dev/keiko-contracts";
import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type {
  UiStore,
  WorkspaceTrustRecordRow,
  WorkspaceTrustRecordRowInput,
} from "./store/index.js";
import {
  deriveWorkspaceRootRef,
  deriveWorkspaceTrustBinding,
} from "./workspaceTrust/canonicalTrustIdentity.js";

const PACKAGE_MANIFEST_MAX_BYTES = 262_144;
const TRUST_POLICY_VERSION = "m11.trust.1";
// Bounded number of persisted per-root trust records. Canonical roots are few, but a long-lived
// install must never grow this table without limit; pruning keeps the most-recently-updated rows.
const MAX_TRUST_RECORDS = 4_096;

export const WORKSPACE_SCRIPT_TRUST_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  PACKAGE_MANIFEST_UNAVAILABLE: "PACKAGE_MANIFEST_UNAVAILABLE",
  WORKSPACE_STATE_UNAVAILABLE: "WORKSPACE_STATE_UNAVAILABLE",
} as const;

export type WorkspaceScriptTrustErrorCode =
  (typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES)[keyof typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES];

const STATUS_MAP: Readonly<Record<WorkspaceScriptTrustErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  PACKAGE_MANIFEST_UNAVAILABLE: 422,
  // The project is registered but its workspace state cannot be read (ADR-0147 D9 fail-closed).
  WORKSPACE_STATE_UNAVAILABLE: 503,
};

export class WorkspaceScriptTrustError extends CodedHttpError {
  public readonly code: WorkspaceScriptTrustErrorCode;

  public constructor(code: WorkspaceScriptTrustErrorCode, message: string) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
  }
}

export interface WorkspaceScriptTrustSnapshot {
  readonly trusted: boolean;
}

export interface WorkspaceScriptTrustService {
  readonly grant: (projectId: string) => WorkspaceScriptTrustSnapshot;
  readonly revoke: (projectId: string) => WorkspaceScriptTrustSnapshot;
  readonly status: (projectId: string) => WorkspaceTrustStatus;
  readonly isTrusted: (projectId: string, workspace: WorkspaceInfo) => boolean;
  readonly trustLevelForRoot: (root: string) => WorkspaceTrustLevel;
  readonly recomputeForRoots?: (roots: readonly string[]) => readonly WorkspaceTrustLevel[];
}

export interface WorkspaceScriptTrustServiceOptions {
  readonly store: UiStore;
  readonly fs?: WorkspaceFs | undefined;
  readonly onRestricted?: ((canonicalRoot: string) => void) | undefined;
}

function realPathOrThrow(fs: WorkspaceFs, path: string, message: string): string {
  try {
    return fs.realPath(path);
  } catch {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", message);
  }
}

function realPathOrUndefined(fs: WorkspaceFs, path: string): string | undefined {
  try {
    return fs.realPath(path);
  } catch {
    return undefined;
  }
}

function registeredProjectPathForRoot(
  store: UiStore,
  fs: WorkspaceFs,
  root: string,
): string | undefined {
  const canonicalRoot = realPathOrUndefined(fs, root);
  if (canonicalRoot === undefined) return undefined;
  return store
    .listProjects()
    .find((project): boolean => realPathOrUndefined(fs, project.path) === canonicalRoot)?.path;
}

function workspaceInfoForRoot(root: string): WorkspaceInfo {
  return {
    root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

/**
 * ADR-0147 D9 migrates a one-root manifest for the current active project only, and removing a root
 * drops that root's manifest row while its project stays registered. Both leave a registered
 * project with no workspace manifest, which D9 requires to read as unavailable/restricted. Raising
 * a coded error keeps that state governed: the routes map it to a typed response instead of letting
 * a bare Error reach the top-level catch as an opaque 500.
 */
function manifestForCanonicalRoot(store: UiStore, canonicalRoot: string): WorkspaceManifest {
  const rootRef = deriveWorkspaceRootRef(canonicalRoot);
  const row = store.findWorkspaceManifestRecordByRoot(rootRef);
  if (row === undefined) {
    throw new WorkspaceScriptTrustError(
      "WORKSPACE_STATE_UNAVAILABLE",
      "The workspace state for this project is unavailable.",
    );
  }
  let parsed: unknown;
  const unavailable = (): WorkspaceScriptTrustError =>
    new WorkspaceScriptTrustError(
      "WORKSPACE_STATE_UNAVAILABLE",
      "The workspace state for this project is unavailable.",
    );
  try {
    parsed = JSON.parse(row.recordJson);
  } catch {
    throw unavailable();
  }
  if (!validateWorkspaceManifest(parsed).ok) throw unavailable();
  const manifest = parsed as WorkspaceManifest;
  if (
    manifest.workspaceId !== row.workspaceId ||
    manifest.revision !== row.revision ||
    manifest.manifestDigest !== row.manifestDigest
  ) {
    throw unavailable();
  }
  return manifest;
}

function currentTrustBinding(
  store: UiStore,
  canonicalRoot: string,
  basis: WorkspaceFact<WorkspaceTrustBasisDigest>,
): WorkspaceTrustBinding {
  return deriveWorkspaceTrustBinding(
    canonicalRoot,
    basis,
    manifestForCanonicalRoot(store, canonicalRoot),
  );
}

// Preserves the pre-#2521 canonicalization and single-root assertion exactly: the project must be
// registered, both the project root and the resolved workspace root are realpath-canonicalized, and
// the workspace root must equal the project root. Richer multi-root resolution lands additively with
// #2524/#2525 consumers; this child keeps the single-root decider contract.
function resolveCanonicalRoot(
  store: UiStore,
  fs: WorkspaceFs,
  projectId: string,
  suppliedWorkspace?: WorkspaceInfo,
): string {
  const project = store.listProjects().find((entry) => entry.path === projectId);
  if (project === undefined) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project not found.");
  }
  const canonicalProjectRoot = realPathOrThrow(
    fs,
    project.path,
    "Project root path could not be resolved.",
  );
  const detected = suppliedWorkspace ?? detectWorkspaceAt(canonicalProjectRoot, fs);
  const canonicalWorkspaceRoot = realPathOrThrow(
    fs,
    detected.root,
    "Project workspace path could not be resolved.",
  );
  if (canonicalWorkspaceRoot !== canonicalProjectRoot) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project workspace does not match.");
  }
  return canonicalProjectRoot;
}

// The capability-specific trust basis (ADR-0147 D3): the exact package.json digest. This is the old
// manifest-digest computation, now a non-throwing tagged fact so `isTrusted` fails closed to
// restricted rather than throwing on an absent or unreadable manifest.
/**
 * ADR-0147 D9 keeps `absent` and `unavailable` distinct and forbids conflating them. A root with no
 * `package.json` has no package scripts at all, so its package-script trust basis is legitimately
 * absent and the root stays grantable — that is what lets a non-npm workspace leave Restricted Mode
 * and start its managed language server. A manifest that exists but cannot be read or parsed is
 * `unavailable` and still fails closed, because there the basis is unknown rather than empty.
 */
function resolveTrustBasisFact(
  fs: WorkspaceFs,
  canonicalRoot: string,
): WorkspaceFact<WorkspaceTrustBasisDigest> {
  const manifestPath = join(canonicalRoot, "package.json");
  let stat: ReturnType<WorkspaceFs["stat"]>;
  try {
    stat = fs.stat(manifestPath);
  } catch {
    // stat failing is only `absent` when the entry genuinely is not there; anything else that
    // cannot be stat-ed is an unknown basis and must fail closed.
    return fs.exists(manifestPath) ? { outcome: "unavailable" } : { outcome: "absent" };
  }
  try {
    if (!stat.isFile || stat.isSymbolicLink || stat.size > PACKAGE_MANIFEST_MAX_BYTES) {
      return { outcome: "unavailable" };
    }
    const text = fs.readFileUtf8(manifestPath);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { outcome: "unavailable" };
    }
    const digest = createHash("sha256")
      .update(text, "utf8")
      .digest("hex") as WorkspaceTrustBasisDigest;
    return { outcome: "known", value: digest };
  } catch {
    return { outcome: "unavailable" };
  }
}

// Reads and validates the persisted record into a tagged assessment. No row is `absent`; a
// present-but-unparseable or contract-invalid record is `unavailable` (fail closed). The store read
// is the hostile-input boundary — every corrupt or future-shaped record resolves to restricted.
function readAssessment(store: UiStore, rootRef: string): WorkspaceTrustAssessment {
  let row: WorkspaceTrustRecordRow | undefined;
  try {
    row = store.readWorkspaceTrustRecord(rootRef);
  } catch {
    return { outcome: "unavailable" };
  }
  if (row === undefined) return { outcome: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.recordJson);
  } catch {
    return { outcome: "unavailable" };
  }
  if (!validateWorkspaceTrustRecord(parsed).ok) return { outcome: "unavailable" };
  return { outcome: "known", value: parsed as WorkspaceTrustRecord };
}

function buildRecord(
  binding: WorkspaceTrustBinding,
  trust: WorkspaceTrustLevel,
  reason: WorkspaceTrustReason,
  revision: number,
): WorkspaceTrustRecord {
  return {
    kind: "workspace-trust",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    binding,
    trust,
    decidedBy: "server",
    reason,
    revision,
    policyVersion: TRUST_POLICY_VERSION,
  };
}

// grant/revoke are explicit human actions: a store-read fault must fail loud rather than silently
// reset the monotonic revision. The fail-closed `isTrusted` path never calls this.
function nextRevision(store: UiStore, rootRef: string): number {
  return (store.readWorkspaceTrustRecord(rootRef)?.revision ?? -1) + 1;
}

// Persists one canonical record. The revisioned records with their closed `reason` enum ARE the
// content-free trust evidence trail — opaque digests/refs, enums, and revisions, never paths or
// manifest bytes — mirroring the ADR-0132/V10 `coding_runtime_snapshots` content-free ledger rather
// than a separate event bus. Every write is bounded by a deterministic prune.
function persistRecord(
  store: UiStore,
  binding: WorkspaceTrustBinding,
  trust: WorkspaceTrustLevel,
  reason: WorkspaceTrustReason,
  revision: number,
): void {
  const record = buildRecord(binding, trust, reason, revision);
  const row: WorkspaceTrustRecordRowInput = {
    rootRef: binding.rootRef,
    revision,
    trust,
    recordJson: JSON.stringify(record),
  };
  store.writeWorkspaceTrustRecord(row);
  store.pruneWorkspaceTrustRecords(MAX_TRUST_RECORDS);
}

// Chooses the most specific content-free reason for demoting a previously trusted record.
function invalidationReason(
  stored: WorkspaceTrustBinding,
  expected: WorkspaceTrustBinding,
): WorkspaceTrustReason {
  if (stored.rootIdentityDigest !== expected.rootIdentityDigest) return "identity-changed";
  // ADR-0148: only the manifest reference participates in validity. The workspace-level revision
  // and digest are recorded as provenance and change on focus and reorder, so reporting them as a
  // reason would attribute an invalidation to a mutation that never caused one.
  if (stored.manifestRef !== expected.manifestRef) return "manifest-changed";
  return "trust-basis-changed";
}

// A previously trusted record is durably demoted only when it is contradicted by KNOWN live facts —
// a genuine digest or root change. A transient or unreadable manifest keeps the current call
// fail-closed (untrusted) but must never permanently revoke a valid grant (ADR-0147 D3 speaks of a
// "digest/root mismatch", not an unreadable basis). Returns the trusted record to invalidate, if any.
function invalidatedTrustedRecord(
  assessment: WorkspaceTrustAssessment,
  expected: WorkspaceTrustBinding,
  projectedTrusted: boolean,
): WorkspaceTrustRecord | undefined {
  if (projectedTrusted || expected.trustBasisDigest.outcome !== "known") return undefined;
  if (assessment.outcome !== "known" || assessment.value.trust !== "trusted") return undefined;
  return assessment.value;
}

class WorkspaceScriptTrustServiceImpl implements WorkspaceScriptTrustService {
  private readonly store: UiStore;
  private readonly fs: WorkspaceFs;
  private readonly onRestricted: ((canonicalRoot: string) => void) | undefined;

  public constructor(options: WorkspaceScriptTrustServiceOptions) {
    this.store = options.store;
    this.fs = options.fs ?? nodeWorkspaceFs;
    this.onRestricted = options.onRestricted;
  }

  public readonly grant = (projectId: string): WorkspaceScriptTrustSnapshot => {
    const canonicalRoot = resolveCanonicalRoot(this.store, this.fs, projectId);
    const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
    // `absent` is a complete, knowable basis: the root has no package scripts, so there is nothing
    // for the package-script consumer to execute and nothing about it left uncertain. `unavailable`
    // means the basis could not be determined, which stays fail-closed (ADR-0147 D9).
    if (basis.outcome !== "known" && basis.outcome !== "absent") {
      throw new WorkspaceScriptTrustError(
        "PACKAGE_MANIFEST_UNAVAILABLE",
        "The project package manifest is unavailable for script trust.",
      );
    }
    const binding = currentTrustBinding(this.store, canonicalRoot, basis);
    persistRecord(
      this.store,
      binding,
      "trusted",
      "human-grant",
      nextRevision(this.store, binding.rootRef),
    );
    return { trusted: true };
  };

  public readonly revoke = (projectId: string): WorkspaceScriptTrustSnapshot => {
    const canonicalRoot = resolveCanonicalRoot(this.store, this.fs, projectId);
    const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
    const binding = currentTrustBinding(this.store, canonicalRoot, basis);
    persistRecord(
      this.store,
      binding,
      "restricted",
      "human-revocation",
      nextRevision(this.store, binding.rootRef),
    );
    this.onRestricted?.(canonicalRoot);
    return { trusted: false };
  };

  public readonly status = (projectId: string): WorkspaceTrustStatus => {
    const canonicalRoot = resolveCanonicalRoot(this.store, this.fs, projectId);
    const workspace = workspaceInfoForRoot(canonicalRoot);
    const trusted = this.isTrusted(projectId, workspace);
    let binding: WorkspaceTrustBinding;
    try {
      binding = currentTrustBinding(
        this.store,
        canonicalRoot,
        resolveTrustBasisFact(this.fs, canonicalRoot),
      );
    } catch {
      // Status is a read of governed state, so unreadable workspace state projects as
      // restricted/state-unavailable (ADR-0147 D9) rather than failing the request. Grant and
      // revoke keep raising the coded error, because a mutation must not silently do nothing.
      return unavailableStatus(projectId);
    }
    const assessment = readAssessment(this.store, binding.rootRef);
    if (assessment.outcome === "known" && assessment.value.trust === "restricted") {
      return statusProjection(projectId, assessment.value);
    }
    if (trusted && assessment.outcome === "known") {
      return statusProjection(projectId, assessment.value);
    }
    return unavailableStatus(projectId);
  };

  public readonly isTrusted = (projectId: string, workspace: WorkspaceInfo): boolean => {
    try {
      const canonicalRoot = resolveCanonicalRoot(this.store, this.fs, projectId, workspace);
      const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
      const expected = currentTrustBinding(this.store, canonicalRoot, basis);
      const assessment = readAssessment(this.store, expected.rootRef);
      const projectedTrusted = projectCommandTaskTrustState(assessment, expected) === "trusted";
      const invalidated = invalidatedTrustedRecord(assessment, expected, projectedTrusted);
      if (invalidated !== undefined) {
        persistRecord(
          this.store,
          expected,
          "restricted",
          invalidationReason(invalidated.binding, expected),
          invalidated.revision + 1,
        );
        this.onRestricted?.(canonicalRoot);
      }
      return projectedTrusted;
    } catch {
      return false;
    }
  };

  public readonly trustLevelForRoot = (root: string): WorkspaceTrustLevel => {
    try {
      const projectPath = registeredProjectPathForRoot(this.store, this.fs, root);
      if (projectPath === undefined) return "restricted";
      const canonicalRoot = realPathOrUndefined(this.fs, root);
      if (canonicalRoot === undefined) return "restricted";
      return this.isTrusted(projectPath, workspaceInfoForRoot(canonicalRoot))
        ? "trusted"
        : "restricted";
    } catch {
      return "restricted";
    }
  };

  public readonly recomputeForRoots = (roots: readonly string[]): readonly WorkspaceTrustLevel[] =>
    roots.map((root): WorkspaceTrustLevel => {
      const level = this.trustLevelForRoot(root);
      if (level === "restricted") this.onRestricted?.(root);
      return level;
    });
}

function statusProjection(projectId: string, record: WorkspaceTrustRecord): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust: record.trust,
    decidedBy: "server",
    reason: record.reason,
    revision: record.revision,
  };
}

function unavailableStatus(projectId: string): WorkspaceTrustStatus {
  return {
    kind: "workspace-trust-status",
    schemaVersion: WORKSPACE_TRUST_SCHEMA_VERSION,
    projectId,
    trust: "restricted",
    decidedBy: "server",
    reason: "state-unavailable",
    revision: null,
  };
}

export function createWorkspaceScriptTrustService(
  options: WorkspaceScriptTrustServiceOptions,
): WorkspaceScriptTrustService {
  return new WorkspaceScriptTrustServiceImpl(options);
}
