// The same server adapter that the release-qualified Workbench uses, with the installed
// SCM service and an isolated marker executable. No release receipt or package registry is changed.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeGatewayConfinement,
  planWindowsGatewayRuntimeSandbox,
} from "@oscharko-dev/keiko-sandbox";
import { createNativeRuntimeProcessBackend } from "../../packages/keiko-server/dist/coding-runtime/nativeRuntimeProcessBackend.js";

const installed = await realpath(process.argv[2]);
const root = dirname(installed);
const observer = join(root, "gateway-service-probe.exe");
const bytes = await readFile(installed);
const scratch = await mkdtemp(join(tmpdir(), "keiko-adapter-smoke-"));
try {
  for (const match of [false, true]) {
    const source = join(scratch, "helper.exe");
    const contents = match ? bytes : Buffer.concat([bytes, Buffer.from([0])]);
    await writeFile(source, contents);
    const pin = createHash("sha256").update(contents).digest("hex");
    const policy = createRuntimeGatewayConfinement({
      gatewayUrl: "http://127.0.0.1:1",
      runId: "run-3423",
      treeBindingId: "a".repeat(64),
      envelopeDigest: "b".repeat(64),
      runtimeArtifactDigest: "c".repeat(64),
      modelProfileDigest: "d".repeat(64),
    });
    const backend = createNativeRuntimeProcessBackend({
      helperPath: source,
      expectedHelperSha256: pin,
      useInstalledWindowsGateway: true,
      workspaceRoot: root,
      runtimeRoots: [root],
      gatewayConfinement: policy,
    });
    const request = {
      runId: policy.runId,
      treeBindingId: policy.treeBindingId,
      recoveryHandle: "0123456789abcdef0123456789abcdef",
      executable: observer,
      cwd: root,
      args: [],
      env: { SystemRoot: process.env.SystemRoot },
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      authorityEnvelopeDigest: policy.envelopeDigest,
      egressPolicy: { kind: "loopback-only", reviewedEgressReceipt: "sha256:" + "b".repeat(64) },
    };
    const plan = planWindowsGatewayRuntimeSandbox({
      ...request,
      command: observer,
      policy: request.egressPolicy,
    });
    assert.equal(plan.kind, "wrapped");
    const tree = backend.spawnOwnedTree(request, plan);
    let output = "";
    const exited = new Promise((resolve) => tree.onTreeExit(resolve));
    tree.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("child-entered")) {
        assert.ok(match, "mismatched installed image executed a child");
        const check = spawnSync(observer, ["--inspect-filters"], { timeout: 6000 });
        assert.equal(check.status, 0);
        tree.stdin.end("X\n");
      }
    });
    tree.stderr.resume();
    const deadline = setTimeout(() => tree.sendControl(3), 10000);
    try {
      const code = await exited;
      if (match) assert.equal(code, 0);
      assert.equal(output.trim(), match ? "child-entered" : "");
      assert.equal(await backend.reconcileTreeExit(tree), match);
    } finally {
      clearTimeout(deadline);
    }
  }
  console.log(
    "Workbench Windows adapter: SCM digest mismatch refused; pinned image admitted, WFP read back and tree reaped",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
