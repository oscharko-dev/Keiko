import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createCommandRunnerManager } from "./command-runner.js";
import { createVerificationRunnerManager } from "./editor/verificationRunner.js";
import { deriveWorkspaceRootRef } from "./workspaceTrust/canonicalTrustIdentity.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-script-trust-"));
  writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

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
      store.createProject(symlinkRoot, "symlink-fixture");
      const trust = createWorkspaceScriptTrustService({ store });

      expect(trust.grant(symlinkRoot)).toEqual({ trusted: true });
      expect(trust.trustLevelForRoot(nodeWorkspaceFs.realPath(symlinkRoot))).toBe("trusted");
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
  function typecheckTrustState(trust: WorkspaceScriptTrustService): string | undefined {
    const verification = createVerificationRunnerManager({
      store,
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
    const originalInode = statSync(root).ino;

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), MANIFEST, "utf8");
    // Prove the same path really is a different filesystem object.
    expect(statSync(root).ino).not.toBe(originalInode);

    expect(typecheckTrustState(trust)).toBe("approval-required");
    const row = store.readWorkspaceTrustRecord(rootReference());
    expect(row?.trust).toBe("restricted");
    const record = JSON.parse(row?.recordJson ?? "{}") as { reason?: string };
    expect(record.reason).toBe("identity-changed");
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
    const record = JSON.parse(row?.recordJson ?? "{}") as { reason?: string };
    expect(record.reason).toBe("trust-basis-changed");
  });

  it("requires an explicit grant call — wire input cannot mint trust", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = detectWorkspaceAt(nodeWorkspaceFs.realPath(root), nodeWorkspaceFs);
    expect(trust.isTrusted(root, workspace)).toBe(false);
    trust.grant(root);
    expect(trust.isTrusted(root, workspace)).toBe(true);
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

  it("keeps a grant durable across a transient unreadable manifest (no permanent demotion)", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    const workspace = validWorkspace();
    trust.grant(root);
    expect(trust.isTrusted(root, workspace)).toBe(true);
    rmSync(join(root, "package.json"), { force: true });
    expect(trust.isTrusted(root, workspace)).toBe(false);
    const row = store.readWorkspaceTrustRecord(
      deriveWorkspaceRootRef(nodeWorkspaceFs.realPath(root)),
    );
    expect((JSON.parse(row?.recordJson ?? "{}") as { trust?: string }).trust).toBe("trusted");
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
    const record = JSON.parse(store.readWorkspaceTrustRecord(rootRef)?.recordJson ?? "{}") as {
      binding: MutatedBinding;
      revision: number;
    };
    mutate(record.binding);
    // Supersede the grant (revision 0) at a higher revision so the monotonic store guard admits the
    // injected stale record; the resulting invalidation then lands at revision 2.
    record.revision = 1;
    store.writeWorkspaceTrustRecord({
      rootRef,
      revision: 1,
      trust: "trusted",
      recordJson: JSON.stringify(record),
    });
    trust.isTrusted(root, ws());
    return (
      (
        JSON.parse(store.readWorkspaceTrustRecord(rootRef)?.recordJson ?? "{}") as {
          reason?: string;
        }
      ).reason ?? ""
    );
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
