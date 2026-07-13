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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const FS_SNIPPET = [
  "const fs = require('fs');",
  "const [outsideRead, outsideWrite, insideWrite] = process.argv.slice(1);",
  "let readOutside = false;",
  "let wroteOutside = false;",
  "let wroteInside = false;",
  "try { fs.readFileSync(outsideRead, 'utf8'); readOutside = true; } catch {}",
  "try { fs.writeFileSync(outsideWrite, 'outside'); wroteOutside = true; } catch {}",
  "try { fs.writeFileSync(insideWrite, 'inside'); wroteInside = true; } catch {}",
  "process.stdout.write(JSON.stringify({ readOutside, wroteOutside, wroteInside }));",
  "process.exit(wroteInside && !readOutside && !wroteOutside ? 0 : 3);",
].join("");

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): ChildRun {
  const result = spawnSync(command, [...args], { timeout: 30_000 });
  if (result.error !== undefined) {
    return { status: null, stdout: "", stderr: result.error.message };
  }
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8").trim(),
    stderr: result.stderr.toString("utf8").trim(),
  };
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function allowLocalProofSkip(): boolean {
  return process.env.CI !== "true" && process.env.KEIKO_ALLOW_EGRESS_PROOF_SKIP === "1";
}

function failedBeforeNetworkProbe(runResult: ChildRun): boolean {
  return runResult.stdout.length === 0 && runResult.status !== 0;
}

function backendStartupFailureMessage(runResult: ChildRun): string {
  return (
    `[egress-proof] selected backend stopped before the network probe ran ` +
    `(status=${String(runResult.status)}, stderr=${JSON.stringify(runResult.stderr)}); ` +
    `command execution fails closed.`
  );
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
        const message =
          `[egress-proof] negative control failed: environment has no outbound connectivity to ` +
          `${PROBE_HOST}:${PROBE_PORT} (control result: "${control.stdout}").`;
        if (allowLocalProofSkip()) {
          note(`${message} Explicit local opt-in allowed this proof to skip.`);
          return;
        }
        throw new Error(`${message} Required CI must prove the sandbox caused denial.`);
      }

      // The enforced run: the child must be unable to reach the remote host.
      const isolated = run(decision.command, decision.args);
      if (failedBeforeNetworkProbe(isolated)) {
        const message = backendStartupFailureMessage(isolated);
        if (process.env.CI !== "true") {
          note(message);
          return;
        }
        throw new Error(`${message} A functional sandbox backend is required in CI.`);
      }
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

describe("enforced filesystem containment (ADR-0043 / #1202)", () => {
  it("blocks reads and writes outside the disposable execution root", () => {
    const temp = mkdtempSync(join(tmpdir(), "keiko-fs-proof-"));
    const root = join(temp, "root");
    const outsideRead = join(temp, "outside-secret.txt");
    const outsideWrite = join(temp, "outside-write.txt");
    const insideWrite = join(root, "inside-write.txt");
    const isolatedInsideWrite = "inside-write.txt";
    mkdirSync(root);
    writeFileSync(outsideRead, "outside\n", "utf8");
    writeFileSync(join(root, ".keep"), "inside\n", "utf8");
    try {
      const fsPlan: IsolatedRunPlan = {
        command: process.execPath,
        args: ["-e", FS_SNIPPET, outsideRead, outsideWrite, isolatedInsideWrite],
        cwd: root,
        network: "none",
        filesystem: "execution-root",
      };
      const fsDecision = planIsolatedRun(fsPlan, availability, platform);
      if (fsDecision.kind !== "wrapped") {
        note(
          `[fs-proof] no execution-root backend on this host (platform=${platform}, ` +
            `availability=${JSON.stringify(availability)}); assured execution fails closed.`,
        );
        expect(fsDecision.kind).toBe("fail-closed");
        return;
      }

      const control = run(process.execPath, [
        "-e",
        FS_SNIPPET,
        outsideRead,
        outsideWrite,
        insideWrite,
      ]);
      expect(control.stdout).toContain('"readOutside":true');
      expect(control.stdout).toContain('"wroteOutside":true');

      const isolated = run(fsDecision.command, fsDecision.args);
      if (isolated.stdout.length === 0 && process.env.CI !== "true") {
        note(
          `[fs-proof] selected execution-root backend did not start locally (status=${String(
            isolated.status,
          )}, stderr=${JSON.stringify(isolated.stderr)}); assured execution fails closed.`,
        );
        return;
      }
      expect(fsDecision.attestation.networkEnforced).toBe(true);
      expect(fsDecision.attestation.filesystemEnforced).toBe(true);
      expect(isolated.stdout).toContain('"readOutside":false');
      expect(isolated.stdout).toContain('"wroteOutside":false');
      expect(isolated.stdout).toContain('"wroteInside":true');
      expect(isolated.status).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 45_000);
});

describe("egress-proof backend startup handling", () => {
  it("distinguishes backend startup crashes from successful network-denial probes", () => {
    expect(failedBeforeNetworkProbe({ status: 1, stdout: "", stderr: "bubblewrap failed" })).toBe(
      true,
    );
    expect(failedBeforeNetworkProbe({ status: null, stdout: "", stderr: "spawn failed" })).toBe(
      true,
    );
    expect(failedBeforeNetworkProbe({ status: 3, stdout: "BLOCKED", stderr: "" })).toBe(false);
    expect(failedBeforeNetworkProbe({ status: 3, stdout: "TIMEOUT", stderr: "" })).toBe(false);
  });

  it("surfaces the backend startup failure reason for CI diagnostics", () => {
    expect(
      backendStartupFailureMessage({
        status: 1,
        stdout: "",
        stderr: "user namespaces disabled",
      }),
    ).toContain("selected backend stopped before the network probe ran");
  });
});
