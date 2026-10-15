import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GROUNDED_WORKSPACE_PATTERN_TEST,
  GROUNDED_WORKSPACE_PATTERN_PROCESS_TIMEOUT_MS,
  controlledVitestInvocation,
  resolveInstalledVitestEntry,
  runGroundedWorkspacePatternPerformance,
} from "../check-grounded-workspace-pattern-performance.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const targetSource = readFileSync(resolve(repoRoot, GROUNDED_WORKSPACE_PATTERN_TEST), "utf8");
const lineTest = "packages/keiko-server/src/grounded-symbol-line.public-handler.test.ts";
const lineSource = readFileSync(resolve(repoRoot, lineTest), "utf8");
const localGateSource = readFileSync(resolve(repoRoot, "docker/gates/run-gates.sh"), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("grounded workspace-pattern performance command", () => {
  it("binds a standalone npm command that builds packages before running the focused pin", () => {
    expect(manifest.scripts?.["check:grounded-workspace-pattern-performance"]).toBe(
      "npm run build:packages && node scripts/check-grounded-workspace-pattern-performance.mjs",
    );
  });

  it("wires the focused pin exactly once into the local fast container suite", () => {
    const invocationLine =
      'step "grounded workspace-pattern performance" node ' +
      "scripts/check-grounded-workspace-pattern-performance.mjs";
    const wiringLines = localGateSource.split("\n").filter((line) => line === invocationLine);
    const invocationIndex = localGateSource.indexOf(`\n${invocationLine}\n`);
    const nonFastSuiteBoundary = localGateSource.indexOf('if [[ "$suite" != "fast" ]]');

    expect(wiringLines).toEqual([invocationLine]);
    expect(invocationIndex).toBeGreaterThan(0);
    expect(invocationIndex).toBeLessThan(nonFastSuiteBoundary);
  });

  it("uses Node directly and opts only the focused spec into wall-clock enforcement", () => {
    const invocation = controlledVitestInvocation("/installed/vitest.mjs", { SENTINEL: "kept" });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      "/installed/vitest.mjs",
      "run",
      GROUNDED_WORKSPACE_PATTERN_TEST,
    ]);
    expect(invocation.options).toMatchObject({
      cwd: repoRoot,
      env: { SENTINEL: "kept", KEIKO_ENFORCE_WALL_CLOCK_BUDGETS: "1" },
      stdio: "inherit",
      timeout: GROUNDED_WORKSPACE_PATTERN_PROCESS_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    expect(invocation.options).not.toHaveProperty("shell");
  });

  it("fails closed when the focused process times out or is terminated", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => "/installed/vitest.mjs",
        execute: () => ({
          status: null,
          signal: "SIGTERM",
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        }),
        environment: {},
      }),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("keeps the focused 1000 ms assertion behind the controlled environment switch", () => {
    expect(targetSource).toContain(
      'it.skipIf(process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS !== "1")',
    );
    expect(targetSource).toContain("repeat(320_000)");
    expect(targetSource).toContain("toBeLessThan(1000)");
    expect(resolveInstalledVitestEntry()).toMatch(/vitest\.mjs$/u);
  });

  it("always runs the physical-line scenario after the pattern pin with coverage enabled", () => {
    const execute = vi.fn(() => ({ status: 0 }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => "/installed/vitest.mjs",
        execute,
        environment: { SENTINEL: "kept", KEIKO_ENFORCE_WALL_CLOCK_BUDGETS: "0" },
      }),
    ).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toEqual([
      "/installed/vitest.mjs",
      "run",
      "--config",
      "vitest.coverage.packages.config.ts",
      "--coverage",
      lineTest,
      "--coverage.reportsDirectory=coverage/grounded-line-performance",
    ]);
    expect(execute.mock.calls[1]?.[2].env).toEqual({
      SENTINEL: "kept",
      KEIKO_ENFORCE_WALL_CLOCK_BUDGETS: "1",
    });
    expect(execute.mock.calls[1]?.[2]).toMatchObject({
      cwd: repoRoot,
      timeout: 90_000,
      killSignal: "SIGTERM",
      stdio: "inherit",
    });
    expect(execute.mock.calls[1]?.[2]).not.toHaveProperty("shell");
  });

  it.each([
    { status: 7, signal: null },
    { status: null, signal: "SIGTERM" },
  ])("fails closed on a failed or terminated physical-line child: $status", (failure) => {
    const execute = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce(failure);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => "/installed/vitest.mjs",
        execute,
        environment: {},
      }),
    ).toBe(failure.status ?? 1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps line content and work assertions unconditional while controlling only its 5s pin", () => {
    expect(lineSource).not.toMatch(/it\.(?:skip|skipIf|runIf)|describe\.(?:skip|skipIf|runIf)/u);
    expect(lineSource).toContain('if (process.env.KEIKO_ENFORCE_WALL_CLOCK_BUDGETS === "1")');
    expect(lineSource).toContain("expect(elapsed).toBeLessThan(5_000)");
    expect(lineSource).toContain("expect(prompt.includes(FACT)).toBe(true)");
    expect(lineSource).toContain("workspaceIoContentReadCalls");
    expect(lineSource).toContain("workspaceIoContentReadBytes");
  });

  it("propagates a focused Vitest failure without widening the target", () => {
    const execute = vi.fn(() => ({ status: 7 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => "/installed/vitest.mjs",
        execute,
        environment: {},
      }),
    ).toBe(7);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual([
      "/installed/vitest.mjs",
      "run",
      GROUNDED_WORKSPACE_PATTERN_TEST,
    ]);
    expect(error).toHaveBeenCalledOnce();
  });

  it("reports both an unavailable runner and a successful focused execution", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => {
          throw new Error("missing");
        },
      }),
    ).toBe(1);
    expect(
      runGroundedWorkspacePatternPerformance({
        resolveEntry: () => "/installed/vitest.mjs",
        execute: () => ({ status: 0 }),
        environment: {},
      }),
    ).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });
});
