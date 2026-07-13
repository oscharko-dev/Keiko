import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve("native/runtime-supervisor/windows/keiko_runtime_supervisor.c");
const COMPILER_ENV_KEYS = ["PATH", "INCLUDE", "LIB", "LIBPATH"];

export function runtimeSupervisorCompilerEnvironment(environment) {
  const filtered = {};
  for (const key of COMPILER_ENV_KEYS) {
    const value = environment[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || /[\0\r\n]/u.test(value)) {
      throw new Error(`invalid compiler environment variable: ${key}`);
    }
    filtered[key] = value;
  }
  return filtered;
}

export async function runRuntimeSupervisorBuild({
  argv = process.argv,
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const [target, destination] = argv.slice(2);
  if (argv.length !== 4 || target !== "windows-x64" || !destination || !isAbsolute(destination)) {
    return 2;
  }
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true });
  const result = spawnSyncImpl(
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
      `/Fe:${output}`,
      source,
    ],
    {
      stdio: "inherit",
      env: runtimeSupervisorCompilerEnvironment(environment),
    },
  );
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRuntimeSupervisorBuild();
}
