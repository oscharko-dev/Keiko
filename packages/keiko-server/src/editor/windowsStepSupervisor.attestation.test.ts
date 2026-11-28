import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  OPENCODE_PINNED_VERSION,
  OPENCODE_RUNTIME_VERSION_PINS,
} from "../coding-runtime/opencodeRuntimeVersions.js";

// #4491: a verification step runs the Windows supervisor and the patched step Node.js, so a
// verification attests those two files and nothing else. The OpenCode payload tree (an executable of
// about 278 MB) is the sidecar's own launch attestation; hashing it for every verification cost
// about 0.9 s of blocked event loop on a real Windows 11 run. These tests drive the real npm-lane
// discovery through the production entry point against a Windows-shaped package, with the platform
// and the compiled approval stood in, and spy on every place a digest could be taken.

interface ProbeState {
  approvals: Record<string, unknown>;
  hashedFiles: string[];
  treeAttestations: number;
  failNextHash: boolean;
  diagnostics: unknown[];
}

const state = vi.hoisted((): ProbeState => ({
  approvals: {},
  hashedFiles: [],
  treeAttestations: 0,
  failNextHash: false,
  diagnostics: [],
}));

vi.mock("../coding-runtime/npmLaneRuntimeApprovals.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../coding-runtime/npmLaneRuntimeApprovals.js")>();
  return {
    ...actual,
    NPM_LANE_RUNTIME_APPROVALS: new Proxy(
      {},
      { get: (_target, key: string): unknown => state.approvals[key] },
    ),
  };
});

vi.mock("../file-sha256.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../file-sha256.js")>();
  return {
    ...actual,
    sha256FileSync: (path: string): string => {
      state.hashedFiles.push(path);
      return actual.sha256FileSync(path);
    },
    sha256FileAsync: (path: string): Promise<string> => {
      state.hashedFiles.push(path);
      if (state.failNextHash) {
        state.failNextHash = false;
        return Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" }));
      }
      return actual.sha256FileAsync(path);
    },
  };
});

vi.mock("../diagnostics-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagnostics-log.js")>();
  return {
    ...actual,
    emitServerDiagnostic: (...args: Parameters<typeof actual.emitServerDiagnostic>): void => {
      state.diagnostics.push(args[1]);
      actual.emitServerDiagnostic(...args);
    },
  };
});

vi.mock("@oscharko-dev/keiko-security/portable-tree-attestation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-security/portable-tree-attestation")>();
  return {
    ...actual,
    attestPortableSidecarTreeSync: (
      ...args: Parameters<typeof actual.attestPortableSidecarTreeSync>
    ): ReturnType<typeof actual.attestPortableSidecarTreeSync> => {
      state.treeAttestations += 1;
      return actual.attestPortableSidecarTreeSync(...args);
    },
  };
});

import {
  attestWindowsStepSupervisor,
  resolveWindowsStepSupervisor,
  resolveWindowsStepSupervisorSync,
} from "./windowsStepSupervisor.js";

const PACKAGE = "@oscharko-dev/keiko-coding-runtime-win32-x64";
const SUPERVISOR = "supervisor-binary";
const PAYLOAD_EXECUTABLE = "payload executable bytes";
const LICENSE = "MIT\n";
const SBOM = "{}\n";
const HELPER = "helper";
const STEP_NODE = "patched step node";
const roots: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalArch = Object.getOwnPropertyDescriptor(process, "arch");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

interface Install {
  readonly env: NodeJS.ProcessEnv;
  readonly supervisorPath: string;
  readonly payloadExecutable: string;
  readonly stepNodePath: string;
}

function windowsInstall(): Install {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "keiko-step-attestation-")));
  roots.push(prefix);
  const scope = join(prefix, "node_modules", "@oscharko-dev");
  const keikoRoot = join(scope, "keiko");
  write(join(keikoRoot, "package.json"), JSON.stringify({ name: "@oscharko-dev/keiko" }));
  write(join(keikoRoot, "dist", "cli", "index.js"), "");
  const runtimeRoot = join(scope, "keiko-coding-runtime-win32-x64", "runtime");
  write(join(runtimeRoot, "..", "package.json"), JSON.stringify({ name: PACKAGE }));
  const payload = join(runtimeRoot, "opencode-compatible", "payload");
  const payloadExecutable = join(payload, "bin", "opencode.exe");
  write(payloadExecutable, PAYLOAD_EXECUTABLE);
  write(join(payload, "evidence", "LICENSE"), LICENSE);
  write(join(payload, "evidence", "sbom.cdx.json"), SBOM);
  write(join(runtimeRoot, "native", "keiko-secure-workspace-read.exe"), HELPER);
  const supervisorPath = join(runtimeRoot, "native", "keiko-runtime-supervisor.exe");
  write(supervisorPath, SUPERVISOR);
  write(join(runtimeRoot, "native", "rg.exe"), "rg");
  const stepNodePath = join(runtimeRoot, "step-node", "node.exe");
  write(stepNodePath, STEP_NODE);
  return {
    env: { KEIKO_CLI_BIN_PATH: join(keikoRoot, "dist", "cli", "index.js") },
    supervisorPath,
    payloadExecutable,
    stepNodePath,
  };
}

const STEP_NODE_PIN = { sha256: sha256(STEP_NODE), sizeBytes: STEP_NODE.length } as never;

function resolveInput(install: Install, events: ServerLogEvent[] = []): never {
  return {
    platform: "win32",
    env: { ...install.env, USERPROFILE: String.raw`C:\Users\dev` },
    activityLog: { write: (event: ServerLogEvent): void => void events.push(event) },
    correlationId: "attestation-proof",
    driveHost: { define: () => "defined", remove: () => true },
    stepNodePin: () => STEP_NODE_PIN,
  } as never;
}

function supervisorOutcome(events: readonly ServerLogEvent[]): unknown {
  return events.find((event) => event.op === "editor.verification.windows-step-supervisor")?.extra
    ?.outcome;
}

beforeEach(() => {
  state.hashedFiles = [];
  state.treeAttestations = 0;
  state.failNextHash = false;
  state.diagnostics = [];
  state.approvals = {
    "windows-x64": {
      packageName: PACKAGE,
      // A complete approval of the package the fixture stages, so the discovery that attests the
      // whole payload accepts it too: what changes between the two is what is hashed, not the verdict.
      upstreamVersion: OPENCODE_PINNED_VERSION,
      adapterName: "keiko-coding-sidecar",
      adapterVersion: "2",
      executableTreeSha256: sha256(`bin/opencode.exe\0${sha256(PAYLOAD_EXECUTABLE)}\0`),
      licenseSha256: sha256(LICENSE),
      protocolSchemaSha256: OPENCODE_RUNTIME_VERSION_PINS[0]?.rawSchemaSha256 ?? "",
      sbomSha256: sha256(SBOM),
      helperSha256: sha256(HELPER),
      helperSizeBytes: HELPER.length,
      helperSourceCommit: "b".repeat(40),
      helperSourceTreeSha256: "c".repeat(64),
      runtimeSupervisor: {
        sha256: sha256(SUPERVISOR),
        sizeBytes: SUPERVISOR.length,
        sourceTreeSha256: "d".repeat(64),
      },
    },
  };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
});

afterEach(() => {
  if (originalPlatform !== undefined) Object.defineProperty(process, "platform", originalPlatform);
  if (originalArch !== undefined) Object.defineProperty(process, "arch", originalArch);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("what a verification attests on the npm lane (#4491)", () => {
  it("hashes the supervisor once and the step Node.js once, and never the OpenCode payload tree", async () => {
    const install = windowsInstall();
    const events: ServerLogEvent[] = [];

    const supervisor = await resolveWindowsStepSupervisor(resolveInput(install, events));

    expect(supervisor?.stepNode).toBeDefined();
    expect(supervisorOutcome(events)).toBe("available");
    expect(state.hashedFiles).toEqual([install.supervisorPath, install.stepNodePath]);
    expect(state.treeAttestations).toBe(0);
  });

  it("does not consult the payload, which the sidecar attests on its own launch path", async () => {
    const install = windowsInstall();
    write(install.payloadExecutable, "a payload that is not the approved one");
    const events: ServerLogEvent[] = [];

    expect(await resolveWindowsStepSupervisor(resolveInput(install, events))).toBeDefined();
    expect(supervisorOutcome(events)).toBe("available");
    expect(state.hashedFiles).not.toContain(install.payloadExecutable);
  });

  it("reads the bytes again for every verification and remembers nothing", async () => {
    const install = windowsInstall();

    await resolveWindowsStepSupervisor(resolveInput(install));
    await resolveWindowsStepSupervisor(resolveInput(install));

    expect(state.hashedFiles).toEqual([
      install.supervisorPath,
      install.stepNodePath,
      install.supervisorPath,
      install.stepNodePath,
    ]);
  });

  it("refuses a supervisor of the pinned size whose bytes were replaced", async () => {
    const install = windowsInstall();
    write(install.supervisorPath, "supervisor-bin4ry");
    expect(Buffer.byteLength("supervisor-bin4ry")).toBe(SUPERVISOR.length);
    const events: ServerLogEvent[] = [];

    expect(await resolveWindowsStepSupervisor(resolveInput(install, events))).toBeUndefined();
    expect(supervisorOutcome(events)).toBe("pin-mismatch");
    // No step Node.js is offered beside a supervisor that is not the pinned one.
    expect(state.hashedFiles).toEqual([install.supervisorPath]);
  });

  it("refuses a supervisor of another size without hashing it", async () => {
    const install = windowsInstall();
    write(install.supervisorPath, "a longer supervisor than the approved one");
    const events: ServerLogEvent[] = [];

    expect(await resolveWindowsStepSupervisor(resolveInput(install, events))).toBeUndefined();
    expect(supervisorOutcome(events)).toBe("pin-mismatch");
  });

  it("refuses a replaced step Node.js and offers the supervisor without it", async () => {
    const install = windowsInstall();
    write(install.stepNodePath, "patched step nodX");
    const events: ServerLogEvent[] = [];

    const supervisor = await resolveWindowsStepSupervisor(resolveInput(install, events));

    expect(supervisor).toBeDefined();
    expect(supervisor?.stepNode).toBeUndefined();
    expect(
      events.find((event) => event.op.endsWith("windows-step-supervisor"))?.extra,
    ).toMatchObject({ stepNode: "mismatch", stepNodeMismatch: "hash" });
  });

  it("is no supervisor when the package carries no supervisor", async () => {
    const install = windowsInstall();
    rmSync(install.supervisorPath);
    const events: ServerLogEvent[] = [];

    expect(await resolveWindowsStepSupervisor(resolveInput(install, events))).toBeUndefined();
    expect(supervisorOutcome(events)).toBe("no-runtime");
  });

  it("measures each attestation on its own clock for the completion line", async () => {
    const install = windowsInstall();
    const ticks = [1_000, 1_040, 1_065];

    const { attestation } = await attestWindowsStepSupervisor({
      ...(resolveInput(install) as object),
      now: () => ticks.shift() ?? 0,
    } as never);

    expect(attestation).toEqual({ supervisorMs: 40, stepNodeMs: 25 });
  });

  it("answers a supervisor that cannot be read with the closed unreadable outcome, not an exception", async () => {
    const install = windowsInstall();
    const events: ServerLogEvent[] = [];
    // A race after the file was found: the read itself fails.
    state.failNextHash = true;

    expect(await resolveWindowsStepSupervisor(resolveInput(install, events))).toBeUndefined();

    expect(supervisorOutcome(events)).toBe("unreadable");
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0]).toMatchObject({
      correlationId: "attestation-proof",
      operation: "editor.verification.windows-step-supervisor.unreadable",
    });
  });

  it("answers the synchronous capability probe from the same checks", () => {
    const install = windowsInstall();
    expect(resolveWindowsStepSupervisorSync(resolveInput(install))).toBeDefined();
    write(install.supervisorPath, "supervisor-bin4ry");
    expect(resolveWindowsStepSupervisorSync(resolveInput(install))).toBeUndefined();
    expect(state.treeAttestations).toBe(0);
  });
});
