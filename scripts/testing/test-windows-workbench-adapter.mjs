// The same server adapter that the release-qualified Workbench uses, with the installed
// SCM service and an isolated marker executable. No release receipt or package registry is changed.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRuntimeGatewayConfinement,
  planWindowsGatewayRuntimeSandbox,
} from "@oscharko-dev/keiko-sandbox";
import { createNativeRuntimeProcessBackend } from "../../packages/keiko-server/dist/coding-runtime/nativeRuntimeProcessBackend.js";

const [helper, ...options] = process.argv.slice(2);
assert.ok(
  options.length === 0 || (options.length === 1 && options[0] === "--verify-transport"),
  "unexpected Workbench adapter test arguments",
);
const verifyTransport = options.length === 1;
const installed = await realpath(helper);
const root = dirname(installed);
const observer = join(root, "gateway-service-probe.exe");
const bytes = await readFile(installed);
function launch(source, contents, port, args) {
  const pin = createHash("sha256").update(contents).digest("hex");
  const policy = createRuntimeGatewayConfinement({
    gatewayUrl: `http://127.0.0.1:${port}`,
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
    args,
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
  return { backend, tree: backend.spawnOwnedTree(request, plan) };
}

async function listener() {
  const markers = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.on("data", (chunk) => markers.push(chunk.toString("ascii")));
    socket.on("error", () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port, markers, connections: () => connections };
}

async function qualifyTransport(source) {
  const allowed = await listener();
  let hostile;
  try {
    hostile = await listener();
    const args = ["--probe-ports", String(allowed.port), String(hostile.port)];
    const control = await promisify(execFile)(observer, [...args, "control"], { timeout: 8000 });
    assert.deepEqual(JSON.parse(control.stdout), {
      allowed: 0,
      hostile: 0,
      diagnosisStatus: 0,
      missingCapability: 0,
    });
    const { backend, tree } = launch(source, bytes, allowed.port, [...args, "confined"]);
    let output = "";
    tree.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    tree.stderr.resume();
    const deadline = setTimeout(() => tree.sendControl(3), 30000);
    try {
      assert.equal(await new Promise((resolve) => tree.onTreeExit(resolve)), 0);
      assert.equal(await backend.reconcileTreeExit(tree), true);
    } finally {
      clearTimeout(deadline);
    }
    const verdict = JSON.parse(output);
    // Drain the listeners before comparing their observations with the child's report.
    await Promise.all(
      [allowed.server, hostile.server].map((server) => promisify(server.close).call(server)),
    );
    console.log("Installed Workbench TCP probe:", verdict, "host connections:", {
      allowed: allowed.connections(),
      hostile: hostile.connections(),
    });
    assert.equal(hostile.connections(), 1, "unattested port received a second connection");
    assert.equal(hostile.markers.join(""), "C");
    assert.ok(
      [10013, 10060].includes(verdict.hostile),
      "expected policy denial or timeout on the live hostile listener",
    );
    assert.equal(verdict.allowed, 0, "admitted root could not reach its configured gateway");
    assert.equal(allowed.connections(), 2);
    assert.equal(allowed.markers.join(""), "CT");
  } finally {
    if (allowed.server.listening) allowed.server.close();
    if (hostile?.server.listening) hostile.server.close();
  }
}

const scratch = await mkdtemp(join(tmpdir(), "keiko-adapter-smoke-"));
try {
  const source = join(scratch, "helper.exe");
  for (const match of [false, true]) {
    const contents = match ? bytes : Buffer.concat([bytes, Buffer.from([0])]);
    await writeFile(source, contents);
    const { backend, tree } = launch(source, contents, 1, []);
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
  if (verifyTransport) await qualifyTransport(source);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
