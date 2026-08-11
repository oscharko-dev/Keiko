// Script-owned MSVC toolchain resolution (#3072/#3075/#3084). The ONE home of the vswhere →
// vcvars64 import that every Windows native compile in this repository resolves through:
// the portable launcher (stage-portable-runtime), the secure-workspace-read helper, the
// runtime supervisor, and the runtime attestation. No workflow step persists this environment
// (a full PATH in GITHUB_ENV is a zizmor misfeature and an injection surface) — a build either
// runs inside a Developer Command Prompt (INCLUDE and LIB already present, used as-is) or this
// module imports the toolchain itself. Everything here THROWS on failure; callers that need
// process-exit semantics wrap it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function locateVisualStudioInstallation(baseEnv) {
  const configuredProgramFiles = baseEnv["ProgramFiles(x86)"];
  const programFiles =
    configuredProgramFiles !== undefined && isAbsolute(configuredProgramFiles)
      ? configuredProgramFiles
      : String.raw`C:\Program Files (x86)`;
  const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) {
    throw new Error(
      "MSVC toolchain not found: install the Visual Studio C++ Build Tools (vswhere missing)",
    );
  }
  const located = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
      // Explicit UTF-8 output: without it vswhere emits the console code page, corrupting a
      // non-ASCII installation path before it ever reaches vcvars.
      "-utf8",
    ],
    { encoding: "utf8" },
  );
  const installationPath = located.stdout?.trim().split(/\r?\n/u)[0] ?? "";
  if (located.status !== 0 || installationPath === "") {
    throw new Error("MSVC toolchain not found: Visual Studio C++ Build Tools are not installed");
  }
  return installationPath;
}

function importVcvarsEnvironment(baseEnv, installationPath) {
  const vcvars = join(installationPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  const systemRoot = baseEnv.SystemRoot ?? baseEnv.WINDIR ?? String.raw`C:\Windows`;
  const dump = spawnSync(
    join(systemRoot, "System32", "cmd.exe"),
    // chcp 65001 before `set`: cmd's internal commands emit the OEM code page into a pipe,
    // which corrupts non-ASCII PATH/INCLUDE/LIB values under the UTF-8 decode below.
    ["/d", "/s", "/c", `""${vcvars}" >nul && chcp 65001 >nul && set"`],
    // env: baseEnv, not the implicit process.env — the dump must extend exactly the
    // environment the caller handed in, or the import silently mixes two trust inputs.
    { encoding: "utf8", windowsVerbatimArguments: true, env: baseEnv },
  );
  if (dump.status !== 0) throw new Error("MSVC environment initialization failed (vcvars64)");
  const resolved = { ...baseEnv };
  for (const line of dump.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) resolved[line.slice(0, separator)] = line.slice(separator + 1);
  }
  // cmd emits `Path=`, the parent may carry `PATH=`: Windows treats env names case-insensitively
  // but a JS object does not, and two same-named-differently-cased keys make the child PATH and
  // the tool lookup ambiguous. Rebuild with every case variant merged onto the canonical PATH.
  const canonical = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (key.toUpperCase() === "PATH") canonical.PATH = value;
    else canonical[key] = value;
  }
  return canonical;
}

/**
 * The complete MSVC environment for a Windows native compile: a Developer Command Prompt
 * environment (INCLUDE and LIB present) is used as-is, anything else is imported through
 * vswhere → vcvars64. Throws when no toolchain exists or the import stays incomplete.
 */
export function resolveWindowsMsvcEnv(baseEnv = process.env) {
  if (baseEnv.INCLUDE !== undefined && baseEnv.LIB !== undefined) return baseEnv;
  const resolved = importVcvarsEnvironment(baseEnv, locateVisualStudioInstallation(baseEnv));
  if (resolved.INCLUDE === undefined || resolved.LIB === undefined) {
    throw new Error("MSVC environment initialization did not define INCLUDE and LIB");
  }
  return resolved;
}

/**
 * Absolute path of an MSVC tool on the resolved toolchain PATH. Child-process PATH search does
 * not reliably honour an options.env PATH, so tools are located explicitly and spawned by
 * absolute path. Throws when the tool is absent.
 */
export function windowsToolFromPath(envPath, tool) {
  for (const dir of (envPath ?? "").split(";")) {
    if (dir === "") continue;
    const candidate = join(dir, tool);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`MSVC tool ${tool} was not found on the resolved toolchain PATH`);
}
