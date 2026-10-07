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
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VerificationReport } from "@oscharko-dev/keiko-contracts";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import {
  buildVerificationPlan,
  detectScripts,
  planDirectTargetedTests,
} from "@oscharko-dev/keiko-verification";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import * as sandbox from "@oscharko-dev/keiko-sandbox";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  executeVerificationEnforced,
  probeNetworkIsolation,
  verificationDependencyFailureHandler,
  verificationTerminationHandler,
  type NetworkIsolationProbe,
} from "./verificationExecution.js";

function note(message: string): void {
  process.stderr.write(`${message}\n`);
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
