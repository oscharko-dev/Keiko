import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createCommandRunnerManager } from "./command-runner.js";
import { createVerificationRunnerManager } from "./editor/verificationRunner.js";
import { inspectWorkspaceRootIdentity } from "./workspace-root-identity.js";
import { deriveWorkspaceRootRef } from "./workspaceTrust/canonicalTrustIdentity.js";
import { createInMemoryUiStore, createNodeUiStore, type UiStore } from "./store/index.js";
import {
  createWorkspaceScriptTrustService,
  WorkspaceScriptTrustError,
  type WorkspaceScriptTrustService,
} from "./workspace-script-trust.js";

const MANIFEST = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
  devDependencies: { vitest: "1.0.0" },
});

// Mutable view over the persisted binding, used only to inject a stale record and prove the
// content-free invalidation reason the store records when a trusted record no longer matches.
interface MutatedBinding {
  rootIdentityDigest: string;
  manifestDigest: string;
  manifestRef: string;
  manifestRevision: number;
}

let root: string;
let store: UiStore;

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-script-trust-"));
  writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach((): void => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

// Runtime-validated readers over the persisted trust-record JSON. The store row is untrusted
// input at the test boundary; casting a JSON.parse result directly to a field-shaped type hides
// invalid states and violates the repo rule against type assertions that discard structure.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseTrustRecord(recordJson: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(recordJson ?? "{}");
  return isRecord(parsed) ? parsed : {};
}
function readReasonFrom(recordJson: string | undefined): string | undefined {
  const value = parseTrustRecord(recordJson).reason;
  return typeof value === "string" ? value : undefined;
}
function readTrustFrom(recordJson: string | undefined): string | undefined {
  const value = parseTrustRecord(recordJson).trust;
  return typeof value === "string" ? value : undefined;
}
// Field-level guard for the persisted trust-record binding shape. Used only by the tampering
// helper below to narrow before mutation — the SUT's own contract validators (invoked at every
// store read) remain the authority for the closed shape at trust-decision time.
function isMutatedBinding(value: unknown): value is MutatedBinding {
  return (
    isRecord(value) &&
    typeof value.rootIdentityDigest === "string" &&
    typeof value.manifestDigest === "string" &&
    typeof value.manifestRef === "string" &&
    typeof value.manifestRevision === "number"
  );
}
// Wrap the two-step realpath+inspect chain so the intermediate `string` type is explicit at the
// call site. Even though nodeWorkspaceFs.realPath is typed by @oscharko-dev/keiko-workspace,
// type-aware ESLint's no-unsafe-* rules can surface `error`-typed views of an isolated call —
// the local binding pins the type and keeps the callers unambiguous.
function identityDigestFor(fsPath: string): string {
  const canonical: string = nodeWorkspaceFs.realPath(fsPath);
  return inspectWorkspaceRootIdentity(canonical).identityDigest;
}

// A store whose project is registered under `projectPath` verbatim, for the cases that need the
// registered spelling to differ from the on-disk canonical one.
function storeWithProject(projectPath: string): UiStore {
  const scoped = createInMemoryUiStore();
  scoped.createProject(projectPath, "fixture");
  return scoped;
}

function successfulSpawn(): SpawnFn {
  return vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { pid: number }).pid = 321_000;
    child.kill = (): boolean => true;
    setImmediate(() => child.emit("close", 0, null));
    return child;
  });
}

describe("WorkspaceScriptTrustService", () => {
  it("projects trust by canonical root and synchronously signals every persisted restriction", () => {
    const onRestricted = vi.fn();
    const trust = createWorkspaceScriptTrustService({ store, onRestricted });

    expect(trust.trustLevelForRoot(root)).toBe("restricted");
    expect(trust.grant(root)).toEqual({ trusted: true });
    expect(trust.trustLevelForRoot(root)).toBe("trusted");
    expect(trust.revoke(root)).toEqual({ trusted: false });
    expect(onRestricted).toHaveBeenLastCalledWith(nodeWorkspaceFs.realPath(root));

    trust.grant(root);
    writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
    expect(trust.trustLevelForRoot(root)).toBe("restricted");
    expect(onRestricted).toHaveBeenCalledTimes(2);
  });

  it("projects trust through a registered symlink by canonical root identity", () => {
    const symlinkRoot = `${root}-link`;
    symlinkSync(root, symlinkRoot, "dir");
    try {
      // `root` is already registered (beforeEach); resolveCanonicalRoot/registeredProjectPathForRoot
      // resolve `symlinkRoot` to that same project by canonical identity, so no second registration
      // is needed here. Registering `symlinkRoot` as its own project would collide on the same
      // canonical root the store's UNIQUE constraints key workspace manifests by and is now rejected
      // with PROJECT_EXISTS (#2768) rather than silently committing a project with no manifest.
      const trust = createWorkspaceScriptTrustService({ store });

      expect(trust.grant(symlinkRoot)).toEqual({ trusted: true });
      expect(trust.trustLevelForRoot(nodeWorkspaceFs.realPath(symlinkRoot))).toBe("trusted");
    } finally {
      rmSync(symlinkRoot, { force: true });
    }
  });

  it("notifies recomputeForRoots listeners with the CANONICAL root even for symlinked inputs (#2628)", () => {
    // Guards the CodeRabbit finding on PR #2688: revoke and the isTrusted invalidation
    // path emit canonicalRoot to listeners, so recomputeForRoots must do the same or a
    // symlinked/aliased root would reach managed-LSP restriction with a non-real
    // identity and miss the pool entry keyed on the canonical path.
    const symlinkRoot = `${root}-link`;
    symlinkSync(root, symlinkRoot, "dir");
    try {
      const notified: string[] = [];
      const trust = createWorkspaceScriptTrustService({
        store,
        onRestricted: (canonicalRoot) => notified.push(canonicalRoot),
      });
      const canonical = nodeWorkspaceFs.realPath(symlinkRoot);
      expect(trust.recomputeForRoots?.([symlinkRoot])).toEqual(["restricted"]);
      expect(notified).toEqual([canonical]);
      expect(notified).not.toContain(symlinkRoot);
    } finally {
      rmSync(symlinkRoot, { force: true });
    }
  });

  it("suppresses recomputeForRoots notification when the root cannot be canonicalized (#2628)", () => {
    // Fail-closed: without a canonical identity there is no legitimate value to hand a
    // downstream listener (the LSP pool is keyed on the canonical path), so the
    // notification is dropped. The trust decision itself already projects "restricted".
    const notified: string[] = [];
    const trust = createWorkspaceScriptTrustService({
      store,
      onRestricted: (canonicalRoot) => notified.push(canonicalRoot),
    });
    const missing = join(root, "does-not-exist");
    expect(trust.recomputeForRoots?.([missing])).toEqual(["restricted"]);
    expect(notified).toEqual([]);
  });

  it("emits ONE canonical identity from recomputeForRoots and revoke, not two spellings (#2768)", () => {
    // On a case-insensitive filesystem `realpathSync` preserves the caller's casing while
    // `realpathSync.native` returns the on-disk spelling, so `recomputeForRoots` (WorkspaceFs
    // .realPath) and `revoke` (resolveCanonicalRoot, which ends in `.native`) reached the same
    // listener under two different strings — and the managed-LSP pool key is a raw string, so at
    // most one of them could ever match. A restricted root kept its language server alive.
    //
    // Linux has no case-insensitive tmpdir to reproduce that on, so the SAME divergence is staged
    // through the one seam that produces it: a WorkspaceFs whose `realPath` does not resolve what
    // `.native` resolves. The symlink is the divergence `.native` collapses and this stub does not
    // — exactly the shape the casing difference takes on macOS.
    const symlinkRoot = `${root}-native-divergence-link`;
    symlinkSync(root, symlinkRoot, "dir");
    try {
      const stubFs: WorkspaceFs = { ...nodeWorkspaceFs, realPath: (path): string => path };
      const notified: string[] = [];
      const trust = createWorkspaceScriptTrustService({
        store: storeWithProject(symlinkRoot),
        fs: stubFs,
        onRestricted: (canonicalRoot) => notified.push(canonicalRoot),
      });
      const onDiskCanonical = realpathSync.native(symlinkRoot);

      expect(trust.recomputeForRoots?.([symlinkRoot])).toEqual(["restricted"]);

      // The pre-fix code notified with the stub's `realPath` answer — the alias itself — which is
      // not the identity `revoke` and the `isTrusted` invalidation path emit.
      expect(notified).toEqual([onDiskCanonical]);
      expect(notified).not.toContain(symlinkRoot);
    } finally {
      rmSync(symlinkRoot, { force: true });
    }
  });

  it("fails closed, grants explicitly, and invalidates the grant after a manifest change", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const verification = createVerificationRunnerManager({
      store,
      evidenceStore: createInMemoryEvidenceStore(),
      isWorkspaceTrustedForPackageScripts: trust.isTrusted,
    });
    expect(
      verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState,
    ).toBe("approval-required");

    expect(trust.grant(root)).toEqual({ trusted: true });
    expect(
      verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState,
    ).toBe("trusted");

    writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
    expect(
      verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState,
    ).toBe("approval-required");
    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    expect(
      verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState,
    ).toBe("approval-required");
  });

  it("projects server-owned status and preserves an honest digest-invalidation reason", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    expect(trust.status(root)).toMatchObject({
      projectId: root,
      trust: "restricted",
      decidedBy: "server",
      reason: "state-unavailable",
      revision: null,
    });
    trust.grant(root);
    expect(trust.status(root)).toMatchObject({
      trust: "trusted",
      reason: "human-grant",
      revision: 0,
    });
    writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
    expect(trust.status(root)).toMatchObject({
      trust: "restricted",
      reason: "trust-basis-changed",
      revision: 1,
    });
  });

  it("drives command and verification catalogs from the same trust source", async () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const evidenceStore = createInMemoryEvidenceStore();
    const spawn = successfulSpawn();
    const command = createCommandRunnerManager({
      store,
      evidenceStore,
      isWorkspaceTrustedForPackageScripts: trust.isTrusted,
      processEnv: { PATH: "/usr/bin" },
      runDeps: {
        spawn,
        resolveExecutable: (value): string => value,
        sandboxAvailability: {
          bubblewrap: true,
          unshare: false,
          seatbelt: false,
          docker: false,
          podman: false,
        },
        platform: "linux",
      },
    });
    const verification = createVerificationRunnerManager({
      store,
      evidenceStore,
      isWorkspaceTrustedForPackageScripts: trust.isTrusted,
    });

    await expect(
      command.execute({ projectId: root, taskId: "npm-script:test" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(spawn).not.toHaveBeenCalled();
    trust.grant(root);
    expect(command.discover(root).tasks[0]?.trustState).toBe("trusted");
    expect(
      verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")?.trustState,
    ).toBe("trusted");
    await expect(
      command.execute({ projectId: root, taskId: "npm-script:test" }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("projects a registered project the D9 migration left pre-manifest as unavailable", () => {
    // ADR-0147 D9 migrates a one-root manifest for the CURRENT ACTIVE project only, so every other
    // registered project stays pre-manifest after the upgrade. D9 requires that state to fail
    // closed to unavailable/restricted. It used to escape manifestForCanonicalRoot as an uncoded
    // Error, which the server turns into an opaque 500 on the trust status, grant, revoke and
    // catalog routes.
    //
    // Relocated here from workspace-manifests.test.ts by #2620. That pin reached the same state by
    // removing a root from a multi-root workspace, which no longer orphans the project — removal
    // now restores a standalone single-root workspace. The invariant is unchanged and now sits at
    // the layer that owns it, anchored to the D9 producer that still exists.
    const dir = mkdtempSync(join(tmpdir(), "keiko-script-trust-premanifest-"));
    const dbPath = join(dir, "ui.db");
    const active = join(dir, "active");
    mkdirSync(active);
    writeFileSync(join(active, "package.json"), MANIFEST, "utf8");
    let clock = 1;
    const options = { now: (): number => (clock += 1) };
    try {
      const seed = createNodeUiStore(dbPath, options);
      seed.createProject(root, "fixture");
      // Registered last, so `ORDER BY last_opened_at DESC LIMIT 1` migrates this one and leaves
      // `root` pre-manifest. The ordering is pinned by the injected clock, never by wall time.
      seed.createProject(active, "active");
      seed.close();

      const legacy = new DatabaseSync(dbPath);
      legacy.exec(
        "DROP TABLE workspace_manifest_roots; DROP TABLE workspace_manifests; " +
          "DROP TABLE workspace_trust_records; " +
          "ALTER TABLE memory_autonomy_policy DROP COLUMN revision; PRAGMA user_version = 13;",
      );
      legacy.close();

      const migrated = createNodeUiStore(dbPath, options);
      try {
        expect(migrated.listProjects()).toHaveLength(2);
        expect(migrated.listWorkspaceManifestRecords()).toHaveLength(1);
        expect(migrated.findWorkspaceManifestRecordByProject(root)).toBeUndefined();

        const trust = createWorkspaceScriptTrustService({ store: migrated });
        expect(trust.status(root)).toMatchObject({
          projectId: root,
          trust: "restricted",
          decidedBy: "server",
          reason: "state-unavailable",
        });
        expect(trust.trustLevelForRoot(root)).toBe("restricted");
        for (const worker of [
          (): unknown => trust.grant(root),
          (): unknown => trust.revoke(root),
        ]) {
          expect(worker).toThrow(WorkspaceScriptTrustError);
        }
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grants a root that has no package manifest and re-restricts it once one appears", () => {
    // ADR-0147 D9 keeps `absent` and `unavailable` distinct. Conflating them made a root without an
    // npm manifest ungrantable, so a Go, Java, Python, Rust or shell workspace could never leave
    // Restricted Mode and its managed language server could never start (#2613).
    const bare = mkdtempSync(join(tmpdir(), "keiko-script-trust-bare-"));
    try {
      store.createProject(bare, "bare");
      const trust = createWorkspaceScriptTrustService({ store });

      expect(trust.trustLevelForRoot(bare)).toBe("restricted");
      expect(trust.grant(bare)).toEqual({ trusted: true });
      expect(trust.trustLevelForRoot(bare)).toBe("trusted");
      expect(trust.status(bare)).toMatchObject({ trust: "trusted", reason: "human-grant" });

      // A manifest appearing later changes the basis, so the grant must not survive it.
      writeFileSync(join(bare, "package.json"), MANIFEST, "utf8");
      expect(trust.trustLevelForRoot(bare)).toBe("restricted");
      expect(trust.status(bare)).toMatchObject({ reason: "trust-basis-changed" });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("still refuses to grant when a package manifest exists but cannot be read", () => {
    // Unreadable is not missing: this path must stay fail-closed exactly as before.
    const opaque = mkdtempSync(join(tmpdir(), "keiko-script-trust-opaque-"));
    try {
      mkdirSync(join(opaque, "package.json"));
      store.createProject(opaque, "opaque");
      const trust = createWorkspaceScriptTrustService({ store });

      expect(() => trust.grant(opaque)).toThrow(WorkspaceScriptTrustError);
      expect(trust.trustLevelForRoot(opaque)).toBe("restricted");
    } finally {
      rmSync(opaque, { recursive: true, force: true });
    }
  });

  it("rejects a grant for an unregistered project", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    expect(() => trust.grant(join(root, "unregistered"))).toThrow(WorkspaceScriptTrustError);
  });
});

describe("WorkspaceScriptTrust fail-closed matrix", () => {
  function typecheckTrustState(
    trust: WorkspaceScriptTrustService,
    trustStore: UiStore = store,
  ): string | undefined {
    const verification = createVerificationRunnerManager({
      store: trustStore,
      evidenceStore: createInMemoryEvidenceStore(),
      isWorkspaceTrustedForPackageScripts: trust.isTrusted,
    });
    return verification.discover(root).kinds.find((entry) => entry.kind === "typecheck")
      ?.trustState;
  }

  function rootReference(): string {
    return deriveWorkspaceRootRef(nodeWorkspaceFs.realPath(root));
  }

  it("stays untrusted on a fresh store — no implicit trust on first run", () => {
    expect(typecheckTrustState(createWorkspaceScriptTrustService({ store }))).toBe(
      "approval-required",
    );
  });

  it("stays untrusted when the persisted record is corrupt JSON", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    store.writeWorkspaceTrustRecord({
      rootRef: rootReference(),
      revision: 0,
      trust: "trusted",
      recordJson: "{ not valid json",
    });
    expect(typecheckTrustState(trust)).toBe("approval-required");
  });

  it("stays untrusted when the persisted record fails the contract validator", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    store.writeWorkspaceTrustRecord({
      rootRef: rootReference(),
      revision: 0,
      trust: "trusted",
      recordJson: JSON.stringify({ kind: "workspace-trust", schemaVersion: 2 }),
    });
    expect(typecheckTrustState(trust)).toBe("approval-required");
  });

  it("returns false for an unregistered project without leaking a throw", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
    expect(trust.isTrusted(join(root, "unregistered"), workspace)).toBe(false);
  });

  it("fails closed when the granted project root can no longer be resolved", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
    trust.grant(root);
    rmSync(root, { recursive: true, force: true });
    expect(trust.isTrusted(root, workspace)).toBe(false);
  });

  it("invalidates the grant when the root directory is replaced at the same path (#2615)", () => {
    // ADR-0147 D1 binds trust to "root reference and current filesystem identity digest". The
    // decision path used to derive the binding from the persisted manifest, which is a snapshot;
    // replacing the directory under the same path left the stored digest unchanged and the grant
    // silently kept projecting `trusted` against a different filesystem object. The fix
    // re-inspects the live root identity on every decision, so a swap fails closed with a
    // content-free `identity-changed` reason.
    const trust = createWorkspaceScriptTrustService({ store });
    trust.grant(root);
    expect(typecheckTrustState(trust)).toBe("trusted");
    // Use the SUT's own identity digest as the proof-of-swap. Inode comparison is unreliable on
    // ext4 (recycled after rmSync+mkdirSync), while identityDigest is the same key the trust
    // decision compares — if it changes, the SUT is guaranteed to observe a different object.
    const originalIdentityDigest = identityDigestFor(root);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    const newIdentityDigest = identityDigestFor(root);
    expect(newIdentityDigest).not.toBe(originalIdentityDigest);

    expect(typecheckTrustState(trust)).toBe("approval-required");
    const row = store.readWorkspaceTrustRecord(rootReference());
    expect(row?.trust).toBe("restricted");
    expect(readReasonFrom(row?.recordJson)).toBe("identity-changed");
  });

  it("resolves a canonical root to its registered project alias (#2615)", () => {
    // The multi-root trust badges and the editor host ask for trust by `canonicalRoot`, which is
    // `realpath.native`. A registered project path is only normalized, so an exact string match
    // answered PROJECT_NOT_FOUND for the very same directory whenever it was registered through a
    // symlink — and the badge then reported an unreadable trust state for a root that is trusted.
    const target = mkdtempSync(join(tmpdir(), "keiko-trust-alias-target-"));
    const link = join(mkdtempSync(join(tmpdir(), "keiko-trust-alias-link-")), "linked-root");
    try {
      symlinkSync(target, link, "dir");
      store.createProject(link, "linked");
      const trust = createWorkspaceScriptTrustService({ store });

      expect(trust.grant(link)).toEqual({ trusted: true });
      // The canonical spelling names the same root, so it must read the same grant.
      expect(trust.status(nodeWorkspaceFs.realPath(link))).toMatchObject({ trust: "trusted" });
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(link, { force: true });
    }
  });

  it("invalidates an absent-basis grant when the root directory is replaced (#2613/#2615)", () => {
    // The pin above swaps a root that HAS a package.json, so its basis is `known`. #2613 made a
    // root with no manifest grantable, and such a root's basis is permanently `absent`. The
    // durable-invalidation guard tested `outcome !== "known"`, which treats `absent` as an
    // undetermined basis — the conflation ADR-0147 D9 forbids — so for exactly the non-npm roots
    // #2613 enables, a directory swap demoted nothing: the row stayed `trusted` at its original
    // revision, no `identity-changed` reason was recorded, and no restriction reached the LSP pool,
    // leaving a language server running against a directory the grant never covered.
    const bare = mkdtempSync(join(tmpdir(), "keiko-script-trust-bare-swap-"));
    try {
      store.createProject(bare, "bare");
      const notified: string[] = [];
      const trust = createWorkspaceScriptTrustService({
        store,
        onRestricted: (canonicalRoot) => notified.push(canonicalRoot),
      });
      const bareRef = deriveWorkspaceRootRef(nodeWorkspaceFs.realPath(bare));

      expect(trust.grant(bare)).toEqual({ trusted: true });
      expect(trust.trustLevelForRoot(bare)).toBe("trusted");

      const originalIdentityDigest = identityDigestFor(bare);
      rmSync(bare, { recursive: true, force: true });
      mkdirSync(bare, { recursive: true });
      // Still no package.json: the basis stays `absent` across the swap, which is the whole point.
      expect(identityDigestFor(bare)).not.toBe(originalIdentityDigest);

      expect(trust.trustLevelForRoot(bare)).toBe("restricted");
      const row = store.readWorkspaceTrustRecord(bareRef);
      expect(row?.trust).toBe("restricted");
      expect(row?.revision).toBe(1);
      expect(readReasonFrom(row?.recordJson)).toBe("identity-changed");
      expect(notified).toEqual([nodeWorkspaceFs.realPath(bare)]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("persists a content-free restricted invalidation when the manifest digest changes", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    trust.grant(root);
    expect(typecheckTrustState(trust)).toBe("trusted");
    writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
    expect(typecheckTrustState(trust)).toBe("approval-required");
    const row = store.readWorkspaceTrustRecord(rootReference());
    expect(row?.trust).toBe("restricted");
    expect(row?.revision).toBe(1);
    expect(readReasonFrom(row?.recordJson)).toBe("trust-basis-changed");
  });

  it("requires an explicit grant call — wire input cannot mint trust", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
    expect(trust.isTrusted(root, workspace)).toBe(false);
    trust.grant(root);
    expect(trust.isTrusted(root, workspace)).toBe(true);
  });

  // MIGRATION-TRUST-REGRANT, the executable owner of the re-grant drill in
  // docs/keiko-editor/2285-m11-regression-evidence.md. The drill is the whole rollback loop, and
  // ADR-0147 D3 states each leg: restoring the granted trust-basis bytes does NOT resurrect the
  // prior grant, the invalidation is persisted rather than process-local, and only a new explicit
  // server grant returns the root to trusted — at a newer revision. The row used to be mapped to
  // "wire input cannot mint trust" above, which grants once on a fresh store and never touches the
  // basis, so it could not fail this drill however the re-grant path behaved.
  //
  // This is the one case in the matrix that must not use the suite's in-memory store: "the
  // demotion survives a restart" is a claim about the database, and a second service constructed
  // over a live in-memory store proves only that the decision is not cached in the service. So the
  // drill spans a real SQLite file that is closed and reopened between its two halves.
  it("keeps an invalidated grant invalid and restores trust only through an explicit re-grant", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-script-trust-regrant-"));
    const dbPath = join(dir, "ui.db");
    const before = createNodeUiStore(dbPath);
    let invalidatedRevision = -1;
    try {
      before.createProject(root, "fixture");
      const granted = createWorkspaceScriptTrustService({ store: before });
      expect(granted.grant(root)).toEqual({ trusted: true });
      expect(typecheckTrustState(granted, before)).toBe("trusted");

      writeFileSync(join(root, "package.json"), `${MANIFEST}\n`, "utf8");
      expect(typecheckTrustState(granted, before)).toBe("approval-required");
      writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
      expect(typecheckTrustState(granted, before)).toBe("approval-required");

      const invalidated = before.readWorkspaceTrustRecord(rootReference());
      expect(readTrustFrom(invalidated?.recordJson)).toBe("restricted");
      invalidatedRevision = invalidated?.revision ?? -1;
    } finally {
      before.close();
    }

    const after = createNodeUiStore(dbPath);
    try {
      const reopened = createWorkspaceScriptTrustService({ store: after });
      // Read the row back before the projection: "approval-required" is also what a store that
      // lost the record answers, so the projection alone cannot tell remembering from forgetting.
      const persisted = after.readWorkspaceTrustRecord(rootReference());
      expect(readTrustFrom(persisted?.recordJson)).toBe("restricted");
      expect(persisted?.revision).toBe(invalidatedRevision);
      expect(typecheckTrustState(reopened, after)).toBe("approval-required");

      expect(reopened.grant(root)).toEqual({ trusted: true });
      expect(typecheckTrustState(reopened, after)).toBe("trusted");
      const regranted = after.readWorkspaceTrustRecord(rootReference());
      expect(readTrustFrom(regranted?.recordJson)).toBe("trusted");
      expect(regranted?.revision).toBeGreaterThan(invalidatedRevision);
    } finally {
      after.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the originating fs cause on coded errors and omits the property when absent (#2615)", () => {
    // Line 81 branch coverage for `Object.defineProperty(this, "cause", ...)`. The cause is
    // non-enumerable and reaches only redacted operator diagnostics, never the client-facing
    // coded message. The catch sites at resolveCanonicalRoot and currentTrustBinding forward it.
    const cause = new Error("ENOENT: no such file or directory");
    const withCause = new WorkspaceScriptTrustError("PROJECT_NOT_FOUND", "x", cause);
    const withoutCause = new WorkspaceScriptTrustError("WORKSPACE_STATE_UNAVAILABLE", "x");
    expect((withCause as { cause?: unknown }).cause).toBe(cause);
    expect((withoutCause as { cause?: unknown }).cause).toBeUndefined();
    expect(Object.propertyIsEnumerable.call(withCause, "cause")).toBe(false);
  });

  it("throws state-unavailable when the live root identity fails after resolveCanonicalRoot succeeds (#2615)", () => {
    // Line 210 coverage — the ADR-0147 D9 state-unavailable path introduced by this PR. After a
    // grant, replace the directory with a regular file at the same path and supply the workspace
    // so detectWorkspaceAt is bypassed. resolveCanonicalRoot then succeeds (the path exists as a
    // file), but inspectWorkspaceRootIdentity's isDirectory check inside currentTrustBinding
    // throws WORKSPACE_ROOT_INVALID → the local catch converts it to the coded error carrying the
    // fs cause. status() maps that to unavailableStatus rather than throwing on read.
    const trust = createWorkspaceScriptTrustService({ store });
    trust.grant(root);
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "not a directory", "utf8");
    const status = trust.status(root);
    expect(status.trust).toBe("restricted");
    expect(status.reason).toBe("state-unavailable");
  });

  it("throws PROJECT_NOT_FOUND with a preserved cause when .native canonicalization fails (#2615)", () => {
    // Line 255 coverage — the .native snap catch inside resolveCanonicalRoot. Stub the
    // WorkspaceFs.realPath to return a valid-looking canonical string for a path that does not
    // exist on the real filesystem, then supply the same path as workspace to bypass the
    // detectWorkspaceAt step. realpathSync.native (the real node:fs call) then fails with
    // ENOENT, the catch converts it to the coded error carrying the fs cause, and isTrusted's
    // outer try returns false without leaking the throw.
    // Use a mkdtempSync-derived unique path and remove it before the assertion so the ENOENT
    // branch cannot collide with a stale artifact from a prior run or a parallel worker on the
    // same host tmpdir.
    const scratch = mkdtempSync(join(tmpdir(), "keiko-scripttrust-native-snap-"));
    rmSync(scratch, { recursive: true, force: true });
    const fakeRoot = scratch;
    const stubFs: WorkspaceFs = { ...nodeWorkspaceFs, realPath: (): string => fakeRoot };
    const workspace: WorkspaceInfo = {
      root: fakeRoot,
      name: undefined,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    };
    const trust = createWorkspaceScriptTrustService({ store, fs: stubFs });
    expect(trust.isTrusted(root, workspace)).toBe(false);
  });
});

describe("WorkspaceScriptTrust package-manifest basis edge cases", () => {
  // Capture a valid workspace before breaking the manifest so resolveCanonicalRoot succeeds and the
  // basis resolution is the branch actually exercised.
  function validWorkspace(): ReturnType<typeof detectWorkspaceAt> {
    return detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
  }

  it("stays untrusted when package.json is absent", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = validWorkspace();
    rmSync(join(root, "package.json"), { force: true });
    expect(trust.isTrusted(root, workspace)).toBe(false);
  });

  it("stays untrusted and refuses a grant when package.json is not a JSON object", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    writeFileSync(join(root, "package.json"), "[]", "utf8");
    expect(trust.isTrusted(root, validWorkspace())).toBe(false);
    expect(() => trust.grant(root)).toThrow(WorkspaceScriptTrustError);
  });

  it("stays untrusted when package.json is not a regular file", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = validWorkspace();
    rmSync(join(root, "package.json"), { force: true });
    mkdirSync(join(root, "package.json"));
    expect(trust.isTrusted(root, workspace)).toBe(false);
  });

  it("fails closed when the supplied workspace root does not match the project root", () => {
    const foreignRoot = mkdtempSync(join(tmpdir(), "keiko-foreign-ws-"));
    writeFileSync(join(foreignRoot, "package.json"), MANIFEST, "utf8");
    try {
      const trust = createWorkspaceScriptTrustService({ store });
      const foreignWorkspace = detectWorkspaceAt(
        nodeWorkspaceFs.realPath(foreignRoot),
        nodeWorkspaceFs,
      );
      expect(trust.isTrusted(root, foreignWorkspace)).toBe(false);
    } finally {
      rmSync(foreignRoot, { recursive: true, force: true });
    }
  });

  it("durably invalidates a known basis that becomes absent and never resurrects it (#2772)", () => {
    const notified: string[] = [];
    const trust = createWorkspaceScriptTrustService({
      store,
      onRestricted: (canonicalRoot) => notified.push(canonicalRoot),
    });
    const workspace = validWorkspace();
    const canonicalRoot = nodeWorkspaceFs.realPath(root);
    const rootRef = deriveWorkspaceRootRef(canonicalRoot);
    trust.grant(root);
    expect(trust.isTrusted(root, workspace)).toBe(true);

    rmSync(join(root, "package.json"), { force: true });
    expect(trust.isTrusted(root, workspace)).toBe(false);
    const row = store.readWorkspaceTrustRecord(rootRef);
    expect(readTrustFrom(row?.recordJson)).toBe("restricted");
    expect(row?.revision).toBe(1);
    expect(readReasonFrom(row?.recordJson)).toBe("trust-basis-changed");
    expect(notified).toEqual([canonicalRoot]);

    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    expect(trust.isTrusted(root, workspace)).toBe(false);
    const restored = store.readWorkspaceTrustRecord(rootRef);
    expect(readTrustFrom(restored?.recordJson)).toBe("restricted");
    expect(restored?.revision).toBe(1);
  });

  it("keeps a grant durable across a transient unavailable manifest", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = validWorkspace();
    trust.grant(root);
    expect(trust.isTrusted(root, workspace)).toBe(true);

    writeFileSync(join(root, "package.json"), "[]", "utf8");
    expect(trust.isTrusted(root, workspace)).toBe(false);
    const row = store.readWorkspaceTrustRecord(
      deriveWorkspaceRootRef(nodeWorkspaceFs.realPath(root)),
    );
    expect(readTrustFrom(row?.recordJson)).toBe("trusted");

    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    expect(trust.isTrusted(root, workspace)).toBe(true);
  });
});

describe("WorkspaceScriptTrust invalidation reasons", () => {
  function ws(): ReturnType<typeof detectWorkspaceAt> {
    return detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
  }

  function grantAndInjectMutatedRecord(mutate: (binding: MutatedBinding) => void): string {
    const trust = createWorkspaceScriptTrustService({ store });
    trust.grant(root);
    const rootRef = deriveWorkspaceRootRef(nodeWorkspaceFs.realPath(root));
    const parsed = parseTrustRecord(store.readWorkspaceTrustRecord(rootRef)?.recordJson);
    if (!isMutatedBinding(parsed.binding)) {
      throw new Error("granted record binding does not match MutatedBinding shape");
    }
    mutate(parsed.binding);
    // Supersede the grant (revision 0) at a higher revision so the monotonic store guard admits the
    // injected stale record; the resulting invalidation then lands at revision 2.
    parsed.revision = 1;
    store.writeWorkspaceTrustRecord({
      rootRef,
      revision: 1,
      trust: "trusted",
      recordJson: JSON.stringify(parsed),
    });
    trust.isTrusted(root, ws());
    return readReasonFrom(store.readWorkspaceTrustRecord(rootRef)?.recordJson) ?? "";
  }

  it("records identity-changed when the stored root identity digest no longer matches", () => {
    const reason = grantAndInjectMutatedRecord((binding) => {
      binding.rootIdentityDigest = "b".repeat(64);
    });
    expect(reason).toBe("identity-changed");
  });

  it("records manifest-changed when the stored manifest reference no longer matches", () => {
    const reason = grantAndInjectMutatedRecord((binding) => {
      binding.manifestRef = "mf-".padEnd(43, "d");
    });
    expect(reason).toBe("manifest-changed");
  });

  it("keeps the grant when only the workspace-level manifest digest moved", () => {
    // ADR-0155: focus and reorder bump the manifest revision and digest without changing this
    // root or its approved basis, so they must not invalidate. Before ADR-0155 this recorded
    // manifest-changed and every Explorer click revoked trust across the workspace.
    const reason = grantAndInjectMutatedRecord((binding) => {
      binding.manifestDigest = "c".repeat(64);
      binding.manifestRevision += 5;
    });
    expect(reason).toBe("human-grant");
  });
});
