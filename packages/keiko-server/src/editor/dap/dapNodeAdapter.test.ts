import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsOverrides = vi.hoisted(() => ({
  lstat: undefined as Stats | undefined,
  mkdirError: undefined as Error | undefined,
  realpathMismatchRootCall: undefined as number | undefined,
  realpathRootCalls: 0,
  removals: [] as { readonly path: string; readonly options: unknown }[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>): Stats =>
      fsOverrides.lstat ?? (actual.lstatSync(...args) as Stats),
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>): string | undefined => {
      if (fsOverrides.mkdirError !== undefined) throw fsOverrides.mkdirError;
      return actual.mkdirSync(...args);
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>): string => {
      const path = String(args[0]);
      if (path.includes("keiko-debug-root-") && !path.includes("session-")) {
        fsOverrides.realpathRootCalls += 1;
      }
      if (fsOverrides.realpathRootCalls === fsOverrides.realpathMismatchRootCall) {
        return join(String(args[0]), "..");
      }
      return actual.realpathSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>): void => {
      fsOverrides.removals.push({ path: String(args[0]), options: args[1] });
      actual.rmSync(...args);
    },
  };
});

import * as fs from "node:fs";
import type { DebugAdapterSpec } from "./providers/dapAdapterProviders.js";
import { createNodeDebugAdapterSpec } from "./providers/nodeDebugAdapter.js";
import { DapAdapterPreflightError, preflightDapAdapter } from "./dapNodeAdapter.js";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
function executable(path: string): void {
  fs.writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(path, 0o755);
}

function provider(trusted: string): DebugAdapterSpec {
  return createNodeDebugAdapterSpec("fake-dap", ["--stdio"], [trusted], "a".repeat(64));
}

function preflight(workspace: string, trusted: string, path: string): void {
  preflightDapAdapter(provider(trusted), {
    workspaceRoot: workspace,
    processEnv: { PATH: path },
    approvedPath: trusted,
    commandAllowed: () => true,
  });
}

function runtimeStat(overrides: {
  readonly directory?: boolean;
  readonly symbolicLink?: boolean;
  readonly uid?: number;
  readonly mode?: number;
}): Stats {
  return {
    isDirectory: () => overrides.directory ?? true,
    isSymbolicLink: () => overrides.symbolicLink ?? false,
    uid: overrides.uid ?? process.getuid?.() ?? -1,
    mode: overrides.mode ?? 0o40700,
  } as Stats;
}

function dapFixture(): { readonly workspace: string; readonly trusted: string } {
  const workspace = temp("keiko-dap-workspace-");
  const trusted = temp("keiko-dap-trusted-");
  executable(join(trusted, "fake-dap"));
  return { workspace, trusted };
}

function isForcedRecursiveCleanup(options: unknown): boolean {
  if (typeof options !== "object" || options === null) return false;
  const candidate = options as { readonly force?: unknown; readonly recursive?: unknown };
  return candidate.force === true && candidate.recursive === true;
}

afterEach(() => {
  fsOverrides.lstat = undefined;
  fsOverrides.mkdirError = undefined;
  fsOverrides.realpathMismatchRootCall = undefined;
  fsOverrides.realpathRootCalls = 0;
  fsOverrides.removals.splice(0);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dapNodeAdapter", () => {
  it("uses an exact content-free preflight error", () => {
    expect(new DapAdapterPreflightError()).toMatchObject({
      name: "DapAdapterPreflightError",
      message: "EXECUTABLE_NOT_FOUND",
      code: "EXECUTABLE_NOT_FOUND",
    });
  });
  it("rejects a workspace-planted executable even when it resolves into a trusted root", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    const binary = join(trusted, "fake-dap");
    executable(binary);
    fs.symlinkSync(binary, join(workspace, "fake-dap"));
    expect(() => {
      preflight(workspace, trusted, workspace);
    }).toThrow(DapAdapterPreflightError);
  });

  it("requires both lexical and real paths to remain in one trusted root", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    const outside = temp("keiko-dap-outside-");
    const binary = join(outside, "fake-dap");
    executable(binary);
    fs.symlinkSync(binary, join(trusted, "fake-dap"));
    expect(() => {
      preflight(workspace, trusted, trusted);
    }).toThrow(DapAdapterPreflightError);
  });

  it("copies only allowlisted environment values and replaces HOME and PATH", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    const home = temp("keiko-dap-home-");
    const privateTemp = temp("keiko-dap-temp-");
    executable(join(trusted, "fake-dap"));
    const result = preflightDapAdapter(
      createNodeDebugAdapterSpec("fake-dap", ["--stdio"], [trusted], "a".repeat(64), ["LANG"], {
        DAP_MODE: "fixed",
      }),
      {
        workspaceRoot: workspace,
        processEnv: {
          PATH: trusted,
          LANG: "C.UTF-8",
          LC_ALL: "C",
          LC_CTYPE: "UTF-8",
          SECRET_TOKEN: "hidden",
          HOME: "/real",
          TMPDIR: "/operator/tmp",
          TEMP: "/operator/temp",
          TMP: "/operator/tmp-short",
        },
        approvedPath: "/approved-tools",
        createEphemeralHome: () => ({ path: home, cleanup: vi.fn() }),
        createEphemeralTemp: () => ({ path: privateTemp, cleanup: vi.fn() }),
        commandAllowed: () => true,
      },
    );
    expect(result.executable).toBe(fs.realpathSync(join(trusted, "fake-dap")));
    expect(result.args).toStrictEqual(["--stdio"]);
    expect(Object.isFrozen(result.args)).toBe(true);
    expect(result.env).toStrictEqual({
      HOME: "/run/keiko-debug/home",
      USERPROFILE: "/run/keiko-debug/home",
      PATH: "/opt/keiko-runtime",
      LANG: "C.UTF-8",
      DAP_MODE: "fixed",
      TMPDIR: "/run/keiko-debug/tmp",
      TEMP: "/run/keiko-debug/tmp",
      TMP: "/run/keiko-debug/tmp",
    });
    expect(result.env).not.toHaveProperty("SECRET_TOKEN");
  });

  it("fails deterministically before returning a spawnable plan when approval denies", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    executable(join(trusted, "fake-dap"));
    const createHome = vi.fn();
    expect(() =>
      preflightDapAdapter(
        createNodeDebugAdapterSpec("fake-dap", ["--stdio", "--fixed"], [trusted], "a".repeat(64)),
        {
          workspaceRoot: workspace,
          processEnv: { PATH: trusted },
          approvedPath: trusted,
          createEphemeralHome: createHome,
          commandAllowed: (_name, args) => args.length === 1,
        },
      ),
    ).toThrow(DapAdapterPreflightError);
    expect(createHome).not.toHaveBeenCalled();
  });

  it("rejects a missing required executable before allocating private directories", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    executable(join(trusted, "fake-dap"));
    const createHome = vi.fn();
    const spec = {
      ...provider(trusted),
      requiredExecutables: Object.freeze(["fake-dap", "missing-runtime"]),
    };
    expect(() =>
      preflightDapAdapter(spec, {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        createEphemeralHome: createHome,
        commandAllowed: () => true,
      }),
    ).toThrow(DapAdapterPreflightError);
    expect(createHome).not.toHaveBeenCalled();
  });

  it("creates one private runtime tree with reachable fixed capsule HOME and temp paths", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    executable(join(trusted, "fake-dap"));
    const result = preflightDapAdapter(provider(trusted), {
      workspaceRoot: workspace,
      processEnv: { PATH: trusted, TMPDIR: "/operator/tmp" },
      approvedPath: trusted,
      commandAllowed: () => true,
    });
    expect(result.home.path).toBe(join(result.temp.path, "home"));
    expect(result.temp.path).toMatch(/keiko-debug-root-.+session-/u);
    expect(dirname(result.runtimeRoot)).toBe(fs.realpathSync("/tmp"));
    expect(result.runtimeRoot.startsWith(workspace)).toBe(false);
    expect(fs.statSync(result.home.path).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(result.temp.path, "tmp")).mode & 0o777).toBe(0o700);
    expect(result.env.HOME).toBe("/run/keiko-debug/home");
    expect(result.env.TMPDIR).toBe("/run/keiko-debug/tmp");
    expect(JSON.stringify(result.env)).not.toContain(result.temp.path);
    expect(fs.existsSync(result.home.path)).toBe(true);
    expect(fs.existsSync(result.temp.path)).toBe(true);
    result.home.cleanup();
    result.temp.cleanup();
    expect((): void => {
      result.temp.cleanup();
    }).not.toThrow();
    expect(fs.existsSync(result.home.path)).toBe(false);
    expect(fs.existsSync(result.temp.path)).toBe(false);
  });

  it("accepts one exact trusted root without requiring every configured root to contain it", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    const unrelated = temp("keiko-dap-unrelated-");
    executable(join(trusted, "fake-dap"));
    const result = preflightDapAdapter(
      { ...provider(trusted), trustedRoots: [unrelated, trusted] },
      {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        commandAllowed: () => true,
      },
    );
    expect(result.executable).toBe(fs.realpathSync(join(trusted, "fake-dap")));
    result.home.cleanup();
    result.temp.cleanup();
  });

  it("cleans an allocated private HOME if private temp allocation fails", () => {
    const workspace = temp("keiko-dap-workspace-");
    const trusted = temp("keiko-dap-trusted-");
    executable(join(trusted, "fake-dap"));
    const cleanup = vi.fn();
    expect(() =>
      preflightDapAdapter(provider(trusted), {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        createEphemeralHome: () => ({ path: "/private/home", cleanup }),
        createEphemeralTemp: () => {
          throw new Error("private");
        },
        commandAllowed: () => true,
      }),
    ).toThrow("private");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects a planted required runtime after accepting the trusted adapter executable", () => {
    const { workspace, trusted } = dapFixture();
    const runtimeRoot = temp("keiko-dap-runtime-");
    const runtime = join(runtimeRoot, "fake-runtime");
    executable(runtime);
    fs.symlinkSync(runtime, join(workspace, "fake-runtime"));
    const spec = {
      ...provider(trusted),
      trustedRoots: [trusted, runtimeRoot],
      requiredExecutables: ["fake-dap", "fake-runtime"],
    };
    expect(() =>
      preflightDapAdapter(spec, {
        workspaceRoot: workspace,
        processEnv: { PATH: `${trusted}:${workspace}` },
        approvedPath: trusted,
        commandAllowed: () => true,
      }),
    ).toThrow(DapAdapterPreflightError);
  });

  it.each([
    ["non-directory", runtimeStat({ directory: false })],
    ["symlink", runtimeStat({ symbolicLink: true })],
    ["wrong owner", runtimeStat({ uid: (process.getuid?.() ?? 0) + 1 })],
    ["wrong mode", runtimeStat({ mode: 0o40755 })],
  ])("rejects and cleans a %s private runtime root", (_case, stat) => {
    const { workspace, trusted } = dapFixture();
    fsOverrides.lstat = stat;
    expect(() =>
      preflightDapAdapter(provider(trusted), {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        commandAllowed: () => true,
      }),
    ).toThrow(DapAdapterPreflightError);
    expect(
      fsOverrides.removals.some(
        (removal) =>
          removal.path.includes("keiko-debug-root-") && isForcedRecursiveCleanup(removal.options),
      ),
    ).toBe(true);
  });

  it("rejects a private runtime root whose verified real path changes", () => {
    const { workspace, trusted } = dapFixture();
    fsOverrides.realpathMismatchRootCall = 2;
    expect(() =>
      preflightDapAdapter(provider(trusted), {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        commandAllowed: () => true,
      }),
    ).toThrow(DapAdapterPreflightError);
  });

  it("rejects a runtime root when the platform cannot attest its owner", () => {
    const { workspace, trusted } = dapFixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      expect(() =>
        preflightDapAdapter(provider(trusted), {
          workspaceRoot: workspace,
          processEnv: { PATH: trusted },
          approvedPath: trusted,
          commandAllowed: () => true,
        }),
      ).toThrow(DapAdapterPreflightError);
    } finally {
      if (descriptor === undefined) delete (process as { getuid?: unknown }).getuid;
      else Object.defineProperty(process, "getuid", descriptor);
    }
  });

  it("cleans an allocated runtime when nested private HOME creation fails", () => {
    const { workspace, trusted } = dapFixture();
    const cleanup = vi.fn();
    fsOverrides.mkdirError = new Error("home allocation failed");
    expect(() =>
      preflightDapAdapter(provider(trusted), {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        createEphemeralTemp: () => ({ path: "/private/runtime", cleanup }),
        commandAllowed: () => true,
      }),
    ).toThrow("home allocation failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the original temp-allocation failure without a private HOME", () => {
    const { workspace, trusted } = dapFixture();
    expect(() =>
      preflightDapAdapter(provider(trusted), {
        workspaceRoot: workspace,
        processEnv: { PATH: trusted },
        approvedPath: trusted,
        createEphemeralTemp: () => {
          throw new Error("temp allocation failed");
        },
        commandAllowed: () => true,
      }),
    ).toThrow("temp allocation failed");
  });

  it("retains the fixed capsule mount paths when the adapter module is freshly loaded", async () => {
    const { workspace, trusted } = dapFixture();
    vi.resetModules();
    const { preflightDapAdapter: reloadedPreflight } = await import("./dapNodeAdapter.js");
    const result = reloadedPreflight(provider(trusted), {
      workspaceRoot: workspace,
      processEnv: { PATH: trusted },
      approvedPath: trusted,
      commandAllowed: () => true,
    });
    expect(result.env).toMatchObject({
      HOME: "/run/keiko-debug/home",
      USERPROFILE: "/run/keiko-debug/home",
      PATH: "/opt/keiko-runtime",
      TMPDIR: "/run/keiko-debug/tmp",
      TEMP: "/run/keiko-debug/tmp",
      TMP: "/run/keiko-debug/tmp",
    });
    result.temp.cleanup();
  });
});
