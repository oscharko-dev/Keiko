import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  type Stats,
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
import {
  privateStepNode,
  resolveStepNode,
  windowsStepNodePin,
  type StepNodeCopyPorts,
  type StepNodeFs,
} from "./windowsStepNode.js";
import type { WindowsStepNode } from "@oscharko-dev/keiko-contracts";

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
    driveHost: { define: () => "defined", remove: () => true },
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
  it("is offered when its bytes match the pin, and the supervisor line says patched", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const directory = installStepNode(root);
    const supervisor = await resolve(stateRoot, runtime);
    expect(supervisor?.stepNode?.directory).toBe(directory);
    expect(supervisor?.stepNode?.executable).toBe(join(directory, "node.exe"));
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      op: "editor.verification.windows-step-supervisor",
      correlationId: "step-node-proof",
      outcome: "available",
      stepNode: "patched",
    });
  });

  it("records each step's launch decision on the run's correlation, with closed values only", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root);
    const supervisor = await resolve(stateRoot, runtime);
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

  it("runs the steps as before and says absent when the runtime carries none", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { runtime } = runtimeRoot();
    const supervisor = await resolve(stateRoot, runtime);
    expect(supervisor).toBeDefined();
    expect(supervisor?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      outcome: "available",
      stepNode: "absent",
    });
  });

  it("says absent when this server carries no pin for it", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root);
    expect((await resolve(stateRoot, runtime, () => undefined))?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "absent" });
  });

  it("says absent, not mismatch, when there is no supervisor to find the runtime from", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    expect(
      await resolveWindowsStepSupervisor({
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
  ])("refuses %s and says mismatch", async (_label, bytes) => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    installStepNode(root, bytes);
    const supervisor = await resolve(stateRoot, runtime);
    // The supervisor itself is still available: only the step Node.js is withheld.
    expect(supervisor).toBeDefined();
    expect(supervisor?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({
      outcome: "available",
      stepNode: "mismatch",
    });
  });

  it("refuses a folder that holds anything besides the pinned file", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const directory = installStepNode(root);
    writeFileSync(join(directory, "payload.dll"), "unverified");
    expect((await resolve(stateRoot, runtime))?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a folder with no node.exe in it", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    mkdirSync(join(root, "step-node"));
    expect((await resolve(stateRoot, runtime))?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a folder that is a link, however good the bytes behind it", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const elsewhere = temporary("keiko-step-node-elsewhere-");
    installStepNode(elsewhere);
    symlinkSync(
      join(elsewhere, "step-node"),
      join(root, "step-node"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect((await resolve(stateRoot, runtime))?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it("refuses a node.exe that is a link to the pinned bytes", async () => {
    const stateRoot = temporary("keiko-step-node-log-");
    const { root, runtime } = runtimeRoot();
    const elsewhere = temporary("keiko-step-node-elsewhere-");
    writeFileSync(join(elsewhere, "node.exe"), STEP_NODE_BYTES);
    mkdirSync(join(root, "step-node"));
    symlinkSync(join(elsewhere, "node.exe"), join(root, "step-node", "node.exe"), "file");
    expect((await resolve(stateRoot, runtime))?.stepNode).toBeUndefined();
    expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says mismatch, never throws, when the file cannot be read",
    async () => {
      const stateRoot = temporary("keiko-step-node-log-");
      const { root, runtime } = runtimeRoot();
      const directory = installStepNode(root);
      chmodSync(join(directory, "node.exe"), 0o000);
      expect((await resolve(stateRoot, runtime))?.stepNode).toBeUndefined();
      expect(supervisorLines(stateRoot)[0]).toMatchObject({ stepNode: "mismatch" });
    },
  );

  describe("with injected file system answers", () => {
    const supervisorPath = join(tmpdir(), "rt", "native", "keiko-runtime-supervisor.exe");
    const folder = join(tmpdir(), "rt", "step-node");

    function stat(
      overrides: Partial<{
        size: number;
        nlink: number;
        file: boolean;
      }> = {},
    ): Stats {
      return {
        size: PIN.sizeBytes,
        nlink: 1,
        isFile: () => overrides.file ?? true,
        ...overrides,
      } as unknown as Stats;
    }

    function fakeFs(
      entry: Stats,
      hashes: { count: number },
      overrides: Partial<StepNodeFs> = {},
    ): StepNodeFs {
      return {
        lstat: (path) => (path === folder ? stat() : entry),
        readdir: () => ["node.exe"],
        sha256: (): string => {
          hashes.count++;
          return PIN.sha256;
        },
        ...overrides,
      };
    }

    function run(fs: StepNodeFs): ReturnType<typeof resolveStepNode> {
      return resolveStepNode({
        supervisorPath,
        pin: PIN,
        isDirectory: () => true,
        correlationId: "step-node-fs",
        fs,
      });
    }

    it("answers mismatch, never throws, when stat of the runtime folder is refused", () => {
      for (const code of ["EACCES", "EPERM"]) {
        const refusing = fakeFs(
          stat(),
          { count: 0 },
          {
            lstat: () => {
              throw Object.assign(new Error(code), { code });
            },
          },
        );
        expect(run(refusing)).toEqual({ outcome: "mismatch", mismatch: "unreadable" });
      }
    });

    it("accepts the pinned size with one link", () => {
      expect(run(fakeFs(stat(), { count: 0 }))).toMatchObject({ outcome: "patched" });
    });

    it("refuses a file of another size even when its digest would match", () => {
      expect(run(fakeFs(stat({ size: PIN.sizeBytes + 1 }), { count: 0 }))).toEqual({
        outcome: "mismatch",
        mismatch: "size",
      });
    });

    it("refuses a hard-linked file even when its bytes and size match", () => {
      expect(run(fakeFs(stat({ nlink: 2 }), { count: 0 }))).toEqual({
        outcome: "mismatch",
        mismatch: "not-ordinary-file",
      });
    });

    it("refuses an entry that is not an ordinary file, as a link is not", () => {
      expect(run(fakeFs(stat({ file: false }), { count: 0 }))).toEqual({
        outcome: "mismatch",
        mismatch: "not-ordinary-file",
      });
    });

    // Metadata can be restored after a rewrite (the owner of the folder can set every timestamp),
    // so a match on path, size, times and inode proves nothing about the bytes.
    it("hashes on every resolution and refuses bytes rewritten under unchanged metadata", () => {
      const hashes = { count: 0 };
      let digest = PIN.sha256;
      const fs = fakeFs(stat(), hashes, { sha256: () => (hashes.count++, digest) });
      expect(run(fs)).toMatchObject({ outcome: "patched" });
      digest = "0".repeat(64);
      expect(run(fs)).toEqual({ outcome: "mismatch", mismatch: "hash" });
      expect(hashes.count).toBe(2);
    });

    it("checks the digest against the pin it is given", () => {
      const hashes = { count: 0 };
      const fs = fakeFs(stat(), hashes);
      expect(run(fs)).toMatchObject({ outcome: "patched" });
      expect(
        resolveStepNode({
          supervisorPath,
          pin: { ...PIN, sha256: "f".repeat(64) },
          isDirectory: () => true,
          correlationId: undefined,
          fs,
        }),
      ).toEqual({ outcome: "mismatch", mismatch: "hash" });
      expect(hashes.count).toBe(2);
    });
  });

  it("is pinned by this server for Windows with the real artifact digest", () => {
    expect(windowsStepNodePin()).toBe(NPM_LANE_RUNTIME_APPROVALS["windows-x64"].stepNode);
    expect(windowsStepNodePin()?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("privateStepNode: the run executes its own copy, proven against the pin after the queue", () => {
  const GOOD = Buffer.from("pinned step node bytes");
  const PIN = {
    sha256: createHash("sha256").update(GOOD).digest("hex"),
    sizeBytes: GOOD.length,
    sourceSha256: "0".repeat(64),
    patchSha256s: [],
  };
  const installed: WindowsStepNode = {
    directory: "/install/step-node",
    executable: "/install/step-node/node.exe",
    record: () => undefined,
  };

  function ports(
    files: Map<string, Buffer>,
    over: Partial<StepNodeCopyPorts> = {},
  ): StepNodeCopyPorts & { readonly removed: string[] } {
    const removed: string[] = [];
    const bytes = (path: string): Buffer => {
      const found = files.get(path);
      if (found === undefined) throw new Error("missing");
      return found;
    };
    return {
      pin: () => PIN,
      makeDirectory: () => Promise.resolve("/private/run-1"),
      copyFile: (from, to): Promise<void> => {
        files.set(to, bytes(from));
        return Promise.resolve();
      },
      sizeOf: (path) => Promise.resolve(bytes(path).length),
      sha256: (path) => Promise.resolve(createHash("sha256").update(bytes(path)).digest("hex")),
      removeDirectory: (path): Promise<void> => {
        removed.push(path);
        return Promise.resolve();
      },
      removed,
      ...over,
    };
  }

  it("runs the pinned bytes from a private folder and removes it afterwards", async () => {
    const files = new Map([[installed.executable, GOOD]]);
    const port = ports(files);
    const node = await privateStepNode(installed, port);
    expect(node.outcome).toBe("copied");
    expect(node.stepNode?.executable).toBe(join("/private/run-1", "node.exe"));
    expect(node.stepNode?.directory).toBe("/private/run-1");
    await node.dispose();
    expect(port.removed).toEqual(["/private/run-1"]);
  });

  it.each([
    ["same size, other bytes", Buffer.from("pinned step node bytez"), "hash"],
    ["other size", Buffer.from("short"), "size"],
  ] as const)(
    "refuses an install replaced while the run waited (%s) and uses no step Node.js",
    async (_label, replaced, outcome) => {
      // The install matched the pin when the run was admitted; the package was replaced in the queue.
      const files = new Map([[installed.executable, replaced]]);
      const port = ports(files);
      const node = await privateStepNode(installed, port);
      expect(node).toMatchObject({ outcome, stepNode: undefined });
      expect(port.removed).toEqual(["/private/run-1"]);
    },
  );

  it("fails closed when no pin is carried or the copy cannot be made", async () => {
    const files = new Map([[installed.executable, GOOD]]);
    expect(await privateStepNode(installed, ports(files, { pin: () => undefined }))).toMatchObject({
      outcome: "no-pin",
      stepNode: undefined,
    });
    const failing = ports(files, { copyFile: () => Promise.reject(new Error("denied")) });
    const node = await privateStepNode(installed, failing);
    expect(node).toMatchObject({ outcome: "copy-failed", stepNode: undefined });
    expect(node.failure).toBeInstanceOf(Error);
    expect(failing.removed).toEqual(["/private/run-1"]);
  });
});
