import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const proxyStart = vi.hoisted(() => vi.fn<() => Promise<never>>());
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
