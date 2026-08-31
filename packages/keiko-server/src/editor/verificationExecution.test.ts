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

import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "@oscharko-dev/keiko-contracts";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";
import { buildVerificationPlan, detectScripts } from "@oscharko-dev/keiko-verification";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import {
  executeVerificationEnforced,
  probeNetworkIsolation,
  verificationTerminationHandler,
  type NetworkIsolationProbe,
} from "./verificationExecution.js";

function note(message: string): void {
  process.stderr.write(`${message}\n`);
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

  it("probeNetworkIsolation reports a real backend label and availability for this host", () => {
    const probe = probeNetworkIsolation(process.cwd());
    expect(typeof probe.backend).toBe("string");
    expect(probe.backend.length).toBeGreaterThan(0);
    expect(typeof probe.available).toBe("boolean");
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
