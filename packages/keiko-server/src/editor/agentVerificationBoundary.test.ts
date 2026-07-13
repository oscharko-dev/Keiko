// Issue #2215 (Epic #2092 closeout) — independent sandbox-boundary regression evidence for the
// human and agent verification entry paths. Both paths execute through one injected port backed by
// the REAL keiko-verification orchestrator. The only fake is the child process at the final spawn
// seam, which makes the sandbox wrapper and fail-closed no-spawn behavior deterministic and hermetic.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_LIMITS,
  type VerificationReport,
  type VerificationStep,
} from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { SpawnFn } from "@oscharko-dev/keiko-tools";
import { runVerification } from "@oscharko-dev/keiko-verification";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import {
  createVerificationRunnerManager,
  type VerificationExecutePort,
  type VerificationRunInput,
} from "./verificationRunner.js";

const NO_BACKENDS = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
} as const;
const BUBBLEWRAP_BACKEND = { ...NO_BACKENDS, bubblewrap: true } as const;
const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: "tsc --noEmit" },
});

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

interface GovernedPort {
  readonly execute: VerificationExecutePort;
  readonly plans: VerificationStep[][];
  readonly spawnCalls: SpawnCall[];
}

function successfulFakeSpawn(calls: SpawnCall[]): SpawnFn {
  return (command, args): ChildProcess => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242 + calls.length;
    child.kill = (): boolean => true;
    queueMicrotask(() => child.emit("close", 0, null));
    return child as unknown as ChildProcess;
  };
}

function governedPort(backendAvailable: boolean): GovernedPort {
  const plans: VerificationStep[][] = [];
  const spawnCalls: SpawnCall[] = [];
  const spawn = successfulFakeSpawn(spawnCalls);
  const execute: VerificationExecutePort = async (args) => {
    plans.push(args.plan.steps.map((step) => ({ ...step, args: [...step.args] })));
    const report = await runVerification(args.plan, {
      workspace: args.workspace,
      signal: args.signal,
      spawn,
      monitor: { watch: (): (() => void) => (): void => undefined },
      networkEnforcement: "enforce-or-fail-closed",
      enforcedNetworkAvailable: backendAvailable,
      sandboxAvailability: backendAvailable ? BUBBLEWRAP_BACKEND : NO_BACKENDS,
      platform: "linux",
      resolveExecutable: (command) => `/abs/${command}`,
    });
    return {
      report,
      probe: {
        available: backendAvailable,
        backend: backendAvailable ? "bubblewrap" : "none",
      },
    };
  };
  return { execute, plans, spawnCalls };
}

function waitForHumanReport(
  manager: ReturnType<typeof createManager>,
): Promise<VerificationReport> {
  return new Promise((resolve, reject) => {
    const unsubscribe = manager.subscribe((event) => {
      if (event.kind === "run-completed") {
        unsubscribe();
        resolve(event.report);
      } else if (event.kind === "run-failed") {
        unsubscribe();
        reject(new Error(`human verification failed: ${event.reason}`));
      }
    });
  });
}

let workspaceRoot: string;
let store: UiStore;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "keiko-agent-verify-"));
  writeFileSync(join(workspaceRoot, "package.json"), PACKAGE_JSON, "utf8");
  store = createInMemoryUiStore();
  store.createProject(workspaceRoot, "fixture");
});

afterEach(() => {
  store.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function createManager(port: GovernedPort): ReturnType<typeof createVerificationRunnerManager> {
  return createVerificationRunnerManager({
    store,
    evidenceStore: createInMemoryEvidenceStore(),
    execute: port.execute,
    isWorkspaceTrustedForPackageScripts: () => true,
  });
}

function input(): VerificationRunInput {
  return { projectId: workspaceRoot, kinds: ["typecheck"] };
}

function assertEnforced(report: VerificationReport): void {
  const result = report.results[0];
  expect(result?.status).toBe("passed");
  expect(result?.appliedLimits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        dimension: "network",
        limit: "none",
        enforced: true,
      }),
      expect.objectContaining({
        dimension: "wall-time",
        limit: DEFAULT_VERIFICATION_LIMITS.wallTimeMs,
        enforced: true,
      }),
      expect.objectContaining({
        dimension: "output-size",
        limit: DEFAULT_VERIFICATION_LIMITS.maxOutputBytes,
        enforced: true,
      }),
    ]),
  );
}

describe("human and agent verification share the governed sandbox boundary (Issue #2215)", () => {
  it("gives both entry paths the same real sandbox wrapper, kinds, and limits", async () => {
    const port = governedPort(true);
    const manager = createManager(port);
    const humanReportPromise = waitForHumanReport(manager);
    manager.execute(input());
    const humanReport = await humanReportPromise;
    const agentReport = await manager.runToReport(input(), new AbortController().signal);

    expect(port.plans).toHaveLength(2);
    expect(port.plans[0]).toEqual(port.plans[1]);
    expect(port.plans[0]?.map((step) => step.kind)).toEqual(["typecheck"]);
    expect(port.plans[0]?.[0]?.limits).toEqual(DEFAULT_VERIFICATION_LIMITS);
    expect(port.spawnCalls).toHaveLength(2);
    for (const call of port.spawnCalls) {
      expect(call.command).toBe("/abs/bwrap");
      expect(call.args).toContain("--unshare-net");
    }
    assertEnforced(humanReport);
    assertEnforced(agentReport);
  });

  it("denies both entry paths before spawn when no enforcing backend is attested", async () => {
    const port = governedPort(false);
    const manager = createManager(port);
    const humanReportPromise = waitForHumanReport(manager);
    manager.execute(input());
    const humanReport = await humanReportPromise;
    const agentReport = await manager.runToReport(input(), new AbortController().signal);

    expect(port.spawnCalls).toHaveLength(0);
    expect(humanReport.results[0]?.status).toBe("denied");
    expect(agentReport.results[0]?.status).toBe("denied");
    for (const report of [humanReport, agentReport]) {
      expect(report.results[0]?.appliedLimits).toContainEqual(
        expect.objectContaining({ dimension: "network", enforced: false }),
      );
    }
  });
});
