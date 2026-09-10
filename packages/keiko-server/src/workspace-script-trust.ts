// Server-owned approval for repository-authored package scripts, now persisted (issue #2521,
// ADR-0147 D3/D8). A grant is bound to the registered project's canonical root, the resolved
// workspace root, and the exact package.json digest observed when the human approved it, and is
// stored as a canonical, revisioned WorkspaceTrustRecord in the uiDb (one transaction domain). Any
// manifest or root change invalidates the grant — persisting a restricted record at a newer revision
// so a restored older manifest never resurrects it — before either the command runner or editor
// verification can execute a script. Trust survives server restarts; an absent store trusts nothing.
//
// Existing consumers keep their fail-closed binary decider seams. A separate derivation operation
// records server-provenance trust for a managed root only when an explicitly trusted source root has
// the same package-script basis. The canonical binding derivation lives in
// ./workspaceTrust/canonicalTrustIdentity.ts; the row persistence lives in the UiStore.

import { createHash } from "node:crypto";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodedHttpError, httpStatusFor } from "@oscharko-dev/keiko-contracts/runtime/http-error";
import {
  projectCommandTaskTrustState,
  validateWorkspaceTrustRecord,
  WORKSPACE_TRUST_SCHEMA_VERSION,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-trust";
import { validateWorkspaceManifest } from "@oscharko-dev/keiko-contracts/runtime/workspace-manifest";
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
  WorkspaceManifestRecordRow,
  WorkspaceTrustRecordRow,
  WorkspaceTrustRecordRowInput,
} from "./store/index.js";
import { isManagedTargetContained } from "./task-workspace/managed-root.js";
import type { ServerLogSink } from "./observability/server-log.js";
import { processServerLogSink } from "./process-log-sink.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";
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
  FILESYSTEM_IDENTITY_UNSUPPORTED: "FILESYSTEM_IDENTITY_UNSUPPORTED",
  WORKSPACE_STATE_UNAVAILABLE: "WORKSPACE_STATE_UNAVAILABLE",
} as const;

export type WorkspaceScriptTrustErrorCode =
  (typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES)[keyof typeof WORKSPACE_SCRIPT_TRUST_ERROR_CODES];

const STATUS_MAP: Readonly<Record<WorkspaceScriptTrustErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  PACKAGE_MANIFEST_UNAVAILABLE: 422,
  FILESYSTEM_IDENTITY_UNSUPPORTED: 422,
  // The project is registered but its workspace state cannot be read (ADR-0147 D9 fail-closed).
  WORKSPACE_STATE_UNAVAILABLE: 503,
};

export class WorkspaceScriptTrustError extends CodedHttpError {
  public readonly code: WorkspaceScriptTrustErrorCode;

  public constructor(code: WorkspaceScriptTrustErrorCode, message: string, cause?: unknown) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false });
    }
  }
}

export interface WorkspaceScriptTrustSnapshot {
  readonly trusted: boolean;
}

/** Why `admitRunManifest` recorded nothing — the closed vocabulary of its evidence line. */
export type WorkspaceRunManifestAdmissionRefusal =
  "authority-expired" | "root-unresolvable" | "root-unregistered" | "manifest-unreadable";

/** What `admitRunManifest` recorded: the basis outcome and, for a real manifest, its digest. */
export interface WorkspaceRunManifestAdmission {
  readonly basis: "known" | "absent";
  readonly manifestDigest?: WorkspaceTrustBasisDigest | undefined;
}

export interface WorkspaceScriptTrustService {
  readonly grant: (projectId: string, correlationId?: string) => WorkspaceScriptTrustSnapshot;
  readonly deriveFromTrustedRoot: (
    projectId: string,
    trustedProjectId: string,
  ) => WorkspaceScriptTrustSnapshot;
  readonly revoke: (projectId: string, correlationId?: string) => WorkspaceScriptTrustSnapshot;
  readonly status: (projectId: string) => WorkspaceTrustStatus;
  readonly isTrusted: (projectId: string, workspace: WorkspaceInfo) => boolean;
  readonly trustLevelForRoot: (root: string) => WorkspaceTrustLevel;
  // ADR-0147 D3 — true only while the root's durable record is the operator's OWN grant for the
  // root's current manifest bytes. A record derived from a trusted repository never answers true:
  // it inherits that repository's grant and has to stop with it. This is the one alternative basis
  // `decideScriptTrust` (editor/verificationRunner.ts) accepts for a managed worktree whose
  // `package.json` a governed run rewrote away from the repository's trust basis.
  readonly holdsHumanGrantForRoot: (root: string) => boolean;
  /**
   * ADR-0147 D3, autonomous-delivery amendment (owner decision, 2026-09-10): records the registered
   * worktree's CURRENT package-script basis as one a governed effect of the live run left behind, so
   * that the repository's standing grant covers it for that run. Returns what was recorded, or
   * `undefined` when the root is not a registered project or its manifest basis cannot be read —
   * nothing is admitted then. The admission is held in memory only: it lives and dies with the run
   * (`revokeRunAdmissions`) and expires with the run's authority.
   */
  readonly admitRunManifest: (
    root: string,
    runId: string,
    expiresAt: string,
  ) => WorkspaceRunManifestAdmission | undefined;
  /**
   * True while the root's current package-script basis is exactly the one its live run's last
   * governed effect left behind (`admitRunManifest`). A manifest changed by anything else since —
   * another process, the operator's editor — no longer matches and the caller falls back to the
   * refusal it always gave.
   */
  readonly holdsRunAdmissionForRoot: (root: string) => boolean;
  /** Drops every admission the run holds and returns how many there were. */
  readonly revokeRunAdmissions: (runId: string) => number;
  readonly recomputeForRoots?: (roots: readonly string[]) => readonly WorkspaceTrustLevel[];
  // #2628 — additive listener registration so composition-time consumers (buildPeripherals
  // wires managed-LSP restriction propagation this way) receive every persisted restriction
  // regardless of whether the service was constructed here or supplied through injection.
  // Returns a disposer that removes just this listener.
  readonly subscribeOnRestricted?: (listener: (canonicalRoot: string) => void) => () => void;
}

export interface WorkspaceScriptTrustServiceOptions {
  readonly store: UiStore;
  readonly fs?: WorkspaceFs | undefined;
  readonly onRestricted?: ((canonicalRoot: string) => void) | undefined;
  /**
   * The Keiko-owned managed task-worktree root (`<stateDir>/ui/task-workspaces`). A registered
   * project below it is a managed task worktree: `git worktree add` made its root the checkout root
   * by construction, so its workspace root is resolved by managed containment and never through the
   * user-workspace root rules — which deny every path below the state directory's `.keiko` segment
   * and therefore refused every managed worktree on a default installation (grant, revoke, status
   * and the repository-derived trust a provision records all failed closed, and binding a trusted
   * repository ended in PROVISIONING_FAILED). Absent, no root is admitted by containment: an
   * unconfigured service keeps refusing a denied root whatever its shape.
   */
  readonly managedRoot?: string | undefined;
  /** Body-free activity-log sink for the run-manifest admission lines; defaults to the process log. */
  readonly activityLog?: ServerLogSink | undefined;
  /** Clock for admission expiry; production uses `Date.now`. */
  readonly now?: (() => number) | undefined;
}

interface RunManifestAdmission {
  readonly runId: string;
  readonly basis: WorkspaceFact<WorkspaceTrustBasisDigest>;
  readonly expiresAtMs: number;
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
    selectedRoot: root,
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
interface ManifestState {
  readonly manifest: WorkspaceManifest;
  readonly row: WorkspaceManifestRecordRow;
}

function manifestForCanonicalRoot(store: UiStore, canonicalRoot: string): ManifestState {
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
  return { manifest, row };
}

/**
 * ADR-0147 D1 binds trust to "root reference and current filesystem identity digest". Reading the
 * digest from the persisted manifest satisfies neither half on the decision path: the manifest is
 * a snapshot, so replacing the directory under the same path leaves the stored digest — and the
 * derived binding — unchanged, and a granted record silently keeps projecting `trusted` against a
 * different filesystem object. Re-inspecting the live root here rebuilds the "current" half from
 * source before every decision; if the digest no longer matches the persisted record,
 * `invalidatedTrustedRecord` demotes the row deterministically. #2615.
 */
interface CurrentTrustContext {
  readonly binding: WorkspaceTrustBinding;
  readonly objectIdentityMatches: boolean;
  readonly objectIdentityUnsupported: boolean;
}

function currentTrustContext(
  store: UiStore,
  canonicalRoot: string,
  basis: WorkspaceFact<WorkspaceTrustBasisDigest>,
): CurrentTrustContext {
  const state = manifestForCanonicalRoot(store, canonicalRoot);
  let liveIdentity: ReturnType<typeof inspectWorkspaceRootIdentity>;
  try {
    liveIdentity = inspectWorkspaceRootIdentity(canonicalRoot);
  } catch (cause) {
    // The path was resolvable at resolveCanonicalRoot() but the live identity cannot be read now
    // (removed, replaced with a non-directory, or an alias appeared). This is state-unavailable
    // (ADR-0147 D9): the coded error maps to a typed 503 in mutation flows and, via the outer
    // try in isTrusted, to fail-closed restricted in the decision flow. The originating fs
    // error is preserved as `cause` for redacted operator diagnostics; it is never surfaced to
    // the client because CodedHttpError carries only the generic message.
    throw new WorkspaceScriptTrustError(
      "WORKSPACE_STATE_UNAVAILABLE",
      "The workspace state for this project is unavailable.",
      cause,
    );
  }
  const storedObjectIdentity = state.row.rootProjects.find(
    (candidate) => candidate.rootRef === liveIdentity.rootRef,
  )?.objectIdentityDigest;
  return {
    binding: deriveWorkspaceTrustBinding(
      canonicalRoot,
      basis,
      state.manifest,
      liveIdentity.identityDigest,
    ),
    objectIdentityMatches:
      liveIdentity.objectIdentityDigest !== undefined &&
      liveIdentity.objectIdentityDigest === storedObjectIdentity,
    objectIdentityUnsupported: liveIdentity.objectIdentityUnsupported,
  };
}

function requireCurrentObjectIdentity(context: CurrentTrustContext): WorkspaceTrustBinding {
  if (context.objectIdentityMatches) return context.binding;
  if (context.objectIdentityUnsupported) {
    throw new WorkspaceScriptTrustError(
      "FILESYSTEM_IDENTITY_UNSUPPORTED",
      "The workspace filesystem cannot provide a durable root identity.",
    );
  }
  throw new WorkspaceScriptTrustError(
    "WORKSPACE_STATE_UNAVAILABLE",
    "The workspace state for this project is unavailable.",
  );
}

// The workspace a registered project root resolves to. A managed task worktree (a registered project
// below the configured managed root) IS its own workspace root: `git worktree add` made that
// directory the checkout root, and the managed-root prover (workspace-root-access.ts) re-proves its
// identity before any consumer acts on it — so it is not re-admitted through `detectWorkspaceAt`'s
// user-workspace root rules, which refuse the state directory's `.keiko` segment. Every other root
// keeps the marker detection and admission it had. (The editor-agent boundary and the verification
// runner reach the same worktree through that prover's owned-root port; PR #3452's review found
// one editor-agent read that still detected through the plain port, repaired in the same change.)
function projectWorkspaceAt(
  canonicalProjectRoot: string,
  fs: WorkspaceFs,
  managedRoot: string | undefined,
): WorkspaceInfo {
  // Strictly below the managed root: the root itself is the parent of every worktree and never a
  // checkout of its own, so it keeps the user-workspace admission (and is refused like any other
  // `.keiko` path) even when someone registers it as a project.
  if (
    managedRoot !== undefined &&
    resolve(canonicalProjectRoot) !== resolve(managedRoot) &&
    isManagedTargetContained(managedRoot, canonicalProjectRoot)
  ) {
    return workspaceInfoForRoot(canonicalProjectRoot);
  }
  return detectWorkspaceAt(canonicalProjectRoot, fs);
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
  managedRoot?: string,
): string {
  // A registered project path is normalized but never realpath'd, while a manifest's canonicalRoot
  // is `realpath.native`. Matching on the string alone therefore answered PROJECT_NOT_FOUND for the
  // same directory named canonically — every root registered through a symlinked path (anything
  // under /tmp on macOS, a symlinked home or code directory) or with different casing. The reverse
  // lookup that resolves the alias already exists and is what trustLevelForRoot uses; this resolves
  // the id through it so one identity rule serves every entry point into this service.
  const registeredPath =
    store.listProjects().find((entry) => entry.path === projectId)?.path ??
    registeredProjectPathForRoot(store, fs, projectId);
  const project =
    registeredPath === undefined
      ? undefined
      : store.listProjects().find((entry) => entry.path === registeredPath);
  if (project === undefined) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project not found.");
  }
  const canonicalProjectRoot = realPathOrThrow(
    fs,
    project.path,
    "Project root path could not be resolved.",
  );
  const detected = suppliedWorkspace ?? projectWorkspaceAt(canonicalProjectRoot, fs, managedRoot);
  const canonicalWorkspaceRoot = realPathOrThrow(
    fs,
    detected.root,
    "Project workspace path could not be resolved.",
  );
  if (canonicalWorkspaceRoot !== canonicalProjectRoot) {
    throw new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "Project workspace does not match.");
  }
  // Snap the caller-cased canonical root to the on-disk canonical spelling (#2615). The stored
  // manifest was written with realpathSync.native, so downstream rootRef derivation and manifest
  // lookup must match that same on-disk casing on case-insensitive filesystems; without this
  // snap, a caller passing `/Users/alice/proj` while the manifest holds `/Users/Alice/proj`
  // fails closed as state-unavailable for an otherwise valid workspace.
  try {
    return realpathSync.native(canonicalProjectRoot);
  } catch (cause) {
    throw new WorkspaceScriptTrustError(
      "PROJECT_NOT_FOUND",
      "Project root path could not be resolved.",
      cause,
    );
  }
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
export function resolveTrustBasisFact(
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

/**
 * ADR-0147 D3: two roots share one package-script grant only while their bases are the SAME fact.
 * Exported so a consumer that runs scripts from a root other than the granted one (the verification
 * runner, for a managed task worktree) asks this module's rule instead of restating the digest
 * formula — a second copy could not stay in step with the size cap, the symlink refusal or the
 * absent/unavailable distinction above.
 */
export function trustBasisFactsMatch(
  left: WorkspaceFact<WorkspaceTrustBasisDigest>,
  right: WorkspaceFact<WorkspaceTrustBasisDigest>,
): boolean {
  if (left.outcome === "known" && right.outcome === "known") {
    return left.value === right.value;
  }
  return left.outcome === "absent" && right.outcome === "absent";
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

// Trust mutations must fail loud on a store-read fault rather than silently reset the monotonic
// revision. The fail-closed `isTrusted` path never calls this.
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
  // ADR-0155: only the manifest reference participates in validity. The workspace-level revision
  // and digest are recorded as provenance and change on focus and reorder, so reporting them as a
  // reason would attribute an invalidation to a mutation that never caused one.
  if (stored.manifestRef !== expected.manifestRef) return "manifest-changed";
  return "trust-basis-changed";
}

// A previously trusted record is durably demoted only when it is contradicted by live facts that
// are themselves determinate. A transient or unreadable manifest keeps the current call fail-closed
// (untrusted) but must never permanently revoke a valid grant (ADR-0147 D3 speaks of a "digest/root
// mismatch", not an unreadable basis). Returns the trusted record to invalidate, if any.
//
// Root identity and manifest reference are determinate on their own: neither depends on being able
// to read the trust basis, so a mismatch in either is a genuine contradiction and must demote even
// when the basis is `absent`. Gating the whole function on the basis being `known` meant a root with
// no package.json — permanently `absent`, i.e. exactly the non-npm roots #2613 exists to enable —
// could have its directory swapped underneath a grant without the stored record ever being demoted,
// without an `identity-changed` revision being written, and without notifyRestricted reaching the
// managed LSP pool, leaving a language server running against a directory the grant never covered.
//
// The basis-only path accepts both determinate outcomes: `known` and `absent`. Moving between them
// is a real basis change and must durably demote the grant, otherwise restoring deleted manifest
// bytes would resurrect old authority. Only `unavailable` is transient/unknown and therefore
// remains fail-closed without permanent invalidation.
function invalidatedTrustedRecord(
  assessment: WorkspaceTrustAssessment,
  expected: WorkspaceTrustBinding,
  projectedTrusted: boolean,
): WorkspaceTrustRecord | undefined {
  if (projectedTrusted) return undefined;
  if (assessment.outcome !== "known" || assessment.value.trust !== "trusted") return undefined;
  const stored = assessment.value.binding;
  const determinateMismatch =
    stored.rootIdentityDigest !== expected.rootIdentityDigest ||
    stored.manifestRef !== expected.manifestRef;
  if (determinateMismatch) return assessment.value;
  return expected.trustBasisDigest.outcome === "known" ||
    expected.trustBasisDigest.outcome === "absent"
    ? assessment.value
    : undefined;
}

class WorkspaceScriptTrustServiceImpl implements WorkspaceScriptTrustService {
  private readonly store: UiStore;
  private readonly fs: WorkspaceFs;
  private readonly managedRoot: string | undefined;
  // #2628 — restriction listeners are held as a set so both the options.onRestricted seat
  // (kept for callers that construct the service directly) and subscribeOnRestricted callers
  // deliver the same notification without either path silently dropping the other.
  private readonly restrictionListeners = new Set<(canonicalRoot: string) => void>();
  // Run-scoped, in-memory: the package-script basis a live autonomous run's last governed effect
  // left behind, keyed by the worktree's canonical root. Never persisted — a restart ends the run.
  private readonly runAdmissions = new Map<string, RunManifestAdmission>();
  private readonly activityLog: ServerLogSink;
  private readonly now: () => number;

  public constructor(options: WorkspaceScriptTrustServiceOptions) {
    this.store = options.store;
    this.fs = options.fs ?? nodeWorkspaceFs;
    this.managedRoot = options.managedRoot;
    this.activityLog = options.activityLog ?? processServerLogSink();
    this.now = options.now ?? Date.now;
    if (options.onRestricted !== undefined) {
      this.restrictionListeners.add(options.onRestricted);
    }
  }

  private notifyRestricted(canonicalRoot: string): void {
    for (const listener of this.restrictionListeners) listener(canonicalRoot);
  }

  // The one canonical-root resolution every decision path uses, so the managed-root admission
  // above cannot be applied on one path and forgotten on another.
  private canonicalRootOf(projectId: string, workspace?: WorkspaceInfo): string {
    return resolveCanonicalRoot(this.store, this.fs, projectId, workspace, this.managedRoot);
  }

  private isTrustedForBasis(
    canonicalRoot: string,
    basis: WorkspaceFact<WorkspaceTrustBasisDigest>,
  ): boolean {
    const context = currentTrustContext(this.store, canonicalRoot, basis);
    const expected = context.binding;
    const assessment = readAssessment(this.store, expected.rootRef);
    if (!context.objectIdentityMatches) {
      if (assessment.outcome === "known" && assessment.value.trust === "trusted") {
        persistRecord(
          this.store,
          expected,
          "restricted",
          "identity-changed",
          assessment.value.revision + 1,
        );
        this.notifyRestricted(canonicalRoot);
      }
      return false;
    }
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
      this.notifyRestricted(canonicalRoot);
    }
    return projectedTrusted;
  }

  // F64 (PR #3452): a human grant or revoke is the decision every later verification of the root
  // rests on, and it used to leave no line at all, so a customer log could not show why a run's
  // verification was, or was not, admitted. Body-free: the basis outcome, the manifest's digest and
  // the record revision, never a path or project id.
  private recordHumanDecision(
    decision: "granted" | "revoked",
    basis: WorkspaceFact<WorkspaceTrustBasisDigest>,
    revision: number,
    correlationId: string | undefined,
  ): void {
    this.activityLog.write({
      category: "security",
      op:
        decision === "granted"
          ? "workspace-script-trust.granted"
          : "workspace-script-trust.revoked",
      correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
      extra: {
        basis: basis.outcome,
        ...(basis.outcome === "known" ? { manifestDigest: basis.value } : {}),
        revision,
      },
    });
  }

  public readonly grant = (
    projectId: string,
    correlationId?: string,
  ): WorkspaceScriptTrustSnapshot => {
    const canonicalRoot = this.canonicalRootOf(projectId);
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
    const binding = requireCurrentObjectIdentity(
      currentTrustContext(this.store, canonicalRoot, basis),
    );
    const revision = nextRevision(this.store, binding.rootRef);
    persistRecord(this.store, binding, "trusted", "human-grant", revision);
    this.recordHumanDecision("granted", basis, revision, correlationId);
    return { trusted: true };
  };

  public readonly deriveFromTrustedRoot = (
    projectId: string,
    trustedProjectId: string,
  ): WorkspaceScriptTrustSnapshot => {
    const trustedRoot = this.canonicalRootOf(trustedProjectId);
    const trustedBasis = resolveTrustBasisFact(this.fs, trustedRoot);
    if (!this.isTrustedForBasis(trustedRoot, trustedBasis)) return { trusted: false };
    const canonicalRoot = this.canonicalRootOf(projectId);
    const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
    if (!trustBasisFactsMatch(trustedBasis, basis)) return { trusted: false };
    const binding = requireCurrentObjectIdentity(
      currentTrustContext(this.store, canonicalRoot, basis),
    );
    const revalidatedTrustedBasis = resolveTrustBasisFact(this.fs, trustedRoot);
    if (!trustBasisFactsMatch(trustedBasis, revalidatedTrustedBasis)) {
      return { trusted: false };
    }
    persistRecord(
      this.store,
      binding,
      "trusted",
      "derived-from-trusted-root",
      nextRevision(this.store, binding.rootRef),
    );
    return { trusted: true };
  };

  public readonly revoke = (
    projectId: string,
    correlationId?: string,
  ): WorkspaceScriptTrustSnapshot => {
    const canonicalRoot = this.canonicalRootOf(projectId);
    const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
    const binding = requireCurrentObjectIdentity(
      currentTrustContext(this.store, canonicalRoot, basis),
    );
    const revision = nextRevision(this.store, binding.rootRef);
    persistRecord(this.store, binding, "restricted", "human-revocation", revision);
    this.recordHumanDecision("revoked", basis, revision, correlationId);
    this.notifyRestricted(canonicalRoot);
    return { trusted: false };
  };

  public readonly status = (projectId: string): WorkspaceTrustStatus => {
    const canonicalRoot = this.canonicalRootOf(projectId);
    const workspace = workspaceInfoForRoot(canonicalRoot);
    const trusted = this.isTrusted(projectId, workspace);
    let binding: WorkspaceTrustBinding;
    try {
      binding = currentTrustContext(
        this.store,
        canonicalRoot,
        resolveTrustBasisFact(this.fs, canonicalRoot),
      ).binding;
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
      const canonicalRoot = this.canonicalRootOf(projectId, workspace);
      const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
      return this.isTrustedForBasis(canonicalRoot, basis);
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

  public readonly holdsHumanGrantForRoot = (root: string): boolean => {
    try {
      const projectPath = registeredProjectPathForRoot(this.store, this.fs, root);
      const canonicalRoot = realPathOrUndefined(this.fs, root);
      if (projectPath === undefined || canonicalRoot === undefined) return false;
      const workspace = workspaceInfoForRoot(canonicalRoot);
      // The full fail-closed decision first — every binding dimension and the current basis digest
      // — so a stale human grant invalidates exactly as it does on every other decision path.
      if (!this.isTrusted(projectPath, workspace)) return false;
      const decisionRoot = this.canonicalRootOf(projectPath, workspace);
      const context = currentTrustContext(
        this.store,
        decisionRoot,
        resolveTrustBasisFact(this.fs, decisionRoot),
      );
      const assessment = readAssessment(this.store, context.binding.rootRef);
      return assessment.outcome === "known" && assessment.value.reason === "human-grant";
    } catch {
      return false;
    }
  };

  // The same registered-root resolution `holdsHumanGrantForRoot` uses, so an admission recorded for
  // a root and the later lookup for the same root can never disagree about its key.
  private registeredCanonicalRoot(root: string): string | undefined {
    const projectPath = registeredProjectPathForRoot(this.store, this.fs, root);
    const canonicalRoot = realPathOrUndefined(this.fs, root);
    if (projectPath === undefined || canonicalRoot === undefined) return undefined;
    return this.canonicalRootOf(projectPath, workspaceInfoForRoot(canonicalRoot));
  }

  public readonly admitRunManifest = (
    root: string,
    runId: string,
    expiresAt: string,
  ): WorkspaceRunManifestAdmission | undefined => {
    const candidate = this.runAdmissionCandidate(root, expiresAt);
    if ("refusal" in candidate) {
      // A refused admission is why the NEXT verification of this worktree may pause for a human
      // decision although the run is autonomous — it must be reconstructible from the log.
      this.activityLog.write({
        category: "security",
        op: "workspace-script-trust.run-manifest-not-admitted",
        correlationId: runId,
        extra: { reason: candidate.refusal },
      });
      return undefined;
    }
    const { canonicalRoot, basis, expiresAtMs } = candidate;
    this.runAdmissions.set(canonicalRoot, { runId, basis, expiresAtMs });
    const admission: WorkspaceRunManifestAdmission =
      basis.outcome === "known"
        ? { basis: "known", manifestDigest: basis.value }
        : { basis: "absent" };
    this.activityLog.write({
      category: "security",
      op: "workspace-script-trust.run-manifest-admitted",
      correlationId: runId,
      extra: { ...admission, expiresAt },
    });
    return admission;
  };

  // The preconditions of an admission, each refusal in one closed vocabulary: the authority must
  // still be live, the root must be a registered project whose canonical root resolves, and the
  // manifest must be readable. `absent` is a real basis (no package scripts at all, ADR-0147 D9);
  // `unknown`/`unavailable` is an unreadable manifest and admits nothing.
  private runAdmissionCandidate(
    root: string,
    expiresAt: string,
  ):
    | {
        readonly canonicalRoot: string;
        readonly basis: WorkspaceFact<WorkspaceTrustBasisDigest>;
        readonly expiresAtMs: number;
      }
    | { readonly refusal: WorkspaceRunManifestAdmissionRefusal } {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      return { refusal: "authority-expired" };
    }
    let canonicalRoot: string | undefined;
    try {
      canonicalRoot = this.registeredCanonicalRoot(root);
    } catch {
      return { refusal: "root-unresolvable" };
    }
    if (canonicalRoot === undefined) return { refusal: "root-unregistered" };
    const basis = resolveTrustBasisFact(this.fs, canonicalRoot);
    if (basis.outcome !== "known" && basis.outcome !== "absent") {
      return { refusal: "manifest-unreadable" };
    }
    return { canonicalRoot, basis, expiresAtMs };
  }

  public readonly holdsRunAdmissionForRoot = (root: string): boolean => {
    try {
      const canonicalRoot = this.registeredCanonicalRoot(root);
      if (canonicalRoot === undefined) return false;
      const admission = this.runAdmissions.get(canonicalRoot);
      if (admission === undefined) return false;
      if (admission.expiresAtMs <= this.now()) {
        this.runAdmissions.delete(canonicalRoot);
        return false;
      }
      return trustBasisFactsMatch(admission.basis, resolveTrustBasisFact(this.fs, canonicalRoot));
    } catch {
      return false;
    }
  };

  public readonly revokeRunAdmissions = (runId: string): number => {
    let revoked = 0;
    for (const [canonicalRoot, admission] of this.runAdmissions) {
      if (admission.runId !== runId) continue;
      this.runAdmissions.delete(canonicalRoot);
      revoked += 1;
    }
    if (revoked > 0) {
      this.activityLog.write({
        category: "security",
        op: "workspace-script-trust.run-manifest-revoked",
        correlationId: runId,
        extra: { count: revoked },
      });
    }
    return revoked;
  };

  /**
   * The one identity every restriction notification is emitted under. #2628 contracted listeners
   * to receive the CANONICAL root because the managed-LSP process pool is keyed on it, but
   * `recomputeForRoots` derived it with `WorkspaceFs.realPath` while `revoke` and the `isTrusted`
   * invalidation path derive it with `resolveCanonicalRoot` — which ends in `realpathSync.native`
   * (#2615). Those two are not the same function: on a case-insensitive filesystem `.native`
   * returns the on-disk spelling while plain `realpath` preserves the caller's, so the same root
   * reached this seam under two spellings and only one of them could ever match the pool key. The
   * pool entry survived a revocation with a restricted root's language server still live.
   *
   * Resolving through `resolveCanonicalRoot` here means all three notification sites share one
   * derivation, so they cannot drift apart again (#2768).
   */
  private notificationRootFor(root: string): string | undefined {
    try {
      return this.canonicalRootOf(root);
    } catch {
      return undefined;
    }
  }

  // Skip the notification when the path cannot be canonicalized: without a canonical identity there
  // is no legitimate value to hand a downstream listener. The trust decision itself already fails
  // closed to "restricted", so nothing is left silently open — only the notification is dropped.
  public readonly recomputeForRoots = (roots: readonly string[]): readonly WorkspaceTrustLevel[] =>
    roots.map((root): WorkspaceTrustLevel => {
      const level = this.trustLevelForRoot(root);
      if (level === "restricted") {
        const canonicalRoot = this.notificationRootFor(root);
        if (canonicalRoot !== undefined) this.notifyRestricted(canonicalRoot);
      }
      return level;
    });

  public readonly subscribeOnRestricted = (
    listener: (canonicalRoot: string) => void,
  ): (() => void) => {
    this.restrictionListeners.add(listener);
    return (): void => {
      this.restrictionListeners.delete(listener);
    };
  };
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
