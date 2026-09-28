// Native gateway-policy tests for #3666/#3423. The default run never installs a filter.
// --filter-lifecycle explicitly opts into a privileged, dynamic WFP installation/cleanup test.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../lib/windows-msvc.mjs";

const options = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  options.length > 1 ||
  (options.length === 1 &&
    !new Set(["--filter-lifecycle", "--guarded-lifecycle", "--socket-proof"]).has(options[0]))
) {
  process.stderr.write(
    "Requires Windows; usage: test-windows-gateway-filters.mjs [--filter-lifecycle|--guarded-lifecycle|--socket-proof]\n",
  );
  process.exitCode = 2;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const scratch = mkdtempSync(join(tmpdir(), "keiko-gateway-native-"));
  const executable = join(scratch, "gateway-wfp-test.exe");
  const env = resolveWindowsMsvcEnv();
  const args = [
    "/nologo",
    "/std:c11",
    "/W4",
    "/WX",
    "/analyze",
    "/MT",
    "/DUNICODE",
    "/D_UNICODE",
    "/DKEIKO_GATEWAY_TEST_DIAGNOSTICS",
    "/D_WIN32_WINNT=0x0A00",
    `/Fe:${executable}`,
    `/Fo:${scratch}\\`,
    join(root, "native/runtime-supervisor/windows/gateway_wfp.c"),
    join(root, "native/runtime-supervisor/windows/gateway_wfp.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_socket.test.c"),
    "/link",
    "/DEPENDENTLOADFLAG:0x800",
    "fwpuclnt.lib",
    "rpcrt4.lib",
    "advapi32.lib",
    "ws2_32.lib",
    "userenv.lib",
  ];
  const built = spawnSync(windowsToolFromPath(env.PATH, "cl.exe"), args, {
    env,
    cwd: scratch,
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = built.status ?? 1;
  if (process.exitCode === 0) {
    const checked = spawnSync(executable, [], { stdio: "inherit", windowsHide: true });
    process.exitCode = checked.status ?? 1;
  }
  if (process.exitCode === 0 && options.length === 1) {
    const tested = spawnSync(executable, options, { stdio: "inherit", windowsHide: true });
    process.exitCode = tested.status ?? 1;
  }
}
