import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFileServerLogSinks, createActivityLogSink } from "../observability/index.js";
import type { ResolvedPortableOpenCodeRuntime } from "../coding-runtime/productionOpenCodeBackend.js";
import { NPM_LANE_RUNTIME_APPROVALS } from "../coding-runtime/npmLaneRuntimeApprovals.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import { resolveWindowsStepSupervisor } from "./windowsStepSupervisor.js";
import { windowsStepNodePin } from "./windowsStepNode.js";

const roots: string[] = [];

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const STEP_NODE_BYTES = Buffer.from("patched step node bytes");
const SUPERVISOR_BYTES = Buffer.from("verified supervisor bytes");

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PIN = {
  sha256: digest(STEP_NODE_BYTES),
  sizeBytes: STEP_NODE_BYTES.length,
  sourceSha256: "a".repeat(64),
  patchSha256s: ["b".repeat(64)],
};

interface Runtime {
  readonly root: string;
  readonly runtime: ResolvedPortableOpenCodeRuntime;
}

/** `<root>/native/keiko-runtime-supervisor.exe` with its pin; the step Node.js lives beside native. */
function runtimeRoot(): Runtime {
  const root = temporary("keiko-step-node-runtime-");
  mkdirSync(join(root, "native"));
  const helperPath = join(root, "native", "keiko-runtime-supervisor.exe");
  writeFileSync(helperPath, SUPERVISOR_BYTES);
  const runtime = {
    target: "windows-x64",
    platformAssurance: "release-qualified",
    nativeHelperPath: helperPath,
    nativeHelperSha256: digest(SUPERVISOR_BYTES),
  } as unknown as ResolvedPortableOpenCodeRuntime;
  return { root, runtime };
}

function installStepNode(root: string, bytes: Buffer = STEP_NODE_BYTES): string {
  const directory = join(root, "step-node");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "node.exe"), bytes);
  return directory;
}

function resolve(
  stateRoot: string,
  runtime: ResolvedPortableOpenCodeRuntime,
  pin: () => typeof PIN | undefined = () => PIN,
): ReturnType<typeof resolveWindowsStepSupervisor> {
  return resolveWindowsStepSupervisor({
    platform: "win32",
    env: {},
    activityLog: createActivityLogSink(stateRoot),
    correlationId: "step-node-proof",
    runtime: () => runtime,
    driveHost: { define: () => true, remove: () => true },
    stepNodePin: pin,
  });
}

function supervisorLines(stateRoot: string): readonly Record<string, unknown>[] {
  closeFileServerLogSinks();
  return persistedActivityLogLines(
    readPersistedActivityLog(stateRoot),
    "editor.verification.windows-step-supervisor",
  ).map((line) =>
    expectActivityLogProof("editor.verification.windows-step-supervisor.emitted-line", line),
  );
}

describe("the runtime's step Node.js (#4492)", () => {
  it("is offered when its bytes match the pin, and the supervisor line says patched", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const directory = installStepNode(root);
    const supervisor = resolve(stateRoot, runtime);
    expect(supervisor?.stepNode?.directory).toBe(directory);
    expect(supervisor?.stepNode?.executable).toBe(join(directory, "node.exe"));
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      op: "editor.verification.windows-step-supervisor",
      correlationId: "step-node-proof",
      outcome: "available",
      stepNode: "patched",
    });
  });

  it("records each step's launch decision on the run's correlation, with closed values only", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root);
    const supervisor = resolve(stateRoot, runtime);
    supervisor?.stepNode?.record({
      image: "step-node",
      npmLaunch: "install-cmd",
      npmFallback: "cli-missing",
      pathPrefixed: true,
      placement: "applied",
    });
    closeFileServerLogSinks();
    const lines = persistedActivityLogLines(
      readPersistedActivityLog(stateRoot),
      "editor.verification.windows-step-node",
    ).map((line) =>
      expectActivityLogProof("editor.verification.windows-step-node.emitted-line", line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op: "editor.verification.windows-step-node",
      correlationId: "step-node-proof",
      image: "step-node",
      npmLaunch: "install-cmd",
      npmFallback: "cli-missing",
      pathPrefixed: true,
      placement: "applied",
    });
    expect(JSON.stringify(lines)).not.toContain(root);
  });

  it("runs the steps as before and says absent when the runtime carries none", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { runtime } = runtimeRoot();
    const supervisor = resolve(stateRoot, runtime);
    expect(supervisor).toBeDefined();
    expect(supervisor?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      outcome: "available",
      stepNode: "absent",
    });
  });

  it("says absent when this server carries no pin for it", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root);
    expect(resolve(stateRoot, runtime, () => undefined)?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "absent" });
  });

  it("says absent, not mismatch, when there is no supervisor to find the runtime from", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    expect(
      resolveWindowsStepSupervisor({
        platform: "win32",
        env: {},
        activityLog: createActivityLogSink(stateRoot),
        runtime: () => undefined,
        stepNodePin: () => PIN,
      }),
    ).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      outcome: "no-runtime",
      stepNode: "absent",
    });
  });

  it.each([
    ["different bytes of another size", Buffer.from("tampered")],
    ["different bytes of the pinned size", Buffer.from("patched step node bytez")],
  ])("refuses %s and says mismatch", (_label, bytes) => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root, bytes);
    const supervisor = resolve(stateRoot, runtime);
    // The supervisor itself is still available: only the step Node.js is withheld.
    expect(supervisor).toBeDefined();
    expect(supervisor?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      outcome: "available",
      stepNode: "mismatch",
    });
  });

  it("refuses a folder that holds anything besides the pinned file", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const directory = installStepNode(root);
    writeFileSync(join(directory, "payload.dll"), "unverified");
    expect(resolve(stateRoot, runtime)?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a folder with no node.exe in it", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    mkdirSync(join(root, "step-node"));
    expect(resolve(stateRoot, runtime)?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a folder that is a link, however good the bytes behind it", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const elsewhere = temporary("keiko-step-node-elsewhere-");
    installStepNode(elsewhere);
    symlinkSync(
      join(elsewhere, "step-node"),
      join(root, "step-node"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(resolve(stateRoot, runtime)?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a node.exe that is a link to the pinned bytes", () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const elsewhere = temporary("keiko-step-node-elsewhere-");
    writeFileSync(join(elsewhere, "node.exe"), STEP_NODE_BYTES);
    mkdirSync(join(root, "step-node"));
    symlinkSync(join(elsewhere, "node.exe"), join(root, "step-node", "node.exe"), "file");
    expect(resolve(stateRoot, runtime)?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says mismatch, never throws, when the file cannot be read",
    () => {
      const stateRoot = temporary("keiko-step-node-log-");
      const { root, runtime } = runtimeRoot();
      const directory = installStepNode(root);
      chmodSync(join(directory, "node.exe"), 0o000);
      expect(resolve(stateRoot, runtime)?.stepNode).toBeUndefined();
      expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
    },
  );

  it("is pinned by this server for Windows with the real artifact digest", () => {
    expect(windowsStepNodePin()).toBe(NPM_LANE_RUNTIME_APPROVALS["windows-x64"].stepNode);
    expect(windowsStepNodePin()?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
