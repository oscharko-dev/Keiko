import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeSupervisorBuild } from "../build-runtime-supervisor.mjs";

const monitor = resolve("native/runtime-supervisor/macos/system-extension/keiko_runtime_monitor.m");
const protocol = resolve("native/runtime-supervisor/macos/keiko_runtime_monitor_protocol.h");

async function compileFixture(root) {
  const invocations = [];
  const target = process.arch === "arm64" ? "macos-arm64" : "macos-x64";
  const status = await runRuntimeSupervisorBuild({
    argv: ["node", "build", target, join(root, "a/b/c/d/runtime-supervisor")],
    spawnSyncImpl: (compiler, args) => {
      invocations.push({ compiler, args });
      return { status: 0 };
    },
  });
  expect(status).toBe(0);
  const invocation = invocations.find((entry) => entry.args.at(-1) === monitor);
  if (invocation === undefined) throw new Error("Missing production monitor compiler plan");
  const source = join(root, "fixture.m");
  const executable = join(root, "fixture");
  copyFileSync(resolve("tests/fixtures/runtime-monitor-event-stream.m"), source);
  copyFileSync(protocol, join(root, "protocol.h"));
  const args = [...invocation.args];
  args[args.indexOf("-o") + 1] = executable;
  args[args.length - 1] = source;
  args.push(`-DKEIKO_MONITOR_SOURCE=${JSON.stringify(monitor)}`);
  const compiled = spawnSync(invocation.compiler, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
  });
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stderr).toBe(0);
  return executable;
}

describe.skipIf(process.platform !== "darwin")("actual macOS monitor observation integrity", () => {
  let root;
  let executable;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "keiko-monitor-events-"));
    executable = await compileFixture(root);
  }, 35_000);
  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    "healthy",
    "healthy-v4-zero-origin",
    "gap",
    "duplicate",
    "backward",
    "unsupported-version",
    "overflow",
    "no-baseline",
    "startup-failure",
    "pending-stop",
    "pending-disconnect",
    "no-root-disconnect",
    "no-root-exited",
    "pending-owner-exit",
    "no-root-capacity",
    "recycled-stop",
    "late-recycled-fork",
    "process-limit",
    "supervisor-reuse",
    "exec-transition",
    "exec-before-stop",
    "signal-refusal",
    "kernel-token-signal",
    "peer-unavailable",
    "peer-short-token",
    "peer-wrong-pid",
    "peer-wrong-uid",
    "late-signal-refusal",
    "wrong-exec-identity",
    "overlapping-owner",
    "pending-exec-owner",
  ])("preserves zero-proof authority for %s", (scenario) => {
    const result = spawnSync(executable, [scenario], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      case: scenario,
      passed: 1,
      signalCalls: 0,
      wrongGenerationSignals: 0,
    });
    expect(result.stderr).toBe("");
  });
});
