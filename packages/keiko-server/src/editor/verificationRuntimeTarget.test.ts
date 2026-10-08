import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectWorkspace } from "@oscharko-dev/keiko-workspace";
import * as verification from "@oscharko-dev/keiko-verification";
import * as tools from "@oscharko-dev/keiko-tools";
import { nodeSpawnFn } from "@oscharko-dev/keiko-tools/internal/exec";
import { planIsolatedRun } from "@oscharko-dev/keiko-sandbox";
import { resolveVerificationRuntimeTarget } from "./verificationRuntimeTarget.js";
import { createActivityLogSink, closeFileServerLogSinks } from "../observability/index.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { executeVerificationEnforced, probeNetworkIsolation } from "./verificationExecution.js";

const roots: string[] = [];
afterEach(() => {
  closeFileServerLogSinks();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("composes a selected-runtime resolver for automatic dependency installation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-target-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  const workspace = detectWorkspace(root);
  const empty = { workspaceRoot: root, steps: [] };
  const report = await verification.runVerification(empty, { workspace });
  const run = vi.spyOn(verification, "runVerification").mockResolvedValue(report);
  await executeVerificationEnforced({
    workspace,
    plan: empty,
    signal: new AbortController().signal,
    dependencyBootstrap: "auto",
    activityLog: { write: (): void => undefined },
  });
  expect(run).toHaveBeenCalledOnce();
  expect(Reflect.get(run.mock.calls[0]?.[1] ?? {}, "resolveDependencyInstallTarget")).toBeTypeOf(
    "function",
  );
});

function fixture(): ReturnType<typeof detectWorkspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-metadata-")));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  return detectWorkspace(root);
}

function loggedSink(): ReturnType<typeof createBufferedServerLogSink> & {
  readonly stateRoot: string;
} {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-target-log-")));
  roots.push(stateRoot);
  const buffered = createBufferedServerLogSink();
  const persisted = createActivityLogSink(stateRoot);
  return {
    stateRoot,
    ...buffered,
    write: (event): void => {
      buffered.write(event);
      persisted.write(event);
    },
  };
}
function persistedTarget(log: ReturnType<typeof loggedSink>): Record<string, unknown> {
  closeFileServerLogSinks();
  const lines = persistedActivityLogLines(
    readPersistedActivityLog(log.stateRoot),
    "editor.verification.workspace",
  );
  const line = lines.find((value) => {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Reflect.get(parsed, "state") === "runtime-target"
    );
  });
  return expectActivityLogProof("editor.verification.workspace.emitted-line", line ?? "");
}

function metadata(): Record<string, string> {
  return {
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    nodeVersion: "v24.18.0",
    nodeAbi: "137",
    napiVersion: "10",
  };
}

function result(workspace: ReturnType<typeof detectWorkspace>): tools.CommandResult {
  const planned = planIsolatedRun(
    {
      command: "node",
      args: [],
      cwd: workspace.root,
      network: "none",
      filesystem: "execution-root",
    },
    { bubblewrap: false, unshare: false, seatbelt: false, docker: true, podman: false },
    "darwin",
  );
  return {
    command: "node",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(metadata()) + "\n",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    attestation: planned.attestation,
  };
}

function requiredAttestation(
  result: tools.CommandResult,
): NonNullable<tools.CommandResult["attestation"]> {
  if (result.attestation === undefined) throw new TypeError("Missing producer attestation");
  return result.attestation;
}

it("binds the child metadata and actual selected backend without assuming host CPU", async () => {
  const workspace = fixture();
  const observed = result(workspace);
  const run = vi.spyOn(tools, "runCommand").mockResolvedValue(observed);
  const target = await resolveVerificationRuntimeTarget({
    workspace,
    signal: new AbortController().signal,
  });
  expect(target).toMatchObject(JSON.parse(observed.stdout) as Record<string, unknown>);
  expect(target.runtimeIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(Object.isFrozen(target)).toBe(true);
  const [input, deps] = run.mock.calls[0] ?? [];
  expect(input).toMatchObject({ command: "node", cwd: undefined, timeoutMs: 15_000 });
  expect(input?.args).toHaveLength(2);
  expect(input?.args[0]).toBe("-e");
  expect(deps?.policy).toMatchObject({
    network: "none",
    filesystem: "execution-root",
    maxOutputBytes: 1_024,
  });
  expect(deps?.spawn).toBe(nodeSpawnFn);
  expect(deps?.commandRules[0]?.allowedSubcommands).toEqual([input?.args[1]]);
});

it("changes identity when the measured runtime or effective backend changes", async () => {
  const workspace = fixture();
  const observed = result(workspace);
  const run = vi.spyOn(tools, "runCommand").mockResolvedValue(observed);
  const input = { workspace, signal: new AbortController().signal };
  const first = await resolveVerificationRuntimeTarget(input);
  run.mockResolvedValue({ ...observed, stdout: JSON.stringify({ ...metadata(), nodeAbi: "138" }) });
  const changed = await resolveVerificationRuntimeTarget(input);
  expect(changed.runtimeIdentitySha256).not.toBe(first.runtimeIdentitySha256);
  run.mockResolvedValue({
    ...observed,
    attestation: { ...requiredAttestation(observed), backend: "container-podman" },
  });
  expect((await resolveVerificationRuntimeTarget(input)).runtimeIdentitySha256).not.toBe(
    first.runtimeIdentitySha256,
  );
});

it.each([
  { exitCode: 1 },
  { signal: "SIGTERM" },
  { timedOut: true },
  { truncated: true },
  { outputRedacted: true as const },
  { stderr: "PRIVATE_STDERR" },
  { stdout: "x".repeat(1_025) },
  { attestation: undefined },
])("refuses unusable command output before target delivery: %j", async (change) => {
  const workspace = fixture();
  vi.spyOn(tools, "runCommand").mockResolvedValue({ ...result(workspace), ...change });
  await expect(
    resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal }),
  ).rejects.toThrow("VERIFICATION_RUNTIME_TARGET_UNAVAILABLE");
});

it.each(["networkEnforced", "filesystemEnforced"] as const)(
  "requires actual %s attestation",
  async (field) => {
    const workspace = fixture();
    const observed = result(workspace);
    vi.spyOn(tools, "runCommand").mockResolvedValue({
      ...observed,
      attestation: { ...requiredAttestation(observed), [field]: false },
    });
    await expect(
      resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal }),
    ).rejects.toThrow("VERIFICATION_RUNTIME_TARGET_UNAVAILABLE");
  },
);

it.each([
  { os: "freebsd" },
  { cpu: "unknown" },
  { libc: "unknown" },
  { os: "darwin" },
  { nodeVersion: "PRIVATE_VERSION" },
  { nodeAbi: "1e2" },
  { napiVersion: "" },
  { extra: "PRIVATE_EXTRA" },
])("rejects unsupported or extra metadata: %j", async (change) => {
  const workspace = fixture();
  vi.spyOn(tools, "runCommand").mockResolvedValue({
    ...result(workspace),
    stdout: JSON.stringify({ ...metadata(), ...change }),
  });
  await expect(
    resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal }),
  ).rejects.toThrow("VERIFICATION_RUNTIME_TARGET_INVALID");
});

it("logs only measured target digest within actual held workspace admission", async () => {
  const workspace = fixture();
  const observed = result(workspace);
  vi.spyOn(tools, "runCommand").mockResolvedValue(observed);
  const empty = { workspaceRoot: workspace.root, steps: [] };
  const report = await verification.runVerification(empty, { workspace });
  vi.spyOn(verification, "runVerification").mockImplementation(async (_plan, deps) => {
    await deps.resolveDependencyInstallTarget?.();
    return report;
  });
  const log = loggedSink();
  await executeVerificationEnforced({
    workspace,
    plan: empty,
    signal: new AbortController().signal,
    dependencyBootstrap: "auto",
    activityLog: log,
    correlationId: "corr-runtime-target",
  });
  expect(log.events.map((event) => event.extra?.state)).toEqual([
    "waiting",
    "acquired",
    "runtime-target",
    "released",
  ]);
  expect(log.events[2]?.extra?.runtimeTargetOutcome).toBe("measured");
  expect(log.events[2]?.extra?.runtimeIdentityDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(persistedTarget(log)).toMatchObject({
    state: "runtime-target",
    runtimeTargetOutcome: "measured",
    runtimeIdentityDigest: log.events[2]?.extra?.runtimeIdentityDigest,
  });
  expect(readPersistedActivityLog(log.stateRoot)).not.toContain(observed.stdout.trim());
});

it("measures the real selected isolated Node runtime through the original command owner", async () => {
  const workspace = fixture();
  const original = tools.runCommand;
  const observed: tools.CommandResult[] = [];
  const spawns = vi.fn(nodeSpawnFn);
  vi.spyOn(tools, "runCommand").mockImplementation(async (input, deps) => {
    const output = await original(input, { ...deps, spawn: spawns });
    observed.push(output);
    return output;
  });
  const probe = probeNetworkIsolation(workspace.root);
  const pending = resolveVerificationRuntimeTarget({
    workspace,
    signal: new AbortController().signal,
  });
  if (!probe.available) {
    await expect(pending).rejects.toBeInstanceOf(tools.CommandDeniedError);
    expect(spawns).not.toHaveBeenCalled();
    expect(observed).toHaveLength(0);
    return;
  }
  const target = await pending;
  expect(spawns).toHaveBeenCalledOnce();
  expect(observed).toHaveLength(1);
  const output = observed[0];
  if (output === undefined) throw new TypeError("Missing actual command output");
  expect(target).toMatchObject(JSON.parse(output.stdout) as Record<string, unknown>);
  expect(output.attestation).toMatchObject({ networkEnforced: true, filesystemEnforced: true });
  expect(output.exitCode).toBe(0);
  expect(output.truncated).toBe(false);
}, 20_000);

it("preserves accepted cancellation after the bounded command settles", async () => {
  const workspace = fixture();
  const controller = new AbortController();
  vi.spyOn(tools, "runCommand").mockImplementation(() => {
    controller.abort();
    return Promise.resolve(result(workspace));
  });
  await expect(
    resolveVerificationRuntimeTarget({ workspace, signal: controller.signal }),
  ).rejects.toBeInstanceOf(tools.CommandCancelledError);
});

it.each(["off", "no-dependencies"] as const)(
  "keeps canonical %s plans probe-free",
  async (kind) => {
    const workspace = fixture();
    writeFileSync(
      join(workspace.root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: { typecheck: "node -e 'process.exit(0)'" },
        ...(kind === "off" ? { devDependencies: { typescript: "^6.0.3" } } : {}),
      }),
    );
    const scripts = verification.detectScripts(workspace);
    const plan = verification.buildVerificationPlan(workspace, scripts, { only: ["typecheck"] });
    const run = vi.spyOn(tools, "runCommand").mockResolvedValue(result(workspace));
    const log = loggedSink();
    await executeVerificationEnforced({
      workspace,
      plan,
      signal: new AbortController().signal,
      dependencyBootstrap: kind === "off" ? "off" : "auto",
      activityLog: log,
    });
    expect(run.mock.calls.every(([input]) => input.command !== "node")).toBe(true);
    expect(log.events.some((event) => event.extra?.state === "runtime-target")).toBe(false);
  },
);

it("returns the original failed bootstrap report and one diagnostic when the actual probe refuses", async () => {
  const workspace = fixture();
  writeFileSync(
    join(workspace.root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { typecheck: "node -e 'process.exit(0)'" },
      devDependencies: { typescript: "^6.0.3" },
    }),
  );
  const plan = verification.buildVerificationPlan(
    workspace,
    verification.detectScripts(workspace),
    { only: ["typecheck"] },
  );
  const run = vi
    .spyOn(tools, "runCommand")
    .mockResolvedValue({ ...result(workspace), exitCode: 1, stderr: "PRIVATE_CHILD_FAILURE" });
  const log = loggedSink();
  const diagnostic = vi.fn();
  const { report } = await executeVerificationEnforced({
    workspace,
    plan,
    signal: new AbortController().signal,
    dependencyBootstrap: "auto",
    activityLog: log,
    diagnostics: { record: diagnostic },
    correlationId: "runtime-target-refused",
  });
  expect(report.overallStatus).toBe("failed");
  expect(report.dependencies?.state).toBe("failed");
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0].command).toBe("node");
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({
    source: "verification.dependency-bootstrap.target-probe",
  });
  expect(log.events.find((event) => event.extra?.state === "runtime-target")?.extra).toMatchObject({
    runtimeTargetOutcome: "refused",
  });
  expect(persistedTarget(log)).toMatchObject({
    state: "runtime-target",
    runtimeTargetOutcome: "refused",
    correlationId: "runtime-target-refused",
  });
  expect(JSON.stringify([report, log.events, diagnostic.mock.calls])).not.toContain(
    "PRIVATE_CHILD_FAILURE",
  );
});
