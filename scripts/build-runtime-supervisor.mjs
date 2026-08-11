import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCompilerEnvironment } from "./build-secure-workspace-read.mjs";
import { resolveWindowsMsvcEnv, windowsToolFromPath } from "./lib/windows-msvc.mjs";

const WINDOWS_SOURCE = resolve("native/runtime-supervisor/windows/keiko_runtime_supervisor.c");
const MACOS_SOURCE = resolve("native/runtime-supervisor/macos/keiko_runtime_supervisor.c");
const MACOS_EXTENSION_ROOT = resolve("native/runtime-supervisor/macos/system-extension");
const ROOT_PACKAGE = JSON.parse(await readFile(resolve("package.json"), "utf8"));

function compilerInvocation(argv) {
  const [target, destination] = argv.slice(2);
  if (argv.length !== 4 || !destination || !isAbsolute(destination)) return undefined;
  const output = resolve(destination);
  if (target === "windows-x64") {
    return {
      args: [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        "/D_CRT_SECURE_NO_WARNINGS",
        `/Fe:${output}`,
        WINDOWS_SOURCE,
      ],
      compiler: "cl",
      output,
      target,
    };
  }
  if (target === "macos-arm64" || target === "macos-x64") {
    return {
      args: [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        "-arch",
        target === "macos-arm64" ? "arm64" : "x86_64",
        "-o",
        output,
        MACOS_SOURCE,
      ],
      compiler: "xcrun",
      output,
      target,
    };
  }
  return undefined;
}

function macosComponentInvocations(target, supervisorOutput) {
  const architecture = target === "macos-arm64" ? "arm64" : "x86_64";
  const appRoot = resolve(dirname(supervisorOutput), "../../../..");
  const manager = join(appRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
  const extensionRoot = join(
    appRoot,
    "Contents",
    "Library",
    "SystemExtensions",
    "com.oscharko.keiko.runtime-monitor.systemextension",
  );
  const extension = join(extensionRoot, "Contents", "MacOS", "KeikoRuntimeMonitor");
  return {
    extensionRoot,
    invocations: [
      macosExtensionInvocation(architecture, extension),
      macosManagerInvocation(architecture, manager),
    ],
  };
}

function macosExtensionInvocation(architecture, output) {
  return {
    args: [
      "clang",
      "-fobjc-arc",
      "-fblocks",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      architecture,
      "-lEndpointSecurity",
      "-lbsm",
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "-o",
      output,
      join(MACOS_EXTENSION_ROOT, "keiko_runtime_monitor.m"),
    ],
    output,
  };
}

function macosManagerInvocation(architecture, output) {
  return {
    args: [
      "clang",
      "-fobjc-arc",
      "-fblocks",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-arch",
      architecture,
      "-framework",
      "Foundation",
      "-framework",
      "SystemExtensions",
      "-o",
      output,
      join(MACOS_EXTENSION_ROOT, "keiko_system_extension_manager.m"),
    ],
    output,
  };
}

async function buildMacosComponents(invocation, environment, spawnSyncImpl) {
  const components = macosComponentInvocations(invocation.target, invocation.output);
  for (const component of components.invocations) {
    await mkdir(dirname(component.output), { recursive: true });
    const result = spawnSyncImpl("xcrun", component.args, {
      stdio: "inherit",
      env: buildCompilerEnvironment(invocation.target, environment),
    });
    if (result.status !== 0) return result.status ?? 1;
  }
  const plist = (await readFile(join(MACOS_EXTENSION_ROOT, "Info.plist"), "utf8")).replaceAll(
    "__KEIKO_VERSION__",
    ROOT_PACKAGE.version,
  );
  await mkdir(join(components.extensionRoot, "Contents"), { recursive: true });
  await writeFile(join(components.extensionRoot, "Contents", "Info.plist"), plist);
  return 0;
}

// Absolute cl on Windows for the same reason as the sibling builders (#3084): a bare name is
// not reliably searched on options.env.PATH.
function windowsCompilerPath(target, compiler, compilerEnvironment, resolveCompilerImpl) {
  if (target !== "windows-x64") return compiler;
  return resolveCompilerImpl(compilerEnvironment.PATH, "cl.exe");
}

export async function runRuntimeSupervisorBuild({
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
  const compilerPath = windowsCompilerPath(
    target,
    compiler,
    compilerEnvironment,
    resolveCompilerImpl,
  );
  await mkdir(dirname(output), { recursive: true });
  const status = compileSupervisorBinary(compilerPath, args, compilerEnvironment, spawnSyncImpl);
  if (status !== 0) return status;
  return target === "windows-x64"
    ? 0
    : buildMacosComponents(invocation, environment, spawnSyncImpl);
}

function compileSupervisorBinary(compilerPath, args, compilerEnvironment, spawnSyncImpl) {
  const result = spawnSyncImpl(compilerPath, args, {
    stdio: "inherit",
    env: compilerEnvironment,
  });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRuntimeSupervisorBuild();
}
