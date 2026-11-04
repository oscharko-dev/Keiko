// #4068 W1: real OS boundaries of a per-tree AppContainer root. Needs no administrator rights and
// changes no WFP or service state. A host enforcing Smart App Control refuses the freshly built,
// unsigned test before it runs; that is reported as unavailable, never as a pass.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../lib/windows-msvc.mjs";

function build(root, scratch, executable) {
  const env = resolveWindowsMsvcEnv();
  const args = [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/analyze",
    "/external:env:INCLUDE",
    "/external:W0",
    "/MT",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_CRT_SECURE_NO_WARNINGS",
    `/Fe:${executable}`,
    `/Fo:${scratch}${sep}`,
    join(root, "native/runtime-supervisor/windows/runtime_boundary.test.c"),
  ];
  return spawnSync(windowsToolFromPath(env.PATH, "cl.exe"), args, {
    cwd: scratch,
    env,
    stdio: "inherit",
  });
}

if (process.platform !== "win32") {
  process.stderr.write("Requires Windows\n");
  process.exitCode = 2;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const scratch = mkdtempSync(join(tmpdir(), "keiko-runtime-boundary-"));
  const executable = join(scratch, "runtime-boundary-test.exe");
  const built = build(root, scratch, executable);
  if (built.status === 0) {
    const run = spawnSync(executable, [], { stdio: "inherit" });
    if (run.error === undefined) {
      process.exitCode = run.status ?? 1;
    } else {
      process.stderr.write(`runtime boundary: UNAVAILABLE ${String(run.error.code)}\n`);
      process.exitCode = 3;
    }
  } else {
    process.exitCode = built.status ?? 1;
  }
}
