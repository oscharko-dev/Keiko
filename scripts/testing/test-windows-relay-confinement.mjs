// #4068 (ADR-0043 D21): end-to-end proof of the pipe-relayed confinement on Windows. It speaks the
// server's real wire protocol (KRP1 launch, KGG1 grants, KGB1 open, KRC1 terminate) to the supervisor
// under test with `--relay-supervised`, which needs no installed service and no elevation. The
// "runtime" is Node.js inside the run's AppContainer: it serves HTTP, calls the gateway through the
// URL the relay rewrote, and tries the host's gateway port directly and the internet. The proof
// holds only when the host reaches the runtime, the runtime reaches the gateway through the relay
// with large bodies in both directions, and both direct paths are refused.
//
//   node scripts/testing/test-windows-relay-confinement.mjs --helper <keiko-runtime-supervisor.exe>
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const REQUEST_BYTES = 200_000;
const RESPONSE_BYTES = 300_000;
const HOST_REQUESTS = 2;
const DEADLINE_MS = 90_000;

const RUNTIME_SOURCE = String.raw`const http = require("node:http");
const net = require("node:net");
const gateway = process.env.KEIKO_MODEL_GATEWAY_URL;
const hostPort = Number(process.env.KEIKO_RELAY_TEST_HOST_PORT);
function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.on("error", (error) => { clearTimeout(timer); resolve("error:" + error.code); });
  });
}
const server = http.createServer(async (req, res) => {
  const viaGateway = await fetch(gateway + "/relay-test", { method: "POST", body: "x".repeat(${REQUEST_BYTES}) })
    .then((response) => response.text())
    .catch((error) => "fetch-error:" + error.message);
  const direct = await tcp("127.0.0.1", hostPort);
  const internet = await tcp("1.1.1.1", 443);
  res.end(JSON.stringify({ gatewayUrl: gateway, head: viaGateway.slice(0, 40), length: viaGateway.length, direct, internet }));
});
server.listen(0, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + server.address().port));
`;

function helperArgument() {
  const index = process.argv.indexOf("--helper");
  const helper = index === -1 ? undefined : process.argv[index + 1];
  if (helper === undefined) throw new Error("usage: --helper <keiko-runtime-supervisor.exe>");
  return helper;
}

function header(magic, kind, length) {
  const frame = Buffer.alloc(12);
  frame.write(magic, 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt16LE(kind, 6);
  frame.writeUInt32LE(length, 8);
  return frame;
}

function lengthPrefixed(value, terminated) {
  const encoded = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length);
  return Buffer.concat([length, encoded, ...(terminated ? [Buffer.alloc(1)] : [])]);
}

function launchFrame(handle, executable, cwd, args, environment) {
  const counts = Buffer.alloc(4);
  counts.writeUInt16LE(args.length, 0);
  counts.writeUInt16LE(environment.length, 2);
  const values = [handle, executable, cwd, ...args, ...environment.flat()];
  const payload = Buffer.concat([counts, ...values.map((value) => lengthPrefixed(value, true))]);
  return Buffer.concat([header("KRP1", 1, payload.length), payload]);
}

function grantsFrame(paths) {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(paths.length);
  // Each grant: access read (1), principal tree (1), then the path.
  const grants = paths.map((path) => Buffer.concat([Buffer.from([1, 1]), lengthPrefixed(path)]));
  const payload = Buffer.concat([count, ...grants]);
  return Buffer.concat([header("KGG1", 1, payload.length), payload]);
}

function openFrame(handle, gatewayPort) {
  const frame = Buffer.alloc(540);
  header("KGB1", 1, 528).copy(frame);
  frame.write(handle, 44, "ascii");
  frame.writeUInt16LE(2, 84);
  frame.writeUInt16LE(gatewayPort, 86);
  return frame;
}

function startGateway() {
  const server = createServer((req, res) => {
    let received = 0;
    req.on("data", (chunk) => (received += chunk.length));
    req.on("end", () => {
      res.write(`gateway-ok received=${String(received)} `);
      setTimeout(() => res.end("y".repeat(RESPONSE_BYTES)), 50);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function hostRequest(port) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/relay-test" }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve(text));
    });
    req.on("error", (error) => resolve(`host-request-error:${String(error.code)}`));
    req.end();
  });
}

function assertAnswer(text, gatewayPort) {
  const answer = JSON.parse(text);
  assert.notEqual(
    answer.gatewayUrl,
    `http://127.0.0.1:${String(gatewayPort)}/api/coding-sidecar/gateway`,
    "the relay rewrites the gateway URL to its inner port",
  );
  assert.equal(answer.head.startsWith(`gateway-ok received=${String(REQUEST_BYTES)} `), true);
  assert.equal(answer.length >= RESPONSE_BYTES, true, "the streamed answer arrives whole");
  assert.notEqual(answer.direct, "connected", "the host gateway port is unreachable directly");
  assert.notEqual(answer.internet, "connected", "the internet is unreachable");
  return answer;
}

async function exercise(child, gatewayPort) {
  let stdout = "";
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(new Error(`supervisor exited early: ${String(code)}`)));
  });
  const answers = [];
  for (let index = 0; index < HOST_REQUESTS; index += 1)
    answers.push(assertAnswer(await hostRequest(port), gatewayPort));
  return answers;
}

// Owner-held directories: the supervisor grants the tree access to them by its own token.
function stageRun(helper, root, gatewayPort) {
  const runtimeDirectory = join(root, "runtime");
  const supervisorDirectory = join(root, "supervisor");
  for (const directory of [runtimeDirectory, supervisorDirectory]) mkdirSync(directory);
  const supervisor = join(supervisorDirectory, "keiko-runtime-supervisor.exe");
  copyFileSync(helper, supervisor);
  copyFileSync(process.execPath, join(runtimeDirectory, "node.exe"));
  writeFileSync(join(runtimeDirectory, "runtime.js"), RUNTIME_SOURCE);
  const handle = randomBytes(16).toString("hex");
  // Node.js resolves C:\ itself unless told to keep symlinked paths, which an AppContainer
  // may not read; the OpenCode runtime does not need these flags.
  const args = [
    "--preserve-symlinks-main",
    "--preserve-symlinks",
    join(runtimeDirectory, "runtime.js"),
  ];
  const environment = [
    [
      "KEIKO_MODEL_GATEWAY_URL",
      `http://127.0.0.1:${String(gatewayPort)}/api/coding-sidecar/gateway`,
    ],
    ["KEIKO_RELAY_TEST_HOST_PORT", String(gatewayPort)],
    ["TEMP", runtimeDirectory],
    ["TMP", runtimeDirectory],
  ].sort(([left], [right]) => left.localeCompare(right));
  const frames = Buffer.concat([
    launchFrame(handle, join(runtimeDirectory, "node.exe"), runtimeDirectory, args, environment),
    grantsFrame([runtimeDirectory, supervisorDirectory]),
    openFrame(handle, gatewayPort),
  ]);
  return { supervisor, frames };
}

async function superviseRun(child, frames, gatewayPort) {
  child.stdio[3].write(frames);
  const deadline = setTimeout(() => child.kill(), DEADLINE_MS);
  const answers = await exercise(child, gatewayPort);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdio[3].write(header("KRC1", 3, 0));
  const code = await exited;
  clearTimeout(deadline);
  assert.equal(code, 0, "the supervisor reaps the tree and exits cleanly");
  return answers;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("windows-relay-confinement: SKIP (requires native Windows)");
    return;
  }
  const helper = helperArgument();
  const root = mkdtempSync(join(tmpdir(), "keiko-relay-confinement-"));
  const gateway = await startGateway();
  let child;
  try {
    const gatewayPort = gateway.address().port;
    const { supervisor, frames } = stageRun(helper, root, gatewayPort);
    child = spawn(supervisor, ["--relay-supervised"], {
      stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
    });
    const answers = await superviseRun(child, frames, gatewayPort);
    console.log(
      `windows-relay-confinement: PASS (${String(answers.length)} host requests, direct=${answers[0].direct}, internet=${answers[0].internet})`,
    );
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill();
    gateway.close();
    rmSync(root, { force: true, recursive: true, maxRetries: 5 });
  }
}

await main();
