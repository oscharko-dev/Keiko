// Issue #1204 — enforced network-egress isolation for verification (ADR-0043). Covers the pure
// per-step network resolution and runtime behaviours: the default mode fails closed for
// network:"none" steps unless an enforcing backend is attested, explicit "inherit" preserves the
// compatibility escape hatch, "enforce-or-degrade" falls back to an honest inherited-network run
// when no backend is available, and "enforce-or-fail-closed" DENIES the step before spawning so
// untrusted code never runs without an enforced boundary.

import { describe, expect, it } from "vitest";
import { resolveStepNetwork, runVerification, type VerificationDeps } from "./orchestrator.js";
import type { VerificationPlan, VerificationResourceLimits, VerificationStep } from "./types.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";
import { fakeMonitor, makeWorkspace, recordingSpawn, scriptChildClose } from "./_support.js";

const NONE_LIMITS: VerificationResourceLimits = { ...DEFAULT_VERIFICATION_LIMITS, network: "none" };
const INHERIT_LIMITS: VerificationResourceLimits = {
  ...DEFAULT_VERIFICATION_LIMITS,
  network: "inherit",
};
const NO_BACKENDS = {
  bubblewrap: false,
  unshare: false,
  seatbelt: false,
  docker: false,
  podman: false,
} as const;
const BUBBLEWRAP_BACKEND = { ...NO_BACKENDS, bubblewrap: true } as const;
const ABS_RESOLVER: NonNullable<VerificationDeps["resolveExecutable"]> = (command) =>
  `/abs/${command}`;

function targetedStep(limits: VerificationResourceLimits): VerificationStep {
  return {
    kind: "targeted-test",
    scriptName: undefined,
    command: "npx",
    args: ["vitest", "run", "src/foo.test.ts"],
    limits,
  };
}

function planOf(steps: readonly VerificationStep[], root: string): VerificationPlan {
  return { workspaceRoot: root, steps };
}

function depsWith(
  ws: ReturnType<typeof makeWorkspace>,
  spawnFn: VerificationDeps["spawn"],
  extra: Partial<VerificationDeps> = {},
): VerificationDeps {
  return { workspace: ws.info, spawn: spawnFn, monitor: fakeMonitor(), now: () => 1_000, ...extra };
}

describe("resolveStepNetwork — pure decision", () => {
  it('explicit "inherit" mode always resolves to inherit, even for a network:"none" step', () => {
    expect(resolveStepNetwork(NONE_LIMITS, "inherit", true)).toEqual({
      kind: "run",
      network: "inherit",
    });
    expect(resolveStepNetwork(NONE_LIMITS, "inherit", false)).toEqual({
      kind: "run",
      network: "inherit",
    });
  });

  it("an enforce mode leaves a non-none step on inherit", () => {
    expect(resolveStepNetwork(INHERIT_LIMITS, "enforce-or-fail-closed", false)).toEqual({
      kind: "run",
      network: "inherit",
    });
  });

  it("enforce + available resolves a none step to an enforced none run", () => {
    expect(resolveStepNetwork(NONE_LIMITS, "enforce-or-degrade", true)).toEqual({
      kind: "run",
      network: "none",
    });
    expect(resolveStepNetwork(NONE_LIMITS, "enforce-or-fail-closed", true)).toEqual({
      kind: "run",
      network: "none",
    });
  });

  it("enforce-or-degrade with no backend honestly falls back to inherit", () => {
    expect(resolveStepNetwork(NONE_LIMITS, "enforce-or-degrade", false)).toEqual({
      kind: "run",
      network: "inherit",
    });
  });

  it("enforce-or-fail-closed with no backend fails closed", () => {
    expect(resolveStepNetwork(NONE_LIMITS, "enforce-or-fail-closed", false)).toEqual({
      kind: "fail-closed",
    });
  });
});

describe("runVerification — network enforcement modes", () => {
  it('default mode DENIES a network:"none" step before spawn when no backend is available', async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const report = await runVerification(
      planOf([targetedStep(NONE_LIMITS)], ws.info.root),
      depsWith(ws, rec.fn),
    );
    expect(report.results[0]?.status).toBe("denied");
    expect(report.results[0]?.detail).toContain("no enforcing sandbox backend");
    expect(rec.calls()).toHaveLength(0);
    expect(report.overallStatus).toBe("failed");
  });

  it('default mode requests an enforced network:"none" run when a backend is attested', async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "ok\n", exitCode: 0 });
    const report = await runVerification(
      planOf([targetedStep(NONE_LIMITS)], ws.info.root),
      depsWith(ws, rec.fn, {
        enforcedNetworkAvailable: true,
        sandboxAvailability: BUBBLEWRAP_BACKEND,
        platform: "linux",
        resolveExecutable: ABS_RESOLVER,
      }),
    );
    expect(report.results[0]?.status).toBe("passed");
    expect(rec.calls()).toHaveLength(1);
    expect(rec.calls()[0]?.command).toBe("/abs/bwrap");
    expect(rec.calls()[0]?.args).toContain("--unshare-net");
    const network = report.results[0]?.appliedLimits.find((l) => l.dimension === "network");
    expect(network?.enforced).toBe(true);
  });

  it("enforce-or-degrade with no backend runs under inherit (honest enforced:false)", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "ok\n", exitCode: 0 });
    const report = await runVerification(
      planOf([targetedStep(NONE_LIMITS)], ws.info.root),
      depsWith(ws, rec.fn, {
        networkEnforcement: "enforce-or-degrade",
        enforcedNetworkAvailable: false,
      }),
    );
    expect(report.results[0]?.status).toBe("passed");
    expect(rec.calls()).toHaveLength(1);
    const network = report.results[0]?.appliedLimits.find((l) => l.dimension === "network");
    expect(network?.enforced).toBe(false);
  });

  it("enforce-or-fail-closed with no backend DENIES before spawning untrusted code", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const report = await runVerification(
      planOf([targetedStep(NONE_LIMITS)], ws.info.root),
      depsWith(ws, rec.fn, {
        networkEnforcement: "enforce-or-fail-closed",
        enforcedNetworkAvailable: false,
      }),
    );
    expect(report.results[0]?.status).toBe("denied");
    expect(report.results[0]?.detail).toContain("no enforcing sandbox backend");
    expect(rec.calls()).toHaveLength(0);
    expect(report.overallStatus).toBe("failed");
  });

  it("a non-none step is never failed-closed even in fail-closed mode", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "ok\n", exitCode: 0 });
    const report = await runVerification(
      planOf([targetedStep(INHERIT_LIMITS)], ws.info.root),
      depsWith(ws, rec.fn, {
        networkEnforcement: "enforce-or-fail-closed",
        enforcedNetworkAvailable: false,
      }),
    );
    expect(report.results[0]?.status).toBe("passed");
    expect(rec.calls()).toHaveLength(1);
  });
});
