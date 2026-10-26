// Native gateway-policy tests for #3666/#3423. The default run never installs a filter.
// --filter-lifecycle explicitly opts into a privileged, dynamic WFP installation/cleanup test.
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../lib/windows-msvc.mjs";

// Test-only wire producer. The same vectors are independently checked against the actual
// keiko-sandbox policy producer by runtime-gateway.test.ts; this is no second policy ruler.
function requestVector(policy) {
  const bytes = Buffer.alloc(540);
  bytes.write("KGB1", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(bytes.length - 12, 8);
  bytes.fill(0x11, 12, 44);
  bytes.write("0123456789abcdef".repeat(2), 44, "ascii");
  bytes.writeBigUInt64LE(4n, 76);
  bytes.writeUInt16LE(policy.addressFamily === "ipv4" ? 2 : 23, 84);
  bytes.writeUInt16LE(policy.port, 86);
  bytes.writeUInt16LE(policy.runId.length, 88);
  for (const [index, field] of [
    "treeBindingId",
    "envelopeDigest",
    "runtimeArtifactDigest",
    "modelProfileDigest",
    "policyDigest",
  ].entries())
    bytes.write(policy[field], 92 + index * 64, "ascii");
  bytes.write(policy.runId, 412, "ascii");
  return bytes;
}

const options = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  options.length > 1 ||
  (options.length === 1 &&
    !new Set([
      "--filter-lifecycle",
      "--guarded-lifecycle",
      "--socket-proof",
      "--inbound-control-proof",
    ]).has(options[0]))
) {
  process.stderr.write(
    "Requires Windows; usage: test-windows-gateway-filters.mjs [--filter-lifecycle|--guarded-lifecycle|--socket-proof|--inbound-control-proof]\n",
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
    join(root, "native/runtime-supervisor/windows/gateway_journal.c"),
    join(root, "native/runtime-supervisor/windows/gateway_journal.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_peer.c"),
    join(root, "native/runtime-supervisor/windows/gateway_peer.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_request.c"),
    join(root, "native/runtime-supervisor/windows/gateway_request.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_identity.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_socket.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_inbound.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_diagnostics.test.c"),
    join(root, "native/runtime-supervisor/windows/gateway_firewall.test.c"),
    "/link",
    "/DEPENDENTLOADFLAG:0x800",
    "fwpuclnt.lib",
    "rpcrt4.lib",
    "advapi32.lib",
    "ws2_32.lib",
    "userenv.lib",
    "ole32.lib",
    "oleaut32.lib",
    "uuid.lib",
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
  if (process.exitCode === 0) {
    const vectors = JSON.parse(
      readFileSync(
        join(root, "native/runtime-supervisor/windows/gateway_request_vectors.json"),
        "utf8",
      ),
    );
    for (const [index, policy] of vectors.entries()) {
      const filename = join(scratch, `request-${index}.bin`);
      writeFileSync(filename, requestVector(policy));
      const checked = spawnSync(executable, ["--request-proof", filename], {
        stdio: "inherit",
        windowsHide: true,
      });
      process.exitCode = checked.status ?? 1;
      if (process.exitCode !== 0) break;
    }
  }
  if (process.exitCode === 0 && options.length === 1) {
    const tested = spawnSync(executable, options, { stdio: "inherit", windowsHide: true });
    process.exitCode = tested.status ?? 1;
  }
}
