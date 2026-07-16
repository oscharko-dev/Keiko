// Regression coverage for the per-second watchdog provisioning-signal walk cost (Issue #2096
// performance-sweep audit finding). `createOperatorProvisioningQualification`'s cheap "signal"
// path must not perform a full recursive `readdirSync` + per-file stat walk of the operator's
// `runtimeClosure` on every call -- only the initial walk (and any call after a real filesystem
// change) may pay that cost. The existing drift tests in `deps.test.ts` only assert on
// `contentReads` (bytes-read count), which stays flat regardless of whether the directory walk
// itself is cached, so they cannot catch a regression here.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsCallCounts = vi.hoisted(() => ({
  readdirSync: 0,
  lstatSync: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (
      ...args: Parameters<typeof actual.readdirSync>
    ): ReturnType<typeof actual.readdirSync> => {
      fsCallCounts.readdirSync += 1;
      return actual.readdirSync(...args);
    },
    lstatSync: (
      ...args: Parameters<typeof actual.lstatSync>
    ): ReturnType<typeof actual.lstatSync> => {
      fsCallCounts.lstatSync += 1;
      return actual.lstatSync(...args);
    },
  };
});

const { createOperatorProvisioningQualification } = await import("../../deps.js");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  fsCallCounts.readdirSync = 0;
  fsCallCounts.lstatSync = 0;
});

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function fixtureWithRuntimeDirectory(fileCount: number): {
  readonly document: Record<string, unknown>;
  readonly runtimeDir: string;
} {
  const approvedRoot = tmp("dap-watchdog-walk-");
  const artifact = (name: string, capsulePath: string): Record<string, string> => ({
    hostPath: join(approvedRoot, name),
    approvedRoot,
    capsulePath,
  });
  for (const name of ["adapter-bin", "node", "npm", "shell", "bwrap"]) {
    const path = join(approvedRoot, name);
    writeFileSync(path, name, "utf8");
    chmodSync(path, 0o700);
  }
  writeFileSync(join(approvedRoot, "npm-user"), "", "utf8");
  writeFileSync(join(approvedRoot, "npm-global"), "", "utf8");
  const runtimeDir = join(approvedRoot, "runtime-lib");
  mkdirSync(runtimeDir);
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(
      join(runtimeDir, `module-${String(index)}.js`),
      `module ${String(index)}`,
      "utf8",
    );
  }
  return {
    runtimeDir,
    document: {
      schemaVersion: 1,
      adapter: {
        executableName: "adapter-bin",
        executableArgs: ["--server=/run/keiko-debug/dap.sock"],
        trustedRoots: [approvedRoot],
        approvedPath: approvedRoot,
      },
      launch: {
        adapterApprovedRoot: approvedRoot,
        node: artifact("node", "/opt/keiko-runtime/node"),
        npm: artifact("npm", "/opt/keiko-runtime/npm"),
        shell: artifact("shell", "/opt/keiko-runtime/shell"),
        npmUserConfig: artifact("npm-user", "/opt/keiko-debug/npm-user-config"),
        npmGlobalConfig: artifact("npm-global", "/opt/keiko-debug/npm-global-config"),
        backend: artifact("bwrap", "/opt/keiko-backend/bwrap"),
        runtimeClosure: [artifact("runtime-lib", "/opt/keiko-runtime/lib")],
      },
    },
  };
}

describe("operator provisioning watchdog walk cost (#2096 performance-sweep audit finding)", () => {
  it("does not re-walk an unchanged runtimeClosure directory on repeated watchdog ticks", () => {
    const { document } = fixtureWithRuntimeDirectory(25);
    const qualification = createOperatorProvisioningQualification({
      KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(document),
    });
    expect(qualification()).toBe("provisioned");
    const readdirAfterFirstTick = fsCallCounts.readdirSync;
    expect(readdirAfterFirstTick).toBeGreaterThan(0);

    // Simulate five more per-second watchdog ticks over the same, unchanged workspace.
    for (let tick = 0; tick < 5; tick += 1) {
      expect(qualification()).toBe("provisioned");
    }

    // Before the fix, every tick re-ran a full recursive `readdirSync` walk of the
    // runtimeClosure directory; an unchanged tree must not grow the readdir count at all.
    expect(fsCallCounts.readdirSync).toBe(readdirAfterFirstTick);
  });

  it("still detects an in-place content change to a file inside a cached runtimeClosure directory", () => {
    const { document, runtimeDir } = fixtureWithRuntimeDirectory(5);
    const qualification = createOperatorProvisioningQualification({
      KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(document),
    });
    expect(qualification()).toBe("provisioned");
    expect(qualification()).toBe("provisioned");

    const tamperedFile = join(runtimeDir, "module-0.js");
    writeFileSync(tamperedFile, "tampered content", "utf8");
    // Pin the new mtime to a value guaranteed to differ from the original so detection never
    // depends on filesystem clock resolution.
    utimesSync(tamperedFile, new Date(2_000), new Date(2_000));

    expect(qualification()).toBe("notProvisioned");
  });

  it("still detects a new file added to a cached runtimeClosure directory", () => {
    const { document, runtimeDir } = fixtureWithRuntimeDirectory(5);
    // Pin the directory's own mtime deterministically in the past so the later real "now"
    // mtime the kernel assigns on the add below is guaranteed to differ, regardless of clock
    // resolution.
    utimesSync(runtimeDir, new Date(1_000), new Date(1_000));
    const qualification = createOperatorProvisioningQualification({
      KEIKO_DAP_OPERATOR_PROVISIONING_JSON: JSON.stringify(document),
    });
    expect(qualification()).toBe("provisioned");
    expect(qualification()).toBe("provisioned");

    writeFileSync(join(runtimeDir, "module-new.js"), "new module", "utf8");

    expect(qualification()).toBe("notProvisioned");
  });
});
