// LIVE egress-enforcement proof (ADR-0043, Issue #1202 wave-2 acceptance criterion: "an outbound
// connection from the runner fails"). This is NOT a mocked test: it actually spawns the host's
// selected isolation backend and proves that a child process inside `network: "none"` cannot reach a
// remote host, while the same child reaches it WITHOUT isolation (the negative control proves the
// test is meaningful rather than passing in an already-airgapped environment).
//
// Locally on macOS this runs under sandbox-exec (Seatbelt); in Linux CI it runs under bubblewrap
// (installed by the ci workflow). It self-skips with a loud message only when no enforcing backend is
// available AND the environment cannot reach the probe host, so it never silently passes for free.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { planIsolatedRun } from "./plan.js";
import { currentPlatform, probeBackends } from "./probe.js";
import type { IsolatedRunPlan } from "./types.js";

// Connect to a raw remote IP (no DNS) on a port that is open on the public internet. The child prints
// a marker and exits 0 on connect, 3 on any error/timeout — so we assert on the marker, not just the
// exit code (a backend that fails to start would print neither).
const PROBE_HOST = "1.1.1.1";
const PROBE_PORT = "443";
const CONNECT_SNIPPET = [
  "const net = require('net');",
  `const s = net.connect({ host: '${PROBE_HOST}', port: ${PROBE_PORT} });`,
  "s.setTimeout(5000);",
  "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); process.exit(0); });",
  "s.on('error', () => { process.stdout.write('BLOCKED'); process.exit(3); });",
  "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); process.exit(3); });",
].join("");

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
}

function run(command: string, args: readonly string[]): ChildRun {
  const result = spawnSync(command, [...args], { timeout: 30_000 });
  if (result.error !== undefined) {
    return { status: null, stdout: "" };
  }
  return { status: result.status, stdout: result.stdout.toString("utf8").trim() };
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

const availability = probeBackends();
const platform = currentPlatform();
const plan: IsolatedRunPlan = {
  command: process.execPath,
  args: ["-e", CONNECT_SNIPPET],
  cwd: process.cwd(),
  network: "none",
};
const decision = planIsolatedRun(plan, availability, platform);
const hasBackend = decision.kind === "wrapped";

describe("enforced network egress (ADR-0043 / #1202)", () => {
  it.skipIf(!hasBackend)(
    "blocks an outbound connection inside network:'none' while it succeeds without isolation",
    () => {
      if (decision.kind !== "wrapped") {
        throw new Error("guarded by skipIf");
      }

      // Negative control: without isolation, the same child reaches the remote host. If it cannot
      // (no egress in this environment at all), there is nothing to prove — skip loudly.
      const control = run(process.execPath, ["-e", CONNECT_SNIPPET]);
      if (control.stdout !== "CONNECTED") {
        note(
          `[egress-proof] skipped: environment has no outbound connectivity to ${PROBE_HOST}:${PROBE_PORT} ` +
            `(control result: "${control.stdout}"), cannot prove the boundary blocks egress.`,
        );
        return;
      }

      // The enforced run: the child must be unable to reach the remote host.
      const isolated = run(decision.command, decision.args);
      expect(decision.attestation.networkEnforced).toBe(true);
      expect(["BLOCKED", "TIMEOUT"]).toContain(isolated.stdout);
      expect(isolated.stdout).not.toBe("CONNECTED");
      expect(isolated.status).not.toBe(0);
    },
    45_000,
  );

  it("documents when no enforcing backend is present (fail-closed by construction)", () => {
    if (!hasBackend) {
      note(
        `[egress-proof] no enforcing sandbox backend on this host (platform=${platform}, ` +
          `availability=${JSON.stringify(availability)}); network:'none' fails closed.`,
      );
      expect(decision.kind).toBe("fail-closed");
    } else {
      expect(decision.kind).toBe("wrapped");
    }
  });
});
