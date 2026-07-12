import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { createCommandRunnerManager } from "./command-runner.js";
import { createVerificationRunnerManager } from "./editor/verificationRunner.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";
import {
  createWorkspaceScriptTrustService,
  WorkspaceScriptTrustError,
} from "./workspace-script-trust.js";

const MANIFEST = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
  devDependencies: { vitest: "1.0.0" },
});

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

  it("rejects a grant for an unregistered project", () => {
    const trust = createWorkspaceScriptTrustService({ store });
    expect(() => trust.grant(join(root, "unregistered"))).toThrow(WorkspaceScriptTrustError);
  });
});
