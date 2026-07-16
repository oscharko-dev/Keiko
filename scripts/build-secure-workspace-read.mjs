import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = resolve("native/secure-workspace-read/secure_workspace_read.c");
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
  [
    "windows-x64",
    [
      "cl",
      [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        "/D_CRT_SECURE_NO_WARNINGS",
        "/Fe:",
      ],
    ],
  ],
]);

const COMPILER_ENV_KEYS = {
  macos: ["PATH"],
  windows: ["PATH", "INCLUDE", "LIB", "LIBPATH"],
};

export function buildCompilerEnvironment(target, environment) {
  let keys;
  if (target === "windows-x64") keys = COMPILER_ENV_KEYS.windows;
  else if (target === "macos-arm64" || target === "macos-x64") keys = COMPILER_ENV_KEYS.macos;
  else throw new Error(`unsupported compiler environment target: ${target}`);
  const filtered = {};
  for (const key of keys) {
    const value = environment[key];
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
      ? [...flags, output, source, "/link", "ntdll.lib"]
      : [...flags, "-o", output, source];
  return { args, compiler, output, target };
}

export async function runSecureWorkspaceReadBuild({
  argv = process.argv,
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const invocation = compilerInvocation(argv);
  if (invocation === undefined) return 2;
  const { args, compiler, output, target } = invocation;
  const compilerEnvironment = buildCompilerEnvironment(target, environment);
  await mkdir(dirname(output), { recursive: true });
  const result = spawnSyncImpl(compiler, args, {
    stdio: "inherit",
    env: compilerEnvironment,
  });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runSecureWorkspaceReadBuild();
