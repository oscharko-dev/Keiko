import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "./lib/windows-msvc.mjs";
import { fileURLToPath } from "node:url";

const source = resolve("native/secure-workspace-read/secure_workspace_read.c");

function windowsCompilerFlags() {
  return [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/O2",
    // The helper is staged beneath a developer checkout. Static CRT prevents a plantable VC
    // runtime DLL from resolving beside the executable before main runs.
    "/MT",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_CRT_SECURE_NO_WARNINGS",
    "/Fe:",
  ];
}

const supported = new Map([
  [
    "macos-arm64",
    [
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        "-arch",
        "arm64",
      ],
    ],
  ],
  [
    "macos-x64",
    [
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        "-arch",
        "x86_64",
      ],
    ],
  ],
  ["windows-x64", ["cl", windowsCompilerFlags()]],
]);

const COMPILER_ENV_KEYS = {
  macos: ["PATH"],
  windows: ["PATH", "INCLUDE", "LIB", "LIBPATH"],
};

// The workflow persists no MSVC environment (#3084): outside a Developer Command Prompt the
// toolchain is imported here, script-owned, exactly like the launcher compile.
function windowsEnvironmentSource(environment, resolveMsvcEnvImpl) {
  if (environment.INCLUDE !== undefined && environment.LIB !== undefined) return environment;
  return resolveMsvcEnvImpl(environment);
}

export function buildCompilerEnvironment(
  target,
  environment,
  resolveMsvcEnvImpl = resolveWindowsMsvcEnv,
) {
  let keys;
  let source = environment;
  if (target === "windows-x64") {
    keys = COMPILER_ENV_KEYS.windows;
    source = windowsEnvironmentSource(environment, resolveMsvcEnvImpl);
  } else if (target === "macos-arm64" || target === "macos-x64") keys = COMPILER_ENV_KEYS.macos;
  else throw new Error(`unsupported compiler environment target: ${target}`);
  const filtered = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || /[\0\r\n]/u.test(value))
      throw new Error(`invalid compiler environment variable: ${key}`);
    filtered[key] = value;
  }
  return filtered;
}

function compilerInvocation(argv) {
  const [target, destination] = argv.slice(2);
  if (argv.length !== 4 || !supported.has(target) || !destination || !isAbsolute(destination))
    return undefined;
  const output = resolve(destination);
  const [compiler, flags] = supported.get(target);
  const args =
    target === "windows-x64"
      ? [...flags, output, source, "/link", "/DEPENDENTLOADFLAG:0x800", "ntdll.lib"]
      : [...flags, "-o", output, source];
  return { args, compiler, output, target };
}

export async function runSecureWorkspaceReadBuild({
  argv = process.argv,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  resolveMsvcEnvImpl = resolveWindowsMsvcEnv,
  resolveCompilerImpl = windowsToolFromPath,
} = {}) {
  const invocation = compilerInvocation(argv);
  if (invocation === undefined) return 2;
  const { args, compiler, output, target } = invocation;
  const compilerEnvironment = buildCompilerEnvironment(target, environment, resolveMsvcEnvImpl);
  // Child-process PATH search does not reliably honour options.env.PATH on Windows, so cl is
  // located explicitly on the resolved toolchain PATH and spawned by absolute path.
  const compilerPath =
    target === "windows-x64" ? resolveCompilerImpl(compilerEnvironment.PATH, "cl.exe") : compiler;
  await mkdir(dirname(output), { recursive: true });
  const result = spawnSyncImpl(compilerPath, args, {
    stdio: "inherit",
    env: compilerEnvironment,
  });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runSecureWorkspaceReadBuild();
