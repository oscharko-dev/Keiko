import { describe, it, expect } from "vitest";
import {
  runDisposableAssuredPreFilter,
  type DisposableExecutionPorts,
} from "./disposableAssuredExecution.js";
import type { SandboxedCommand } from "./assuredGateRunner.js";

const REPORTS: Record<string, unknown> = {
  "coverage/baseline.json": {
    "src/widget.ts": { lines: { covered: 2 }, branches: { covered: 0 } },
  },
  "coverage/patched.json": { "src/widget.ts": { lines: { covered: 8 }, branches: { covered: 3 } } },
  "reports/mutation.json": {
    files: { "src/widget.ts": { mutants: [{ status: "Killed" }, { status: "Killed" }] } },
  },
};

function ports(overrides: Partial<DisposableExecutionPorts> = {}): {
  ports: DisposableExecutionPorts;
  trace: () => string[];
} {
  const trace: string[] = [];
  const cmd = (command: string): SandboxedCommand => ({ command, args: [] });
  const base: DisposableExecutionPorts = {
    enforced: true,
    makeRoot: () => {
      trace.push("makeRoot");
      return Promise.resolve("/tmp/root");
    },
    measureBaseline: () => {
      trace.push("measureBaseline");
      return Promise.resolve();
    },
    applyCandidate: () => {
      trace.push("applyCandidate");
      return Promise.resolve();
    },
    run: (_root, c) => {
      trace.push(`run:${c.command}`);
      return Promise.resolve({ exitCode: 0 });
    },
    readReport: (_root, rel) => REPORTS[rel],
    dispose: () => {
      trace.push("dispose");
      return Promise.resolve();
    },
    buildCommand: cmd("build"),
    testCommand: cmd("test"),
    coverageCommand: cmd("coverage"),
    mutationCommand: cmd("mutation"),
    baselineCoverageReportPath: "coverage/baseline.json",
    patchedCoverageReportPath: "coverage/patched.json",
    mutationReportPath: "reports/mutation.json",
    targetCoverageKeys: ["src/widget.ts"],
    ...overrides,
  };
  return { ports: base, trace: () => trace };
}

describe("runDisposableAssuredPreFilter", () => {
  it("fails closed without touching the filesystem when egress is not enforced", async () => {
    const { ports: p, trace } = ports({ enforced: false });
    const result = await runDisposableAssuredPreFilter(p);
    expect(result.assurance).toBe("unverified");
    expect(result.surfaced).toBe(false);
    expect(result.rejectionReason).toContain("not enforced");
    expect(trace()).toEqual([]); // no root created, no gates, no dispose
  });

  it("runs the lifecycle in order and surfaces an assured candidate, always disposing", async () => {
    const { ports: p, trace } = ports({});
    const result = await runDisposableAssuredPreFilter(p, {
      stabilityRuns: 2,
      minMutantsKilled: 1,
    });
    expect(result.assurance).toBe("assured");
    expect(result.surfaced).toBe(true);
    // baseline is measured before the candidate is applied; dispose runs last.
    expect(trace().slice(0, 3)).toEqual(["makeRoot", "measureBaseline", "applyCandidate"]);
    expect(trace().at(-1)).toBe("dispose");
    expect(result.funnel.coverageLineDelta).toBe(6);
  });

  it("disposes the root even when a gate throws", async () => {
    const { ports: p, trace } = ports({
      run: () => Promise.reject(new Error("toolchain blew up")),
    });
    await expect(runDisposableAssuredPreFilter(p)).rejects.toThrow("toolchain blew up");
    expect(trace()).toContain("dispose");
  });
});
