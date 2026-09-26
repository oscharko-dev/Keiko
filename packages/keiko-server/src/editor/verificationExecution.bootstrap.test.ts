import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { RunCommandDeps, RunCommandInput, CommandResult } from "@oscharko-dev/keiko-tools";
import type { RegistryEgressProxy } from "../../../keiko-verification/dist/registryEgress.js";
import { runDependencyBootstrap } from "../../../keiko-verification/dist/dependencies.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createActivityLogSink, closeFileServerLogSinks } from "../observability/index.js";
import { createVerificationRunnerManager } from "./verificationRunner.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";

const proxyStart = vi.hoisted(() => vi.fn<() => Promise<RegistryEgressProxy>>());
const spawnBoundary = vi.hoisted(() => ({ run: undefined as RunCommandDeps["spawn"] | undefined }));
const executableBoundary = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../../../keiko-tools/dist/exec.js", async (original) => {
  const actual = await original<typeof import("../../../keiko-tools/dist/exec.js")>();
  return {
    ...actual,
    nodeSpawnFn: (...args: Parameters<RunCommandDeps["spawn"]>): ChildProcess =>
      (spawnBoundary.run ?? actual.nodeSpawnFn)(...args),
    runCommand: (input: RunCommandInput, deps: RunCommandDeps): Promise<CommandResult> =>
      actual.runCommand(
        input,
        executableBoundary.error === undefined
          ? deps
          : {
              ...deps,
              resolveExecutable: (): string => {
                throw executableBoundary.error ?? new Error("missing resolver fixture");
              },
            },
      ),
  };
});
// Only the OS/network boundary fails. Runner, execution composition, orchestrator and bootstrap
// are the production implementations, including the packaged cross-package imports.
vi.mock("../../../keiko-verification/dist/registryEgress.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  startRegistryEgressProxy: proxyStart,
}));

let root: string;
let stateDir: string;
let store: UiStore;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-bootstrap-proof-")));
  stateDir = mkdtempSync(join(tmpdir(), "keiko-bootstrap-log-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { typecheck: "tsc --noEmit" },
      devDependencies: { typescript: "^6.0.3" },
    }),
  );
  store = createInMemoryUiStore();
  store.createProject(root);
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  proxyStart.mockReset();
  executableBoundary.error = undefined;
  spawnBoundary.run = undefined;
});
afterEach(() => {
  store.close();
  closeFileServerLogSinks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
function manager(): ReturnType<typeof createVerificationRunnerManager> {
  return createVerificationRunnerManager({
    store,
    evidenceStore: createInMemoryEvidenceStore(),
    isWorkspaceTrustedForPackageScripts: () => true,
    diagnostics: defaultServerDiagnosticSink,
    activityLog: createActivityLogSink(stateDir),
  });
}
function failure(): Error {
  const error = new TypeError("PRIVATE_REGISTRY_FAILURE", {
    cause: new RangeError("PRIVATE_CAUSE"),
  });
  error.stack =
    "TypeError: PRIVATE_REGISTRY_FAILURE\n    at startRegistryEgressProxy (/app/packages/keiko-verification/dist/registryEgress.js:50:4)";
  return error;
}
function proxy(): RegistryEgressProxy {
  return {
    url: "http://127.0.0.1:4873",
    counts: () => ({ allowed: 0, refused: 0 }),
    fault: () => undefined,
    close: () => Promise.resolve(),
  };
}
function installedTree(): void {
  mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
  writeFileSync(join(root, "node_modules", "typescript", "index.js"), "original");
  writeFileSync(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/typescript": {
          resolved: "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
          integrity: "sha512-YWJj",
          version: "6.0.3",
        },
      },
    }),
  );
}
async function completedInstall(): Promise<void> {
  installedTree();
  const spawn = (): ChildProcess => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (): boolean => true,
    });
    queueMicrotask(() => child.emit("close", 0, null));
    return child as unknown as ChildProcess;
  };
  const result = await runDependencyBootstrap(
    { kind: "install", lockfile: "absent" },
    {
      workspace: detectWorkspace(root),
      fs: nodeWorkspaceFs,
      spawn,
      processEnv: { PATH: "/usr/bin" },
      now: Date.now,
      resolveExecutable: () => "/usr/bin/npm",
      startEgressProxy: () => Promise.resolve(proxy()),
    },
  );
  expect(result.summary.completionRecorded).toBe(true);
}
describe("composed verification dependency bootstrap", () => {
  it("persists the real proxy failure with its initiating correlation and classified cause", async () => {
    proxyStart.mockRejectedValue(failure());
    const result = await manager().runToReport(
      {
        projectId: root,
        kinds: ["typecheck"],
        correlationId: "bootstrap-failure-request",
      },
      new AbortController().signal,
    );
    expect(result.report.overallStatus).toBe("failed");
    expect(proxyStart).toHaveBeenCalledOnce();
    const raw = readPersistedActivityLog(stateDir);
    const line = persistedActivityLogLines(raw, "server.diagnostic.failure").at(-1);
    expect(
      expectActivityLogProof("server.diagnostic.failure.activity-log-line", line ?? ""),
    ).toMatchObject({
      op: "server.diagnostic.failure",
      correlationId: "bootstrap-failure-request",
      errorKind: "internal",
      source: "verification.dependency-bootstrap.proxy-start",
      diagnosticOperation: "verification.dependency-bootstrap",
      diagnosticErrorClass: "TypeError",
      frames: ["packages/keiko-verification/dist/registryEgress.js:50:4"],
      causeChain: ["RangeError"],
    });
    expect(raw).not.toContain("PRIVATE_");
    expect(raw).not.toContain(root);
    const dependency = persistedActivityLogLines(raw, "editor.verification.dependencies").at(-1);
    expect(
      expectActivityLogProof("editor.verification.dependencies.emitted-line", dependency ?? ""),
    ).toMatchObject({
      correlationId: "bootstrap-failure-request",
      state: "failed",
      completionReceipt: "missing",
      completionRecorded: false,
    });
  });

  it("persists command-resolution failure from the real command executor", async () => {
    proxyStart.mockResolvedValue(proxy());
    const error = failure();
    error.stack =
      "TypeError: PRIVATE_RESOLVER\n    at resolveExecutable (/app/packages/keiko-tools/dist/exec.js:800:4)";
    executableBoundary.error = error;
    const result = await manager().runToReport(
      { projectId: root, kinds: ["typecheck"], correlationId: "bootstrap-command-request" },
      new AbortController().signal,
    );
    expect(result.report.overallStatus).toBe("failed");
    const raw = readPersistedActivityLog(stateDir);
    const line = persistedActivityLogLines(raw, "server.diagnostic.failure").at(-1);
    expect(
      expectActivityLogProof("server.diagnostic.failure.activity-log-line", line ?? ""),
    ).toMatchObject({
      correlationId: "bootstrap-command-request",
      errorKind: "internal",
      source: "verification.dependency-bootstrap.command",
      diagnosticErrorClass: "TypeError",
      frames: ["packages/keiko-tools/dist/exec.js:800:4"],
      causeChain: ["RangeError"],
    });
    expect(raw).not.toContain("PRIVATE_");
    expect(raw).not.toContain(root);
  });

  it("persists inconclusive installation inspection and refuses without spawning npm", async () => {
    await completedInstall();
    const originalStat = nodeWorkspaceFs.stat;
    const cause = Object.assign(failure(), { code: "EACCES" });
    vi.spyOn(nodeWorkspaceFs, "stat").mockImplementation((path) => {
      if (path === join(root, "node_modules", "typescript", "index.js")) throw cause;
      return originalStat(path);
    });
    const result = await manager().runToReport(
      { projectId: root, kinds: ["typecheck"], correlationId: "bootstrap-inspection-request" },
      new AbortController().signal,
    );
    expect(result.report.overallStatus).toBe("failed");
    expect(proxyStart).not.toHaveBeenCalled();
    const raw = readPersistedActivityLog(stateDir);
    const line = persistedActivityLogLines(raw, "server.diagnostic.failure").at(-1);
    expect(
      expectActivityLogProof("server.diagnostic.failure.activity-log-line", line ?? ""),
    ).toMatchObject({
      correlationId: "bootstrap-inspection-request",
      errorKind: "internal",
      source: "verification.dependency-bootstrap.inspection",
      code: "DEPENDENCY_TREE_UNREADABLE",
      causeChain: ["TypeError", "RangeError"],
    });
    expect(raw).not.toContain("PRIVATE_");
    expect(raw).not.toContain(root);
  });

  it("persists a correlated redacted post-install inspection failure through the real composition", async () => {
    proxyStart.mockResolvedValue(proxy());
    const originalStat = nodeWorkspaceFs.stat;
    const cause = Object.assign(failure(), { code: "EACCES" });
    let exited = false;
    vi.spyOn(nodeWorkspaceFs, "stat").mockImplementation((path) => {
      if (exited && path === join(root, "node_modules", "typescript", "index.js")) throw cause;
      return originalStat(path);
    });
    spawnBoundary.run = (): ChildProcess => {
      installedTree();
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: (): boolean => true,
      });
      queueMicrotask(() => {
        exited = true;
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    };
    const result = await manager().runToReport(
      { projectId: root, kinds: ["typecheck"], correlationId: "bootstrap-post-proxy-request" },
      new AbortController().signal,
    );
    expect(result.report.overallStatus).toBe("failed");
    expect(exited).toBe(true);
    const raw = readPersistedActivityLog(stateDir);
    const line = persistedActivityLogLines(raw, "server.diagnostic.failure").at(-1);
    expect(
      expectActivityLogProof("server.diagnostic.failure.activity-log-line", line ?? ""),
    ).toMatchObject({
      correlationId: "bootstrap-post-proxy-request",
      errorKind: "internal",
      source: "verification.dependency-bootstrap.post-proxy",
      diagnosticOperation: "verification.dependency-bootstrap",
      code: "DEPENDENCY_TREE_UNREADABLE",
      causeChain: ["TypeError", "RangeError"],
    });
    expect(raw).not.toContain("PRIVATE_");
    expect(raw).not.toContain(root);
    const dependency = persistedActivityLogLines(raw, "editor.verification.dependencies").at(-1);
    expect(
      expectActivityLogProof("editor.verification.dependencies.emitted-line", dependency ?? ""),
    ).toMatchObject({
      correlationId: "bootstrap-post-proxy-request",
      state: "failed",
      completionRecorded: false,
    });
  });

  it("holds the workspace until verification settles and then admits the queued run", async () => {
    let rejectPending: (reason: Error) => void = () => {
      throw new Error("pending proxy not initialized");
    };
    const pending = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    proxyStart.mockImplementationOnce(() => pending).mockRejectedValue(failure());
    const runner = manager();
    const first = runner.runToReport(
      { projectId: root, kinds: ["typecheck"], correlationId: "first-workspace-request" },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(proxyStart).toHaveBeenCalledOnce();
    });
    const second = runner.runToReport(
      { projectId: root, kinds: ["typecheck"], correlationId: "second-workspace-request" },
      new AbortController().signal,
    );
    try {
      expect(proxyStart).toHaveBeenCalledOnce();
    } finally {
      rejectPending(failure());
      await Promise.all([first, second]);
    }
    expect(proxyStart).toHaveBeenCalledTimes(2);
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateDir),
      "editor.verification.workspace",
    );
    const events = lines.map((line) =>
      expectActivityLogProof("editor.verification.workspace.emitted-line", line),
    );
    expect(events.map((event) => [event.correlationId, event.state])).toEqual([
      ["first-workspace-request", "waiting"],
      ["first-workspace-request", "acquired"],
      ["second-workspace-request", "waiting"],
      ["first-workspace-request", "released"],
      ["second-workspace-request", "acquired"],
      ["second-workspace-request", "released"],
    ]);
    expect(new Set(events.map((event) => event.workspaceDigest)).size).toBe(1);
  });
});
