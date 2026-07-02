import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceFs, WorkspaceInfo, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import {
  PathHostExecutableProbe,
  detectRuntimeCapabilities,
  type HostExecutableProbe,
  type HostExecutableProbeResult,
  type HostExecutableSpec,
} from "./capabilityDetector.js";

const ROOT = "/workspace";

const BASE_WORKSPACE: WorkspaceInfo = {
  root: ROOT,
  name: "fixture",
  version: undefined,
  testFramework: "vitest",
  sourceDirs: [],
  testDirs: [],
  languages: ["typescript"],
  ignoreLines: [],
};

const STATE_SPECS: readonly HostExecutableSpec[] = [
  {
    id: "available-tool",
    kind: "node",
    executable: "available-tool",
    label: "Available tool",
    remediationHint: "Install the available tool.",
  },
  {
    id: "missing-tool",
    kind: "git",
    executable: "missing-tool",
    label: "Missing tool",
    remediationHint: "Install the missing tool.",
  },
  {
    id: "unsupported-tool",
    kind: "language-toolchain",
    executable: "unsupported-tool",
    label: "Unsupported tool",
    remediationHint: "Upgrade the unsupported tool.",
  },
  {
    id: "denied-tool",
    kind: "package-manager",
    executable: "denied-tool",
    label: "Denied tool",
    remediationHint: "Fix permissions for the denied tool.",
  },
  {
    id: "stopped-tool",
    kind: "container-engine",
    executable: "stopped-tool",
    label: "Stopped tool",
    remediationHint: "Start the stopped tool.",
  },
  {
    id: "blocked-tool",
    kind: "container-engine",
    executable: "blocked-tool",
    label: "Blocked tool",
    remediationHint: "Use a trusted executable path.",
  },
];

class MappingProbe implements HostExecutableProbe {
  public readonly calls: string[] = [];
  private readonly results: Readonly<Record<string, HostExecutableProbeResult>>;

  public constructor(results: Readonly<Record<string, HostExecutableProbeResult>>) {
    this.results = results;
  }

  public probe(executable: string): HostExecutableProbeResult {
    this.calls.push(executable);
    return (
      this.results[executable] ?? {
        state: "missing",
        unavailableReason: "executable-not-found",
      }
    );
  }
}

function workspaceWithPackageJson(_packageJson: string): WorkspaceInfo {
  return { ...BASE_WORKSPACE };
}

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeExecutable(
  dir: string,
  name: string,
  body = "#!/bin/sh\nexit 7\n",
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
  return path;
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectRuntimeCapabilities", () => {
  it("reports every degraded host-tool state through the injected metadata seam", () => {
    const probe = new MappingProbe({
      "available-tool": { state: "available", version: "1.2.3" },
      "missing-tool": { state: "missing", unavailableReason: "executable-not-found" },
      "unsupported-tool": { state: "unsupported", unavailableReason: "unsupported-version" },
      "denied-tool": { state: "permission-denied", unavailableReason: "executable-not-runnable" },
      "stopped-tool": { state: "not-running", unavailableReason: "daemon-not-running" },
      "blocked-tool": { state: "policy-blocked", unavailableReason: "policy-blocked" },
    });

    const response = detectRuntimeCapabilities({
      probe,
      specs: STATE_SPECS,
      now: () => 10,
      deadlineMs: 250,
    });

    expect(response.capabilities.map((capability) => [capability.id, capability.state])).toEqual([
      ["available-tool", "available"],
      ["missing-tool", "missing"],
      ["unsupported-tool", "unsupported"],
      ["denied-tool", "permission-denied"],
      ["stopped-tool", "not-running"],
      ["blocked-tool", "policy-blocked"],
    ]);
    expect(
      response.capabilities.find((capability) => capability.id === "available-tool"),
    ).toMatchObject({
      version: "1.2.3",
    });
    expect(probe.calls).toEqual(STATE_SPECS.map((spec) => spec.executable));
  });

  it("classifies package-script names without exposing or executing script bodies", () => {
    const packageJson = JSON.stringify({
      packageManager: "npm@10.9.8",
      scripts: {
        pretest: "node should-not-run.js",
        test: "node writes-sentinel.js",
        build: "webpack --mode production",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        prepare: "node install-hook.js",
        postinstall: "node install-hook.js",
      },
    });
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => packageJson,
      stat: (): WorkspaceStat => ({
        size: packageJson.length,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }),
      readDir: (): readonly [] => [],
      realPath: (absolutePath: string): string => absolutePath,
      exists: (absolutePath: string): boolean => absolutePath === `${ROOT}/package.json`,
    };

    const response = detectRuntimeCapabilities({
      workspace: workspaceWithPackageJson(packageJson),
      fs,
      probe: new MappingProbe({}),
      specs: [],
      now: () => 0,
    });

    const serialized = JSON.stringify(response);
    expect(serialized).toContain('"scriptName":"test"');
    expect(serialized).toContain('"scriptName":"build"');
    expect(serialized).toContain('"scriptName":"typecheck"');
    expect(serialized).toContain('"scriptName":"lint"');
    expect(serialized).not.toContain("writes-sentinel");
    expect(serialized).not.toContain("install-hook");
    expect(serialized).not.toContain(ROOT);
  });

  it("surfaces relative manifest and lockfile command sources", () => {
    const packageJson = JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: {} });
    const files = new Set([
      `${ROOT}/package.json`,
      `${ROOT}/pnpm-lock.yaml`,
      `${ROOT}/Cargo.toml`,
      `${ROOT}/go.mod`,
      `${ROOT}/pyproject.toml`,
      `${ROOT}/pom.xml`,
      `${ROOT}/build.gradle.kts`,
      `${ROOT}/Dockerfile`,
    ]);
    const fs: WorkspaceFs = {
      readFileUtf8: (): string => packageJson,
      stat: (absolutePath: string): WorkspaceStat => ({
        size: packageJson.length,
        isFile: files.has(absolutePath),
        isDirectory: !files.has(absolutePath),
        isSymbolicLink: false,
      }),
      readDir: (): readonly [] => [],
      realPath: (absolutePath: string): string => absolutePath,
      exists: (absolutePath: string): boolean => files.has(absolutePath),
    };

    const response = detectRuntimeCapabilities({
      workspace: BASE_WORKSPACE,
      fs,
      probe: new MappingProbe({}),
      specs: [],
      now: () => 0,
    });

    const sources = response.capabilities
      .map((capability) => capability.source?.path)
      .filter((path): path is string => path !== undefined);
    expect(sources).toEqual(
      expect.arrayContaining([
        "package.json",
        "pnpm-lock.yaml",
        "Cargo.toml",
        "go.mod",
        "pyproject.toml",
        "pom.xml",
        "build.gradle.kts",
        "Dockerfile",
      ]),
    );
  });

  it("rejects workspace-local executables and does not run sentinel binaries", async () => {
    const workspace = await makeTempDir("keiko-runtime-ws-");
    const bin = join(workspace, "bin");
    await mkdir(bin);
    const sentinel = join(workspace, "sentinel.txt");
    await makeExecutable(bin, "npm", `#!/bin/sh\necho ran > ${sentinel}\n`);

    const result = new PathHostExecutableProbe({ PATH: bin }, "linux").probe("npm", workspace);

    expect(result).toEqual({ state: "policy-blocked", unavailableReason: "unsafe-path" });
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a PATH entry inside the workspace even when it symlinks to an external executable", async () => {
    const workspace = await makeTempDir("keiko-runtime-ws-");
    const external = await makeTempDir("keiko-runtime-external-");
    const bin = join(workspace, "bin");
    await mkdir(bin);
    const externalNode = await makeExecutable(external, "node");
    await symlink(externalNode, join(bin, "node"));

    const result = new PathHostExecutableProbe({ PATH: bin }, "linux").probe("node", workspace);

    expect(result).toEqual({ state: "policy-blocked", unavailableReason: "unsafe-path" });
  });

  it("rejects a PATH executable whose realpath resolves into the workspace", async () => {
    const workspace = await makeTempDir("keiko-runtime-ws-");
    const workspaceBin = join(workspace, "bin");
    const external = await makeTempDir("keiko-runtime-external-");
    await mkdir(workspaceBin);
    const workspaceDocker = await makeExecutable(workspaceBin, "docker");
    await symlink(workspaceDocker, join(external, "docker"));

    const result = new PathHostExecutableProbe({ PATH: external }, "linux").probe(
      "docker",
      workspace,
    );

    expect(result).toEqual({ state: "policy-blocked", unavailableReason: "unsafe-path" });
  });

  it("returns a deadline marker instead of blocking when the injected clock expires", () => {
    let now = 0;
    const response = detectRuntimeCapabilities({
      probe: new MappingProbe({}),
      specs: STATE_SPECS,
      now: () => now++,
      deadlineMs: 2,
    });

    expect(
      response.capabilities.some((capability) => capability.id === "runtime-detection:deadline"),
    ).toBe(true);
  });

  it("classifies PATH probing edge cases without executing workspace binaries", async () => {
    const bin = await makeTempDir("keiko-runtime-path-");
    const cachedTool = await makeExecutable(bin, "cached-tool.CMD");
    const deniedTool = join(bin, "denied-tool");
    await writeFile(deniedTool, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(deniedTool, 0o644);

    const probe = new PathHostExecutableProbe({ PATH: bin }, "linux");
    const cacheProbe = new PathHostExecutableProbe({ PATH: bin, PATHEXT: ".CMD" }, "win32");

    expect(probe.probe("", undefined)).toEqual({
      state: "policy-blocked",
      unavailableReason: "policy-blocked",
    });
    expect(probe.probe("bad/name", undefined)).toEqual({
      state: "policy-blocked",
      unavailableReason: "policy-blocked",
    });
    expect(probe.probe("denied-tool", undefined)).toEqual({
      state: "permission-denied",
      unavailableReason: "executable-not-runnable",
    });
    expect(cacheProbe.probe("cached-tool", undefined)).toEqual({ state: "available" });

    await chmod(cachedTool, 0o644);
    expect(cacheProbe.probe("cached-tool", undefined)).toEqual({ state: "available" });
  });

  it("honors Windows executable extensions from PATHEXT", async () => {
    const bin = await makeTempDir("keiko-runtime-win-path-");
    await makeExecutable(bin, "win-tool.CMD");

    const probe = new PathHostExecutableProbe({ PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32");

    expect(probe.probe("win-tool", undefined)).toEqual({ state: "available" });
  });

  it("reports missing package manifests and skips workspace discovery after the deadline", () => {
    const missingPackageFs: WorkspaceFs = {
      readFileUtf8: (): string => {
        throw new Error("missing package.json");
      },
      stat: (): WorkspaceStat => ({
        size: 0,
        isFile: false,
        isDirectory: false,
        isSymbolicLink: false,
      }),
      readDir: (): readonly [] => [],
      realPath: (absolutePath: string): string => absolutePath,
      exists: (): boolean => false,
    };

    const missingManifest = detectRuntimeCapabilities({
      workspace: BASE_WORKSPACE,
      fs: missingPackageFs,
      probe: new MappingProbe({}),
      specs: [],
      now: () => 50,
      deadlineMs: 100,
    });
    expect(missingManifest.capabilities).toContainEqual(
      expect.objectContaining({
        id: "manifest:package-json",
        state: "missing",
        unavailableReason: "manifest-not-found",
      }),
    );

    const noWorkspace = detectRuntimeCapabilities({
      fs: missingPackageFs,
      probe: new MappingProbe({}),
      specs: [],
      now: () => 60,
      deadlineMs: 100,
    });
    expect(noWorkspace.capabilities).toEqual([]);

    const expiredBeforeWorkspaceDiscovery = detectRuntimeCapabilities({
      workspace: BASE_WORKSPACE,
      fs: missingPackageFs,
      probe: new MappingProbe({}),
      specs: [],
      now: () => 70,
      deadlineMs: 0,
    });
    expect(expiredBeforeWorkspaceDiscovery.capabilities).toEqual([]);
  });
});
