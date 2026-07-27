import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runRuntimeSupervisorBuild } from "../build-runtime-supervisor.mjs";

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "keiko-runtime-supervisor-build-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime supervisor build", () => {
  it("rejects malformed and unsupported invocations before spawning", async () => {
    const spawnSyncImpl = vi.fn();
    await expect(
      runRuntimeSupervisorBuild({ argv: ["node", "script"], spawnSyncImpl }),
    ).resolves.toBe(2);
    await expect(
      runRuntimeSupervisorBuild({
        argv: ["node", "script", "linux-x64", "/tmp/helper"],
        spawnSyncImpl,
      }),
    ).resolves.toBe(2);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("builds Windows with the bounded compiler environment and propagates failure", async () => {
    const root = await temporaryRoot();
    const output = join(root, "keiko-runtime-supervisor.exe");
    const environment = {
      PATH: String.raw`C:\Program Files\MSVC\bin`,
      INCLUDE: String.raw`C:\Program Files\MSVC\include`,
      LIB: String.raw`C:\Program Files\MSVC\lib`,
      LIBPATH: String.raw`C:\Program Files\MSVC\libpath`,
      CL: "/DUNTRUSTED",
    };
    const success = vi.fn(() => ({ status: 0 }));
    await expect(
      runRuntimeSupervisorBuild({
        argv: ["node", "script", "windows-x64", output],
        environment,
        spawnSyncImpl: success,
      }),
    ).resolves.toBe(0);
    expect(success).toHaveBeenCalledWith(
      "cl",
      expect.arrayContaining(["/std:c11", `/Fe:${output}`]),
      {
        env: {
          PATH: environment.PATH,
          INCLUDE: environment.INCLUDE,
          LIB: environment.LIB,
          LIBPATH: environment.LIBPATH,
        },
        stdio: "inherit",
      },
    );

    await expect(
      runRuntimeSupervisorBuild({
        argv: ["node", "script", "windows-x64", output],
        environment,
        spawnSyncImpl: () => ({ status: null }),
      }),
    ).resolves.toBe(1);
  });

  it.each([
    ["macos-arm64", "arm64"],
    ["macos-x64", "x86_64"],
  ])("builds all %s components and materializes the extension plist", async (target, arch) => {
    const root = await temporaryRoot();
    const appRoot = join(root, "Keiko.app");
    const output = join(
      appRoot,
      "Contents",
      "Resources",
      "runtime",
      "native",
      "keiko-runtime-supervisor",
    );
    const invocations = [];
    const spawnSyncImpl = vi.fn((compiler, args, options) => {
      invocations.push({ args, compiler, options });
      return { status: 0 };
    });
    await expect(
      runRuntimeSupervisorBuild({
        argv: ["node", "script", target, output],
        environment: { PATH: "/usr/bin", HOME: "/ignored" },
        spawnSyncImpl,
      }),
    ).resolves.toBe(0);
    expect(invocations).toHaveLength(3);
    expect(invocations.every((invocation) => invocation.compiler === "xcrun")).toBe(true);
    expect(invocations.every((invocation) => invocation.args.includes(arch))).toBe(true);
    expect(invocations[1].args).toContain("-lEndpointSecurity");
    expect(invocations[2].args).toContain("SystemExtensions");
    expect(invocations[0].options.env).toEqual({ PATH: "/usr/bin" });
    const plist = await readFile(
      join(
        appRoot,
        "Contents",
        "Library",
        "SystemExtensions",
        "com.oscharko.keiko.runtime-monitor.systemextension",
        "Contents",
        "Info.plist",
      ),
      "utf8",
    );
    expect(plist).toContain("<string>0.2.15</string>");
    expect(plist).not.toContain("__KEIKO_VERSION__");
  });

  it("stops the macOS component sequence on the first failed compiler", async () => {
    const root = await temporaryRoot();
    const output = join(
      root,
      "Keiko.app",
      "Contents",
      "Resources",
      "runtime",
      "native",
      "keiko-runtime-supervisor",
    );
    const statuses = [0, 9];
    const spawnSyncImpl = vi.fn(() => ({ status: statuses.shift() }));
    await expect(
      runRuntimeSupervisorBuild({
        argv: ["node", "script", "macos-arm64", output],
        environment: { PATH: "/usr/bin" },
        spawnSyncImpl,
      }),
    ).resolves.toBe(9);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
  });
});
