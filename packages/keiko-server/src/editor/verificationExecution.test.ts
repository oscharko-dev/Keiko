// Issue #2215 fix-up (Epic #2092) — the single governed spawn boundary (executeVerificationEnforced
// composed with probeNetworkIsolation) had ZERO test coverage from any test exercising the editor
// verification runner, routes, or agent route: every one of those injects a fully fake execution
// port (verificationRunner.test.ts, agentVerificationBoundary.test.ts, etc.), so a regression that
// wired executeVerificationEnforced to a hardcoded `enforcedNetworkAvailable: true` (ignoring the real
// probe) would leave that whole suite green. This file exercises the REAL function with a REAL plan
// built the same way verificationRunner.ts builds one (detectScripts + buildVerificationPlan against
// a real package.json) — no injected execution port — mirroring postApplyVerification.test.ts's
// host-adaptive proof pattern (self-documents rather than skips either branch): on a host with an
// enforcing sandbox backend the step actually runs under network:"none"; on a host without one it
// fails closed and NEVER spawns, and the report never claims enforcement it did not actually apply.

import { mkdtemp, rm, realpath, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VerificationReport } from "@oscharko-dev/keiko-contracts";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  buildVerificationPlan,
  detectScripts,
  planDirectTargetedTests,
} from "@oscharko-dev/keiko-verification";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import * as sandbox from "@oscharko-dev/keiko-sandbox";
import type { WindowsStepSupervisor } from "@oscharko-dev/keiko-contracts";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  executeVerificationEnforced,
  probeNetworkIsolation,
  localDockerEngineAnswer,
  probeNetworkIsolationServed,
  verificationDependencyFailureHandler,
  verificationTerminationHandler,
  type NetworkIsolationProbe,
  planIsolationProbe,
  windowsStepRunDeps,
  type ExecuteVerificationArgs,
} from "./verificationExecution.js";

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function listenOn(server: NetServer, path: string): Promise<void> {
  return new Promise((resolve) => {
    server.listen(path, resolve);
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A socket file whose process exited without closing it: the file stays, nobody serves it. */
function leaveStaleSocket(socket: string): void {
  const listener =
    "require('node:net').createServer().listen(process.argv.at(-1), () => process.exit(0));";
  const result = spawnSync(process.execPath, ["-e", listener, socket], { timeout: 10_000 });
  if (result.status !== 0 || !lstatSync(socket).isSocket()) {
    throw new Error("fixture-precondition-stale-socket");
  }
}

async function proveOutsideWriteWithoutConfinement(root: string, outside: string): Promise<void> {
  expect(() => execFileSync(process.execPath, ["verify.cjs"], { cwd: root })).toThrow();
  expect(await readFile(outside, "utf8")).toBe("escaped");
  await writeFile(outside, "unchanged", "utf8");
  await rm(join(root, "inside.txt"));
}

const PACKAGE_JSON = JSON.stringify({
  name: "fixture",
  scripts: { typecheck: 'node -e "process.exit(0)"' },
});

// The enforcing backend is real: the step genuinely spawned and finished under network:"none".
function assertRanUnderEnforcedIsolation(report: VerificationReport): void {
  const result = report.results[0];
  const networkLimit = result?.appliedLimits.find((limit) => limit.dimension === "network");
  expect(result?.status).toBe("passed");
  expect(result?.exitCode).toBe(0);
  expect(networkLimit?.enforced).toBe(true);
}

// Fail-closed: denied BEFORE any spawn (exitCode null, zero duration), never an optimistic
// "ran anyway" result, and the report never asserts network enforcement it did not apply.
function assertFailedClosedWithoutSpawning(
  report: VerificationReport,
  probe: NetworkIsolationProbe,
): void {
  note(
    `[2215-spawn-boundary] no enforcing network backend on this host (backend=${probe.backend}); ` +
      "verification fails closed by construction — this IS the proof, not a skip.",
  );
  const result = report.results[0];
  const networkLimit = result?.appliedLimits.find((limit) => limit.dimension === "network");
  expect(result?.status).toBe("denied");
  expect(result?.exitCode).toBeNull();
  expect(result?.durationMs).toBe(0);
  expect(result?.detail).toContain("no enforcing sandbox backend");
  expect(networkLimit?.enforced).toBe(false);
}

describe("executeVerificationEnforced — the real governed spawn boundary", () => {
  it("runs the exact Node native test target under enforced isolation when available", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-node-test-exec-")));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "node-test-fixture", scripts: { test: "node --test" } }),
        "utf8",
      );
      await writeFile(
        join(root, "average.test.js"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("average", () => assert.equal((2 + 4) / 2, 3));\n',
        "utf8",
      );
      const workspace = detectWorkspaceAt(root);
      expect(workspace.testFramework).toBe("node-test");
      const plan = {
        workspaceRoot: root,
        steps: planDirectTargetedTests(workspace, ["average.test.js"]),
      };
      expect(plan.steps).toHaveLength(1);

      const { report, probe } = await executeVerificationEnforced({
        plan,
        workspace,
        signal: new AbortController().signal,
      });
      if (probe.available) {
        assertRanUnderEnforcedIsolation(report);
      } else {
        assertFailedClosedWithoutSpawning(report, probe);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a real discovered script under enforced isolation when available, or fails closed without spawning when not — never claiming enforcement it did not apply", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-verify-exec-")));
    try {
      await writeFile(join(root, "package.json"), PACKAGE_JSON, "utf8");
      const workspace = detectWorkspaceAt(root);
      const catalog = detectScripts(workspace);
      const plan = buildVerificationPlan(workspace, catalog, { only: ["typecheck"] });
      expect(plan.steps).toHaveLength(1);

      const { report, probe } = await executeVerificationEnforced({
        plan,
        workspace,
        signal: new AbortController().signal,
      });
      expect(report.results).toHaveLength(1);
      if (probe.available) {
        assertRanUnderEnforcedIsolation(report);
      } else {
        assertFailedClosedWithoutSpawning(report, probe);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("allows workspace writes while refusing a repository script's outside write", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-verify-contained-")));
    const outsideParent = await realpath(await mkdtemp(join(tmpdir(), "keiko-verify-outside-")));
    // A bare /tmp filename can refer to writable private sandbox scratch rather than the host
    // sentinel. Its separate parent is not mounted, so this path tests the actual host object.
    const outside = join(outsideParent, "outside.txt");
    await writeFile(outside, "unchanged", "utf8");
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "contained-fixture", scripts: { typecheck: "node verify.cjs" } }),
        "utf8",
      );
      await writeFile(
        join(root, "verify.cjs"),
        `const fs = require("node:fs"); fs.writeFileSync("inside.txt", "allowed"); let blocked = false; try { fs.writeFileSync(${JSON.stringify(outside)}, "escaped"); } catch { blocked = true; } if (!blocked) process.exit(2);`,
        "utf8",
      );
      await proveOutsideWriteWithoutConfinement(root, outside);
      const workspace = detectWorkspaceAt(root);
      const plan = buildVerificationPlan(workspace, detectScripts(workspace), {
        only: ["typecheck"],
      });
      const { report, probe } = await executeVerificationEnforced({
        plan,
        workspace,
        signal: new AbortController().signal,
      });
      expect(await readFile(outside, "utf8")).toBe("unchanged");
      if (probe.available) {
        assertRanUnderEnforcedIsolation(report);
        expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("allowed");
      } else {
        assertFailedClosedWithoutSpawning(report, probe);
        await expect(access(join(root, "inside.txt"))).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideParent, { recursive: true, force: true });
    }
  }, 30_000);

  it("observes a malformed local Docker configuration without customer fields or spawning", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "keiko-docker-probe-")));
    const root = join(parent, "workspace");
    const directory = join(parent, "configuration");
    const records: ServerDiagnosticRecord[] = [];
    const availability = vi.spyOn(sandbox, "probeBackends").mockReturnValue({
      bubblewrap: false,
      unshare: false,
      seatbelt: false,
      docker: true,
      podman: false,
    });
    try {
      await mkdir(root);
      await mkdir(directory);
      await writeFile(
        join(directory, "config.json"),
        "customer-configuration-sentinel-invalid-json",
      );
      vi.stubEnv("DOCKER_CONFIG", directory);
      vi.stubEnv("DOCKER_CONTEXT", "");
      vi.stubEnv("DOCKER_HOST", "");
      const probe = probeNetworkIsolation(
        root,
        {
          record: (record): void => {
            records.push(record);
          },
        },
        "docker-probe-correlation-1",
      );
      expect(probe).toEqual({ available: false, backend: "container-docker" });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "verification.isolation-probe",
        source: "verification.isolation-probe.local-docker",
        correlationId: "docker-probe-correlation-1",
      });
      expect(JSON.stringify(records)).not.toContain("customer-configuration-sentinel");
      expect(JSON.stringify(records)).not.toContain(parent);
    } finally {
      availability.mockRestore();
      vi.unstubAllEnvs();
      await rm(parent, { recursive: true, force: true });
    }
  });

  // #4519: a Docker that crashed or was stopped can leave its socket file behind. The file still
  // stats as a socket, so the probe read a stopped engine as an enforcing backend and the step then
  // failed inside the Docker client as if the project's own check had failed.
  it.skipIf(process.platform === "win32")(
    "reads a leftover Docker socket as unavailable and an engine that answers its ping as available (#4519)",
    async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "keiko-docker-served-")));
      const root = join(parent, "workspace");
      const stale = join(parent, "stale.sock");
      const live = join(parent, "live.sock");
      const engine = createHttpServer((request, response) => {
        response.statusCode = request.url === "/_ping" ? 200 : 404;
        response.end("OK");
      });
      const availability = vi.spyOn(sandbox, "probeBackends").mockReturnValue({
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: true,
        podman: false,
      });
      try {
        await mkdir(root);
        leaveStaleSocket(stale);
        await listenOn(engine, live);
        vi.stubEnv("DOCKER_CONTEXT", "");
        vi.stubEnv("DOCKER_HOST", `unix://${stale}`);
        // The socket file alone still reads as a running engine to the synchronous probe.
        expect(probeNetworkIsolation(root)).toEqual({
          available: true,
          backend: "container-docker",
        });
        expect(await probeNetworkIsolationServed(root)).toEqual({
          available: false,
          backend: "container-docker",
          engine: "refused",
        });
        vi.stubEnv("DOCKER_HOST", `unix://${live}`);
        expect(await probeNetworkIsolationServed(root)).toEqual({
          available: true,
          backend: "container-docker",
          engine: "answered",
        });
      } finally {
        availability.mockRestore();
        vi.unstubAllEnvs();
        await closeServer(engine);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "counts only an engine that answers its ping, never one that is starting or silent (#4519)",
    async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "keiko-docker-ping-")));
      const starting = createHttpServer((_request, response) => {
        response.statusCode = 500;
        response.end();
      });
      const held: Socket[] = [];
      const silent = createServer((socket) => {
        held.push(socket);
      });
      try {
        await listenOn(starting, join(parent, "starting.sock"));
        await listenOn(silent, join(parent, "silent.sock"));
        expect(await localDockerEngineAnswer(`unix://${join(parent, "starting.sock")}`)).toBe(
          "rejected",
        );
        expect(await localDockerEngineAnswer(`unix://${join(parent, "silent.sock")}`, 200)).toBe(
          "unanswered",
        );
        expect(await localDockerEngineAnswer(`unix://${join(parent, "missing.sock")}`)).toBe(
          "refused",
        );
        // A named pipe that resolved is already served; a remote endpoint never is.
        expect(await localDockerEngineAnswer("npipe:////./pipe/docker_engine")).toBe("answered");
        expect(await localDockerEngineAnswer("tcp://127.0.0.1:2375")).toBe("refused");
      } finally {
        for (const socket of held) socket.destroy();
        await closeServer(starting);
        await closeServer(silent);
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("probeNetworkIsolation reports a real backend label and availability for this host", () => {
    const probe = probeNetworkIsolation(process.cwd());
    expect(typeof probe.backend).toBe("string");
    expect(probe.backend.length).toBeGreaterThan(0);
    expect(typeof probe.available).toBe("boolean");
  });
});

// F14 (#3873): the isolation probe runs before the report's own clock starts, so its wall time was in
// no number the log carried, and the egress policy the orchestrator ran under was an inline literal
// nothing reported. The execution now hands both back next to the report, so the manager can put
// them on the run's completion line.
describe("executeVerificationEnforced — what the execution reports about its own isolation (F14, #3873)", () => {
  it("measures the probe's own wall time and reports the egress policy the orchestrator ran under", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-verify-probe-time-")));
    const availability = vi.spyOn(sandbox, "probeBackends");
    try {
      await writeFile(join(root, "package.json"), PACKAGE_JSON, "utf8");
      const workspace = detectWorkspaceAt(root);
      const plan = buildVerificationPlan(workspace, detectScripts(workspace), {
        only: ["typecheck"],
      });
      // Only Date is faked: the probe "takes" seven seconds on a clock the test owns, while the rest
      // of the execution (a step denied before any spawn) runs on the real event loop.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000_000);
      availability.mockImplementation(() => {
        vi.setSystemTime(Date.now() + 7_000);
        return { bubblewrap: false, unshare: false, seatbelt: false, docker: false, podman: false };
      });

      const result = await executeVerificationEnforced({
        plan,
        workspace,
        signal: new AbortController().signal,
      });

      expect(result.probeDurationMs).toBe(7_000);
      expect(result.networkEnforcement).toBe("enforce-or-fail-closed");
      expect(result.probe).toEqual({ available: false, backend: "none" });
      // The policy reported is the one the orchestrator received: with no backend it denied the step
      // before spawning, which only the fail-closed mode does.
      expect(result.report.results[0]?.status).toBe("denied");
    } finally {
      vi.useRealTimers();
      availability.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a whole, non-negative probe duration on any host", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-verify-probe-whole-")));
    try {
      // No script to run: the step is skipped before any spawn, so the real probe is the only
      // host-dependent part and the test is hermetic on a host with or without a backend.
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-scripts" }), "utf8");
      const workspace = detectWorkspaceAt(root);
      const plan = buildVerificationPlan(workspace, detectScripts(workspace), {
        only: ["typecheck"],
      });

      const result = await executeVerificationEnforced({
        plan,
        workspace,
        signal: new AbortController().signal,
      });

      expect(Number.isSafeInteger(result.probeDurationMs)).toBe(true);
      expect(result.probeDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.networkEnforcement).toBe("enforce-or-fail-closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Audit finding: VerificationRunnerManager already tracks a per-run correlationId at both of its
// executePort call sites but never forwarded it into executeVerificationEnforced, so every
// verification termination line was stamped UNKNOWN_CORRELATION_ID even when the run's real id was
// sitting right there. Unit-tested directly (rather than through a real timeout/abort) because
// forcing termination through the real spawn boundary is host-dependent: on a host with no
// enforcing sandbox backend the run denies BEFORE spawning and onTerminated never fires at all.
describe("verificationTerminationHandler — correlation-id wiring for the runCommand evidence seam", () => {
  function captureLog(): {
    events: ServerLogEvent[];
    sink: { write: (e: ServerLogEvent) => void };
  } {
    const events: ServerLogEvent[] = [];
    return { events, sink: { write: (event): void => void events.push(event) } };
  }

  it("carries the caller's own correlationId onto the emitted line instead of downgrading it", () => {
    const log = captureLog();
    const handler = verificationTerminationHandler(log.sink, "verify-run-correlation-9");
    handler({ reason: "abort", childPid: 4242, windowsTreeKill: "not-attempted" });
    expect(log.events).toHaveLength(1);
    expect(log.events[0]?.op).toBe("command.terminated");
    expect(log.events[0]?.correlationId).toBe("verify-run-correlation-9");
  });

  it("falls back to UNKNOWN_CORRELATION_ID only when the caller genuinely has none in scope", () => {
    const log = captureLog();
    const handler = verificationTerminationHandler(log.sink, undefined);
    handler({ reason: "timeout", childPid: 4242, windowsTreeKill: "not-attempted" });
    expect(log.events[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
  });
});

it("records dependency bootstrap failure stages without leaking the error message", () => {
  const diagnostics = { record: vi.fn() };
  verificationDependencyFailureHandler(
    diagnostics,
    "verify-run-correlation-9",
  )({
    stage: "proxy-start",
    error: new Error("private registry credential"),
  });
  expect(diagnostics.record).toHaveBeenCalledWith(
    expect.objectContaining({
      correlationId: "verify-run-correlation-9",
      source: "verification.dependency-bootstrap.proxy-start",
      errorClass: "Error",
    }),
  );
  expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain(
    "private registry credential",
  );
});

it("records the real final targeted-project cause and forwards the same original fault", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-project-guard-")));
  const records: ServerDiagnosticRecord[] = [];
  const failure = new Error(`PRIVATE_PROJECT ${root}`, { cause: new TypeError("PRIVATE_CAUSE") });
  const observed: unknown[] = [];
  const availability = vi.spyOn(sandbox, "probeBackends").mockReturnValue({
    bubblewrap: true,
    unshare: false,
    seatbelt: false,
    docker: false,
    podman: false,
  });
  const platform = vi.spyOn(sandbox, "currentPlatform").mockReturnValue("linux");
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "4.1.11" } }),
    );
    await mkdir(join(root, "packages/ui/src"), { recursive: true });
    await writeFile(join(root, "packages/ui/package.json"), "{}");
    await writeFile(join(root, "packages/ui/vitest.config.mjs"), "export default {};");
    await writeFile(join(root, "packages/ui/src/a.test.ts"), "");
    const workspace = detectWorkspaceAt(root);
    const plan = {
      workspaceRoot: root,
      steps: planDirectTargetedTests(workspace, ["packages/ui/src/a.test.ts"]),
    };
    const { report } = await executeVerificationEnforced({
      plan,
      workspace,
      signal: new AbortController().signal,
      correlationId: "project-guard-correlation",
      fs: {
        ...nodeWorkspaceFs,
        stat: (path) => {
          if (path === join(root, "packages/ui")) throw failure;
          return nodeWorkspaceFs.stat(path);
        },
      },
      diagnostics: {
        record: (record) => {
          records.push(record);
        },
      },
      onTargetedProjectFailure: (error) => {
        observed.push(error);
      },
    });
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.exitCode).toBeNull();
    expect(observed).toEqual([failure]);
    expect(records).toEqual([
      expect.objectContaining({
        operation: "verification.targeted-project",
        source: "verification.targeted-project.guard",
        correlationId: "project-guard-correlation",
        errorClass: "Error",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    expect(JSON.stringify(records)).not.toContain(root);
  } finally {
    availability.mockRestore();
    platform.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

describe("planIsolationProbe (#4496)", () => {
  const NONE = {
    bubblewrap: false,
    unshare: false,
    seatbelt: false,
    docker: false,
    podman: false,
  } as const;
  const cwd = String.raw`C:\work\repo`;
  const STEP_SUPERVISOR: WindowsStepSupervisor = {
    acquire: () => ({
      path: String.raw`C:\Temp\keiko-runtime-supervisor.exe`,
      drives: [],
      release: () => 0,
      refused: () => 0,
    }),
    readRoots: [],
    profile: String.raw`C:\Users\dev`,
    admitReadRoot: (directory) => directory,
  };

  it("keeps a served Docker on Windows even when the supervisor is available", () => {
    expect(
      planIsolationProbe(
        cwd,
        { ...NONE, docker: true, windowsAppContainer: true },
        "win32",
        () => true,
      ),
    ).toEqual({ available: true, backend: "container-docker" });
  });

  it("gives a Windows run whose Docker is not served to the supervisor's step backend", () => {
    expect(
      planIsolationProbe(
        cwd,
        { ...NONE, docker: true, windowsAppContainer: true },
        "win32",
        () => false,
      ),
    ).toEqual({ available: true, backend: "windows-appcontainer" });
  });

  it("prefers Podman over the step backend when Docker is not served", () => {
    expect(
      planIsolationProbe(
        cwd,
        { ...NONE, docker: true, podman: true, windowsAppContainer: true },
        "win32",
        () => false,
      ),
    ).toEqual({ available: true, backend: "container-podman" });
  });

  it("refuses a Docker that is not served where no step backend exists, exactly as before", () => {
    expect(planIsolationProbe(cwd, { ...NONE, docker: true }, "win32", () => false)).toEqual({
      available: false,
      backend: "container-docker",
    });
    expect(
      planIsolationProbe("/work/repo", { ...NONE, docker: true }, "darwin", () => false),
    ).toEqual({ available: false, backend: "container-docker" });
  });

  it("runs on the step backend without any container runtime and refuses without it", () => {
    expect(
      planIsolationProbe(cwd, { ...NONE, windowsAppContainer: true }, "win32", () => false),
    ).toEqual({
      available: true,
      backend: "windows-appcontainer",
    });
    expect(planIsolationProbe(cwd, NONE, "win32", () => false)).toMatchObject({ available: false });
  });

  it("hands the steps the backends the probe planned with, so an unserved Docker never takes them", () => {
    const probe = { available: true, backend: "windows-appcontainer" } as const;
    const installed = { ...NONE, docker: true };
    const deps = windowsStepRunDeps(probe, STEP_SUPERVISOR, installed);
    expect(deps.enforcedNetworkAvailable).toBe(true);
    expect(deps.sandboxAvailability).toBeDefined();
    expect(
      sandbox.planIsolatedRun(
        { command: "node", args: [], cwd, network: "none", filesystem: "execution-root" },
        deps.sandboxAvailability ?? installed,
        "win32",
      ).attestation.backend,
    ).toBe("windows-appcontainer");
  });

  it("refuses the run when the supervisor the probe saw is gone when the steps start", () => {
    const probe = { available: true, backend: "windows-appcontainer" } as const;
    expect(windowsStepRunDeps(probe, undefined, NONE)).toEqual({ enforcedNetworkAvailable: false });
  });

  it("leaves every other backend's run as the probe found it", () => {
    const probe = { available: true, backend: "container-docker" } as const;
    expect(windowsStepRunDeps(probe, undefined, NONE)).toEqual({ enforcedNetworkAvailable: true });
  });
});

describe("executeVerificationEnforced — the Windows step Node.js of a run (#4491)", () => {
  it("copies the install's step Node.js only once the run holds its workspace, and removes the copy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-step-node-run-")));
    try {
      const order: string[] = [];
      const supervisor: WindowsStepSupervisor = {
        acquire: () => ({ path: "supervisor.exe", drives: [], release: () => 0, refused: () => 0 }),
        readRoots: [],
        profile: String.raw`C:\Users\dev`,
        admitReadRoot: (directory) => directory,
        stepNode: {
          directory: "/install/step-node",
          executable: "/install/step-node/node.exe",
          record: () => undefined,
        },
      };
      const run = (): Promise<unknown> =>
        executeVerificationEnforced({
          plan: { workspaceRoot: root, steps: [] },
          workspace: detectWorkspaceAt(root),
          signal: new AbortController().signal,
          isolation: {
            probe: { available: true, backend: "windows-appcontainer" },
            durationMs: 0,
            windowsStep: { supervisor },
          },
          stepNodeCopy: {
            pin: () => ({ sha256: "ab", sizeBytes: 1, sourceSha256: "", patchSha256s: [] }),
            makeDirectory: () => {
              order.push("copy");
              return Promise.resolve(join(root, "unused"));
            },
            copyFile: () => Promise.resolve(),
            sizeOf: () => Promise.resolve(1),
            sha256: () => Promise.resolve("ab"),
            removeDirectory: () => {
              order.push("remove");
              return Promise.resolve();
            },
          },
        });
      await run();
      // The copy is made inside the run's exclusive scope and removed when the run ends.
      expect(order).toEqual(["copy", "remove"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("executeVerificationEnforced — an offered step Node.js is pinned or the run is refused (#4491)", () => {
  const PIN = { sha256: "ab", sizeBytes: 1, sourceSha256: "", patchSha256s: [] };

  function supervisorWith(offered: boolean): WindowsStepSupervisor {
    return {
      acquire: () => ({ path: "supervisor.exe", drives: [], release: () => 0, refused: () => 0 }),
      readRoots: [],
      profile: String.raw`C:\Users\dev`,
      admitReadRoot: (directory) => directory,
      ...(offered
        ? {
            stepNode: {
              directory: "/install/step-node",
              executable: "/install/step-node/node.exe",
              record: () => undefined,
            },
          }
        : {}),
    };
  }

  async function runWith(
    offered: boolean,
    copy: Partial<NonNullable<ExecuteVerificationArgs["stepNodeCopy"]>>,
    records: ServerDiagnosticRecord[] = [],
  ): ReturnType<typeof executeVerificationEnforced> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "keiko-step-node-pin-")));
    try {
      return await executeVerificationEnforced({
        plan: { workspaceRoot: root, steps: [] },
        workspace: detectWorkspaceAt(root),
        signal: new AbortController().signal,
        diagnostics: { record: (record): void => void records.push(record) },
        isolation: {
          probe: { available: true, backend: "windows-appcontainer" },
          durationMs: 0,
          windowsStep: { supervisor: supervisorWith(offered) },
        },
        stepNodeCopy: {
          pin: () => PIN,
          makeDirectory: () => Promise.resolve(join(root, "unused")),
          copyFile: () => Promise.resolve(),
          sizeOf: () => Promise.resolve(1),
          sha256: () => Promise.resolve("ab"),
          removeDirectory: () => Promise.resolve(),
          ...copy,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.each([
    ["a size mismatch", { sizeOf: (): Promise<number> => Promise.resolve(2) }, "size"],
    ["a hash mismatch", { sha256: (): Promise<string> => Promise.resolve("cd") }, "hash"],
    [
      "a failed copy",
      { copyFile: (): Promise<void> => Promise.reject(new Error("denied")) },
      "copy-failed",
    ],
    ["no pin", { pin: (): undefined => undefined }, "no-pin"],
  ] as const)(
    "refuses the run on %s, with a closed reason and a body-free diagnostic",
    async (_n, copy, outcome) => {
      const records: ServerDiagnosticRecord[] = [];
      await expect(runWith(true, copy, records)).rejects.toMatchObject({
        reason: "step-node-pin-mismatch",
        outcome,
        code: "VERIFICATION_RUNNER_UNAVAILABLE",
      });
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain("/install/step-node");
    },
  );

  it("keeps the fallback only when no step Node.js was ever offered", async () => {
    const { report } = await runWith(false, { sha256: () => Promise.resolve("cd") });
    expect(report.results).toEqual([]);
  });

  it("never lets a failed removal of the copy replace the run's result, and reports it", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const { report } = await runWith(
      true,
      { removeDirectory: () => Promise.reject(new Error("busy")) },
      records,
    );
    expect(report.results).toEqual([]);
    expect(records).toHaveLength(1);
  });
});
