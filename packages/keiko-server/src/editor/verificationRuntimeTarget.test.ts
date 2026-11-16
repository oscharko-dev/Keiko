import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SANDBOX_BACKENDS } from "@oscharko-dev/keiko-contracts/runtime/tools";
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
  vi.unstubAllEnvs();
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

const probeBackends: ReadonlySet<string> = new Set(SANDBOX_BACKENDS);
const probeStderrPatterns = [
  [
    /image operating system [^\r\n]+ cannot be used on this platform|no matching manifest for/iu,
    "image-platform-mismatch",
  ],
  [/manifest unknown|pull access denied for/iu, "image-unavailable"],
  [/invalid mount config for type|invalid volume specification|mounts denied:/iu, "mount-refused"],
  [/invalid option: Windows does not support/iu, "engine-option-unsupported"],
  [/cannot connect to the Docker daemon|error during connect:/iu, "daemon-connection-failed"],
  [/unable to find image [^\r\n]+ locally/iu, "image-not-cached"],
] as const;

// A diagnostic hint from known CLI wording, never a capability or admission decision. The closed
// label is all that leaves this function; unknown text remains "other" with only its byte/hash proof.
function closedProbeStderr(stderr: string): string {
  if (stderr.length === 0) return "empty";
  return probeStderrPatterns.find(([pattern]) => pattern.test(stderr))?.[1] ?? "other";
}

function closedProbeResult(
  output: tools.CommandResult | undefined,
): Record<string, unknown> | null {
  if (output === undefined) return null;
  const backend = output.attestation?.backend;
  return {
    backend: backend !== undefined && probeBackends.has(backend) ? backend : "unknown",
    exitCode: output.exitCode,
    signalPresent: output.signal !== null,
    timedOut: output.timedOut,
    truncated: output.truncated,
    outputRedacted: output.outputRedacted === true,
    networkEnforced: output.attestation?.networkEnforced === true,
    filesystemEnforced: output.attestation?.filesystemEnforced === true,
    stdoutBytes: Buffer.byteLength(output.stdout),
    stdoutSha256: createHash("sha256").update(output.stdout).digest("hex"),
    stderrClass: closedProbeStderr(output.stderr),
    stderrBytes: Buffer.byteLength(output.stderr),
    stderrSha256: createHash("sha256").update(output.stderr).digest("hex"),
  };
}

// Preserve the real command and all admission assertions. A failed live probe must identify which
// closed output guard refused it without printing command arguments, paths, environment or bodies.
async function resolveObservedRuntimeTarget(
  input: Parameters<typeof resolveVerificationRuntimeTarget>[0],
  observed: readonly tools.CommandResult[],
): ReturnType<typeof resolveVerificationRuntimeTarget> {
  try {
    return await resolveVerificationRuntimeTarget(input);
  } catch (error) {
    if (
      !(error instanceof TypeError) ||
      error.message !== "VERIFICATION_RUNTIME_TARGET_UNAVAILABLE"
    )
      throw error;
  }
  // Only the exact closed refusal reaches this boundary. Do not carry a foreign cause into CI logs.
  throw new TypeError(
    `VERIFICATION_RUNTIME_TARGET_UNAVAILABLE ${JSON.stringify({
      resultCount: observed.length,
      lastResult: closedProbeResult(observed.at(-1)),
    })}`,
  );
}

it("reports a refused real probe through closed metadata without command or output bodies", async () => {
  const workspace = fixture();
  const privateValue = "PRIVATE_PROBE_CONTENT";
  const output: tools.CommandResult = {
    ...result(workspace),
    command: privateValue,
    args: [privateValue],
    exitCode: 125,
    signal: privateValue,
    stdout: privateValue,
    stderr: privateValue,
    timedOut: true,
    truncated: true,
    outputRedacted: true,
    attestation: { ...requiredAttestation(result(workspace)), platform: privateValue },
  };
  vi.spyOn(tools, "runCommand").mockResolvedValue(output);
  const pending = resolveObservedRuntimeTarget(
    { workspace, signal: new AbortController().signal },
    [output],
  );
  const digest = createHash("sha256").update(privateValue).digest("hex");
  await expect(pending).rejects.toMatchObject({
    message: `VERIFICATION_RUNTIME_TARGET_UNAVAILABLE ${JSON.stringify({
      resultCount: 1,
      lastResult: {
        backend: "container-docker",
        exitCode: 125,
        signalPresent: true,
        timedOut: true,
        truncated: true,
        outputRedacted: true,
        networkEnforced: true,
        filesystemEnforced: true,
        stdoutBytes: Buffer.byteLength(privateValue),
        stdoutSha256: digest,
        stderrClass: "other",
        stderrBytes: Buffer.byteLength(privateValue),
        stderrSha256: digest,
      },
    })}`,
  });
  await expect(pending).rejects.not.toHaveProperty("cause");
  await expect(pending).rejects.not.toHaveProperty("command");
  await expect(pending).rejects.toSatisfy(
    (error: Error) =>
      !error.message.includes(privateValue) && !error.message.includes(workspace.root),
  );
});

it.each([
  [
    "Unable to find image 'PRIVATE_PROBE_CONTENT' locally\nno matching manifest for windows(10.0.26100)/amd64 in the manifest list entries",
    "image-platform-mismatch",
  ],
  [
    "Unable to find image 'PRIVATE_PROBE_CONTENT' locally\npull access denied for PRIVATE_PROBE_CONTENT",
    "image-unavailable",
  ],
  ['image operating system "linux" cannot be used on this platform', "image-platform-mismatch"],
  [
    "no matching manifest for windows(10.0.26100)/amd64 in the manifest list entries",
    "image-platform-mismatch",
  ],
  ["manifest unknown: manifest unknown", "image-unavailable"],
  ["pull access denied for PRIVATE_PROBE_CONTENT", "image-unavailable"],
  ["Unable to find image 'PRIVATE_PROBE_CONTENT' locally", "image-not-cached"],
  ['invalid mount config for type "bind": PRIVATE_PROBE_CONTENT', "mount-refused"],
  ["invalid volume specification: PRIVATE_PROBE_CONTENT", "mount-refused"],
  ["Mounts denied: PRIVATE_PROBE_CONTENT", "mount-refused"],
  ["invalid option: Windows does not support PRIVATE_PROBE_CONTENT", "engine-option-unsupported"],
  ["Cannot connect to the Docker daemon at PRIVATE_PROBE_CONTENT", "daemon-connection-failed"],
  ["error during connect: PRIVATE_PROBE_CONTENT", "daemon-connection-failed"],
  ["PRIVATE_PROBE_CONTENT", "other"],
  ["", "empty"],
])("classifies probe stderr case %# without retaining its body", (stderr, stderrClass) => {
  const details = closedProbeResult({ ...result(fixture()), stderr });
  expect(details).toMatchObject({ stderrClass, stderrBytes: Buffer.byteLength(stderr) });
  expect(JSON.stringify(details)).not.toContain("PRIVATE_PROBE_CONTENT");
  expect(details).not.toHaveProperty("stderr");
});

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
  "",
  "PRIVATE_CHILD_FAILURE",
  '{"os":"PRIVATE_CHILD_FAILURE"',
  '{"os":}',
  JSON.stringify(metadata()) + "\nPRIVATE_CHILD_FAILURE",
])("classifies malformed probe JSON without retaining child output: %j", async (stdout) => {
  const workspace = fixture();
  vi.spyOn(tools, "runCommand").mockResolvedValue({ ...result(workspace), stdout });
  const pending = resolveVerificationRuntimeTarget({
    workspace,
    signal: new AbortController().signal,
  });
  await expect(pending).rejects.toBeInstanceOf(TypeError);
  await expect(pending).rejects.toMatchObject({
    message: "VERIFICATION_RUNTIME_TARGET_INVALID",
  });
  await expect(pending).rejects.not.toHaveProperty("cause");
});

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
  const pending = resolveObservedRuntimeTarget(
    { workspace, signal: new AbortController().signal },
    observed,
  );
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

it.each([{ exitCode: 1, stderr: "PRIVATE_CHILD_FAILURE" }, { stdout: "PRIVATE_CHILD_FAILURE" }])(
  "retains the original failed bootstrap report and one body-free diagnostic: %j",
  async (change) => {
    // Hermetic against the host's Docker state: a remote endpoint is refused as unsupported without
    // a diagnostic, so a stopped local engine cannot add an isolation-probe diagnostic (#4068).
    vi.stubEnv("DOCKER_HOST", "tcp://127.0.0.1:2375");
    vi.stubEnv("DOCKER_CONTEXT", "");
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
      .mockResolvedValue({ ...result(workspace), ...change });
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
    expect(
      log.events.find((event) => event.extra?.state === "runtime-target")?.extra,
    ).toMatchObject({
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
    expect(readPersistedActivityLog(log.stateRoot)).not.toContain("PRIVATE_CHILD_FAILURE");
  },
);

// The runtime-target probe may drop the "every non-allowlisted environment value" output scrub in
// favour of "credentials-only" because it runs one fixed, repository-independent metadata script of
// Node's own process data and its output is bounded to 1 KiB. A host that exports an ordinary value
// equal to part of the Node version (the official Node image exports NODE_VERSION=24.18.0) used to
// get the version back as "[REDACTED]" and the target refused as unavailable. These tests pin the
// narrowing and its limits.

it("launches only Node's fixed metadata script, with no repository path in the argument vector", async () => {
  const workspace = fixture();
  const run = vi.spyOn(tools, "runCommand").mockResolvedValue(result(workspace));
  await resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal });
  const [input, deps] = run.mock.calls[0] ?? [];
  // `node -e <constant source>` from the execution root: no script file, no module, no repository path.
  expect(input?.command).toBe("node");
  expect(input?.cwd).toBeUndefined();
  expect(input?.args).toHaveLength(2);
  expect(input?.args[0]).toBe("-e");
  const source = input?.args[1] ?? "";
  expect(source).toContain('require("node:process")');
  expect(source).not.toContain(workspace.root);
  expect(source).not.toMatch(/require\((?!"node:process")/u);
  expect(deps?.commandRules).toHaveLength(1);
  expect(deps?.commandRules[0]).toMatchObject({
    executable: "node",
    requiredLeadingFlags: ["-e"],
    allowedSubcommands: [source],
  });
});

it("narrows only this probe's output scrub to credentials", async () => {
  const workspace = fixture();
  const run = vi.spyOn(tools, "runCommand").mockResolvedValue(result(workspace));
  await resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal });
  expect(run.mock.calls[0]?.[1].policy.outputScrub).toBe("credentials-only");
  // Every other command keeps the fail-closed default: the shared default policy names no mode.
  expect(tools.DEFAULT_SANDBOX_POLICY.outputScrub).toBeUndefined();
});

// Substitutes the probe's script with one that prints a chosen metadata document, keeping the real
// command owner, scrub and attestation in the path.
function probeWith(nodeVersion: string | undefined): readonly tools.CommandResult[] {
  const original = tools.runCommand;
  const observed: tools.CommandResult[] = [];
  vi.spyOn(tools, "runCommand").mockImplementation(async (input, deps) => {
    const output = await original(input, {
      ...deps,
      spawn: (command, args, options) =>
        nodeSpawnFn(
          command,
          args.map((argument) =>
            nodeVersion !== undefined && argument.startsWith('const p = require("node:process")')
              ? `process.stdout.write(JSON.stringify({os:"linux",cpu:"x64",libc:"glibc",nodeVersion:${JSON.stringify(nodeVersion)},nodeAbi:"137",napiVersion:"10"}) + "\\n");`
              : argument,
          ),
          options,
        ),
    });
    observed.push(output);
    return output;
  });
  return observed;
}

it("resolves the real runtime when the parent environment exports NODE_VERSION", async () => {
  const workspace = fixture();
  if (!probeNetworkIsolation(workspace.root).available) return;
  const observed = probeWith(undefined);
  const input = {
    workspace,
    signal: new AbortController().signal,
  };
  // The isolated backend can use a different runtime from this host. Its actual fingerprint
  // must survive an ordinary environment value equal to its version, including in a container.
  const before = await resolveObservedRuntimeTarget(input, observed);
  vi.stubEnv("NODE_VERSION", before.nodeVersion.slice(1));
  expect(await resolveObservedRuntimeTarget(input, observed)).toEqual(before);
}, 20_000);

it("still scrubs a credential-named value and then refuses the target", async () => {
  const workspace = fixture();
  if (!probeNetworkIsolation(workspace.root).available) return;
  vi.stubEnv("RUNTIME_PROBE_API_TOKEN", "v24.18.0-credential-value");
  // A probe that echoes the credential as its version: the fail-closed behaviour for real secrets.
  probeWith("v24.18.0-credential-value");
  await expect(
    resolveVerificationRuntimeTarget({ workspace, signal: new AbortController().signal }),
  ).rejects.toThrow("VERIFICATION_RUNTIME_TARGET_UNAVAILABLE");
}, 20_000);

it("keeps scrubbing the same ordinary value for every other command under the default policy", async () => {
  const workspace = fixture();
  vi.stubEnv("NODE_VERSION", process.version.slice(1));
  const output = await tools.runCommand(
    {
      command: "node",
      args: ["-e", "process.stdout.write(process.version)"],
      cwd: undefined,
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    },
    {
      workspace,
      policy: { ...tools.DEFAULT_SANDBOX_POLICY, network: "inherit" },
      commandRules: [
        {
          executable: "node",
          allowedSubcommands: ["process.stdout.write(process.version)"],
          requiredLeadingFlags: ["-e"],
        },
      ],
      spawn: nodeSpawnFn,
      processEnv: process.env,
      now: Date.now,
    },
  );
  expect(output.outputRedacted).toBe(true);
  expect(output.stdout).not.toContain(process.version.slice(1));
}, 20_000);
