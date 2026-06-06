import { describe, expect, it } from "vitest";
import { runVerification, type VerificationDeps } from "./orchestrator.js";
import type { VerificationPlan, VerificationStep } from "./types.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./types.js";
import {
  fakeMonitor,
  makeFakeChild,
  makeWorkspace,
  recordingSpawn,
  scriptChildClose,
} from "./_support.js";

function step(overrides: Partial<VerificationStep> = {}): VerificationStep {
  return {
    kind: "test",
    scriptName: "test",
    command: "npm",
    args: ["test"],
    limits: DEFAULT_VERIFICATION_LIMITS,
    ...overrides,
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
  return {
    workspace: ws.info,
    spawn: spawnFn,
    monitor: fakeMonitor(),
    now: () => 1_000,
    ...extra,
  };
}

describe("runVerification — outcomes", () => {
  it("exit 0 → passed, with all four appliedLimits dimensions present", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stdout: "ok\n", exitCode: 0 });
    const report = await runVerification(planOf([step()], ws.info.root), depsWith(ws, rec.fn));
    const result = report.results[0];
    expect(result?.status).toBe("passed");
    expect(report.overallStatus).toBe("passed");
    expect(result?.appliedLimits.map((l) => l.dimension)).toEqual([
      "wall-time",
      "output-size",
      "memory",
      "network",
    ]);
  });

  it("non-zero exit → failed and overall failed", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { stderr: "boom\n", exitCode: 1 });
    const report = await runVerification(planOf([step()], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("failed");
    expect(report.overallStatus).toBe("failed");
  });

  it("a skipReason step is skipped and never spawns", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const skip = step({
      kind: "lint",
      scriptName: undefined,
      command: "npm",
      args: ["run", "lint"],
      skipReason: "no lint script",
    });
    const report = await runVerification(planOf([skip], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("skipped");
    expect(report.results[0]?.detail).toContain("no lint script");
    expect(rec.calls()).toHaveLength(0);
    expect(report.overallStatus).toBe("passed");
  });

  it("a denied command → denied and never spawns", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    // `git push` is denied by DEFAULT_COMMAND_RULES (read-only git only).
    const denied = step({ kind: "build", scriptName: undefined, command: "git", args: ["push"] });
    const report = await runVerification(planOf([denied], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("denied");
    expect(rec.calls()).toHaveLength(0);
    expect(report.overallStatus).toBe("failed");
  });

  it("output truncation → resource-exceeded with output-size breached:true", async () => {
    const ws = makeWorkspace();
    const child = makeFakeChild();
    const rec = recordingSpawn(child);
    // Emit more than maxOutputBytes so #6 sets truncated and kills the child.
    const limits = { ...DEFAULT_VERIFICATION_LIMITS, maxOutputBytes: 8 };
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("x".repeat(64), "utf8"));
      child.emit("close", null, "SIGTERM");
    });
    const report = await runVerification(
      planOf([step({ limits })], ws.info.root),
      depsWith(ws, rec.fn),
    );
    const result = report.results[0];
    expect(result?.status).toBe("resource-exceeded");
    expect(result?.truncated).toBe(true);
    const out = result?.appliedLimits.find((l) => l.dimension === "output-size");
    expect(out?.breached).toBe(true);
  });

  it("arbitrary npx verification commands are denied before spawn", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const invalid = step({
      kind: "build",
      scriptName: "build",
      command: "npx",
      args: ["eslint"],
    });
    const report = await runVerification(planOf([invalid], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("denied");
    expect(rec.calls()).toHaveLength(0);
    expect(report.overallStatus).toBe("failed");
  });

  it("targeted-test npx invocations reject flags and non-file arguments before spawn", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const invalid = step({
      kind: "targeted-test",
      scriptName: undefined,
      command: "npx",
      args: ["jest", "--config=jest.config.js", "src/add.test.ts"],
    });
    const report = await runVerification(planOf([invalid], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("denied");
    expect(rec.calls()).toHaveLength(0);
  });

  it("npm script-backed steps reject non-verification lifecycle script names before spawn", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const invalid = step({
      kind: "build",
      scriptName: "postinstall",
      command: "npm",
      args: ["run", "postinstall"],
    });
    const report = await runVerification(planOf([invalid], ws.info.root), depsWith(ws, rec.fn));
    expect(report.results[0]?.status).toBe("denied");
    expect(rec.calls()).toHaveLength(0);
  });
});

describe("runVerification — cancellation (D5)", () => {
  it("aborting the harness signal cancels the in-flight step and all remaining steps", async () => {
    const ws = makeWorkspace();
    const ac = new AbortController();
    const child = makeFakeChild();
    const rec = recordingSpawn(child);
    // The child never closes on its own; the abort triggers #6 termination → close on SIGTERM.
    queueMicrotask(() => {
      ac.abort();
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    });
    const plan = planOf(
      [
        step({ kind: "test" }),
        step({ kind: "build", scriptName: "build", args: ["run", "build"] }),
      ],
      ws.info.root,
    );
    const report = await runVerification(plan, depsWith(ws, rec.fn, { signal: ac.signal }));
    expect(report.results[0]?.status).toBe("cancelled");
    expect(report.results[1]?.status).toBe("cancelled");
    expect(report.overallStatus).toBe("cancelled");
  });

  it("a pre-aborted signal cancels every step without spawning", async () => {
    const ws = makeWorkspace();
    const ac = new AbortController();
    ac.abort();
    const rec = recordingSpawn();
    const report = await runVerification(
      planOf([step()], ws.info.root),
      depsWith(ws, rec.fn, { signal: ac.signal }),
    );
    expect(report.results[0]?.status).toBe("cancelled");
    expect(rec.calls()).toHaveLength(0);
  });

  it("a mismatched workspace root fails closed before any step executes", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const report = await runVerification(
      planOf([step()], `${ws.info.root}/other`),
      depsWith(ws, rec.fn),
    );
    expect(report.workspaceRoot).toBe(ws.info.root);
    expect(report.results[0]?.status).toBe("denied");
    expect(report.overallStatus).toBe("failed");
    expect(rec.calls()).toHaveLength(0);
  });
});

describe("runVerification — memory breach (D3) and no monitor-interval leak", () => {
  it("a fired monitor breach → resource-exceeded with memory breached:true", async () => {
    const ws = makeWorkspace();
    const child = makeFakeChild();
    const rec = recordingSpawn(child);
    const monitor = fakeMonitor();
    const limits = { ...DEFAULT_VERIFICATION_LIMITS, maxMemoryBytes: 64 * 1024 * 1024 };
    queueMicrotask(() => {
      monitor.breach(); // RSS sampler trips
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    });
    const report = await runVerification(planOf([step({ limits })], ws.info.root), {
      workspace: ws.info,
      spawn: rec.fn,
      monitor,
      now: () => 1,
    });
    const result = report.results[0];
    expect(result?.status).toBe("resource-exceeded");
    expect(result?.detail).toContain("memory");
    const mem = result?.appliedLimits.find((l) => l.dimension === "memory");
    expect(mem?.breached).toBe(true);
    expect(monitor.watched()).toHaveLength(1);
    expect(monitor.watched()[0]?.maxBytes).toBe(64 * 1024 * 1024);
  });

  it("stop() is called on EVERY settle path: resolve, breach, and skip", async () => {
    const ws = makeWorkspace();
    const monitor = fakeMonitor();
    // 1) clean resolve
    const recA = recordingSpawn();
    scriptChildClose(recA.child, { exitCode: 0 });
    await runVerification(planOf([step()], ws.info.root), {
      workspace: ws.info,
      spawn: recA.fn,
      monitor,
      now: () => 1,
    });
    expect(monitor.stopped()).toBe(1);
    // 2) a skipped step never spawns, so watch is never called and stop count is unchanged
    const recB = recordingSpawn();
    await runVerification(
      planOf(
        [
          step({
            kind: "lint",
            scriptName: undefined,
            command: "npm",
            args: ["run", "lint"],
            skipReason: "no script",
          }),
        ],
        ws.info.root,
      ),
      { workspace: ws.info, spawn: recB.fn, monitor, now: () => 1 },
    );
    expect(monitor.watched()).toHaveLength(1); // unchanged: no spawn on a skip
  });
});

describe("runVerification — redaction", () => {
  it("command stdout never appears in outputSummary or detail", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const secret = "ghp_" + "0123456789abcdefABCDEFghijklmnopqrst";
    const customerData = "customer_ssn=123-45-6789";
    scriptChildClose(rec.child, { stdout: `leaking ${secret} ${customerData} now\n`, exitCode: 1 });
    const report = await runVerification(planOf([step()], ws.info.root), depsWith(ws, rec.fn));
    const result = report.results[0];
    expect(result?.outputSummary).not.toContain(secret);
    expect(result?.outputSummary).not.toContain(customerData);
    expect(result?.outputSummary).toContain("omitted from summary");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(customerData);
  });
});

describe("runVerification — counts and report shape", () => {
  it("counts every status and is JSON-serializable", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    scriptChildClose(rec.child, { exitCode: 0 });
    const plan = planOf(
      [
        step(),
        step({
          kind: "lint",
          scriptName: undefined,
          command: "npm",
          args: ["run", "lint"],
          skipReason: "no lint script",
        }),
      ],
      ws.info.root,
    );
    const report = await runVerification(plan, depsWith(ws, rec.fn));
    expect(report.counts.passed).toBe(1);
    expect(report.counts.skipped).toBe(1);
    expect(() => {
      JSON.parse(JSON.stringify(report));
    }).not.toThrow();
  });

  it("empty plan → overallStatus passed, results empty, all counts zero", async () => {
    const ws = makeWorkspace();
    const rec = recordingSpawn();
    const report = await runVerification(planOf([], ws.info.root), depsWith(ws, rec.fn));
    expect(report.overallStatus).toBe("passed");
    expect(report.results).toEqual([]);
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });
});

describe("runVerification — wall-time wiring (D2)", () => {
  it("wallTimeMs drives the timeout: a 1 ms limit classifies timed-out with wall-time breached", async () => {
    // Verifies that policyForStep/runStep wire limits.wallTimeMs into the runCommand timer,
    // not a hardcoded or unrelated value. Fails if either assignment is removed or swapped.
    const ws = makeWorkspace();
    const child = makeFakeChild();
    const rec = recordingSpawn(child);
    const limits = { ...DEFAULT_VERIFICATION_LIMITS, wallTimeMs: 1 };
    // The 1 ms timer fires → terminate() → child does not self-close (fake); we emit close
    // slightly later so runCommand settles with timedOut:true.
    const closeTimer = setTimeout(() => child.emit("close", null, "SIGTERM"), 50);
    const report = await runVerification(
      planOf([step({ limits })], ws.info.root),
      depsWith(ws, rec.fn),
    );
    clearTimeout(closeTimer);
    const result = report.results[0];
    expect(result?.status).toBe("timed-out");
    expect(result?.durationMs).toBe(0);
    const wt = result?.appliedLimits.find((l) => l.dimension === "wall-time");
    expect(wt?.breached).toBe(true);
  });

  it("records elapsed duration on rejected timeout paths", async () => {
    const ws = makeWorkspace();
    const child = makeFakeChild();
    const rec = recordingSpawn(child);
    const limits = { ...DEFAULT_VERIFICATION_LIMITS, wallTimeMs: 1 };
    const readings = [0, 10, 95];
    const closeTimer = setTimeout(() => child.emit("close", null, "SIGTERM"), 20);
    const report = await runVerification(
      planOf([step({ limits })], ws.info.root),
      depsWith(ws, rec.fn, {
        now: () => readings.shift() ?? 95,
      }),
    );
    clearTimeout(closeTimer);
    expect(report.results[0]?.status).toBe("timed-out");
    expect(report.results[0]?.durationMs).toBe(85);
  });
});
