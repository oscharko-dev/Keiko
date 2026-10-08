import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const { fetch, AbortSignal, TextDecoder } = globalThis;
const moduleRoot = process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT;
if (!moduleRoot) throw new TypeError("qualified-host-test-modules-required");
const generated = await import(
  new URL(
    "../../packages/keiko-server/dist/coding-runtime/opencodeRuntimeAdapter.js",
    import.meta.url,
  )
);
const profile = await import(
  new URL(
    "../../packages/keiko-server/dist/coding-runtime/opencodeLaunchProfile.js",
    import.meta.url,
  )
);
const source = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-fixed-entry-test-")));
  const workspace = join(root, "workspace");
  const stateRoot = join(workspace, ".keiko", "runtime-test");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["config/opencode", "home", "cache", "data", "state", "tmp"])
    mkdirSync(join(stateRoot, name), { recursive: true, mode: 0o700 });
  for (const name of ["host.mjs", "guard-seams.mjs", "entry.mjs"])
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(root, name));
  symlinkSync(moduleRoot, join(root, "node_modules"));
  writeFileSync(
    join(root, "keiko-governed-tools.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory(),
  );
  writeFileSync(
    join(root, "keiko-native-context.mjs"),
    generated.createGeneratedOpenCodeV2Plugins().keiko_native_context,
  );
  const launch = profile.buildOpenCodeLaunchProfile({
    executable: process.execPath,
    stateRoot,
    contextGeometry: {
      contextWindowTokens: 32768,
      maxInputTokens: 28672,
      maxOutputTokens: 4096,
    },
  });
  assert.equal(launch.ok, true);
  const config = launch.config;
  const databasePath = launch.env.OPENCODE_DB;
  assert.equal(typeof databasePath, "string");
  writeFileSync(join(stateRoot, "config", "opencode", "opencode.json"), config, { mode: 0o600 });
  const input = {
    workspace,
    stateRoot,
    password: launch.env.OPENCODE_SERVER_PASSWORD,
    providerURL: "http://127.0.0.1:1/api/coding-sidecar/gateway/chat/completions",
    providerCapability: "a".repeat(32),
    facadeURL: "http://127.0.0.1:1/api/coding-sidecar/tool",
    facadeCapability: "b".repeat(32),
    mode: "autonomous-delivery",
    runId: "run-fixed-entry-test",
    configDigest: sha(config),
  };
  return {
    root,
    input,
    databasePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function start(own, args = [], environment = {}, cwd = own.input.workspace) {
  const env = { ...process.env, ...environment };
  delete env.NODE_OPTIONS;
  if ("NODE_OPTIONS" in environment) env.NODE_OPTIONS = environment.NODE_OPTIONS;
  const child = spawn(process.execPath, [join(own.root, "host.mjs"), ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, output: () => stdout };
}

async function ready(owned) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const line = owned
      .output()
      .split("\n")
      .find((value) => value.startsWith('{"url":'));
    if (line) return JSON.parse(line).url;
    if (owned.child.exitCode !== null) throw new Error("fixed-entry-exited-before-ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixed-entry-ready-timeout");
}

async function finish(owned) {
  owned.child.stdin.end();
  return Promise.race([
    owned.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("fixed-entry-eof-timeout")), 5000);
      timer.unref();
    }),
  ]);
}

function authenticated(input) {
  return { authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}` };
}

test("the fixed host entry serves original auth/routes/SSE and closes its socket on stdin EOF", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const url = await ready(owned);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const denied = await fetch(url + "/api/info");
    assert.equal(denied.status, 401);
    const info = await fetch(url + "/api/info", { headers: authenticated(own.input) });
    assert.equal(info.status, 200);
    const event = await fetch(url + "/api/event", {
      headers: authenticated(own.input),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(event.status, 200);
    assert.match(event.headers.get("content-type"), /text\/event-stream/u);
    const reader = event.body.getReader();
    const first = await reader.read();
    const nativeEvent = JSON.parse(new TextDecoder().decode(first.value).split("\n\n")[0].slice(6));
    assert.equal(nativeEvent.type, "server.connected");
    assert.equal(typeof nativeEvent.id, "string");
    const result = await finish(owned);
    assert.equal((await reader.read()).done, true);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
    await assert.rejects(fetch(url + "/api/info", { signal: AbortSignal.timeout(1000) }));
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

for (const [name, packet] of [
  ["premature EOF", () => ""],
  ["missing newline", (input) => JSON.stringify(input)],
  ["extra packet", (input) => JSON.stringify(input) + "\n{}\n"],
  ["invalid JSON", () => "{\n"],
  ["oversized packet", () => "x".repeat(16385) + "\n"],
  ["module selector", (input) => JSON.stringify({ ...input, module: "untrusted.mjs" }) + "\n"],
  [
    "wrong config digest",
    (input) => JSON.stringify({ ...input, configDigest: "0".repeat(64) }) + "\n",
  ],
])
  test(`the fixed entry refuses ${name} without publishing readiness or packet data`, async () => {
    const own = fixture();
    const owned = start(own);
    try {
      owned.child.stdin.end(packet(own.input));
      const result = await owned.exited;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "host-entry-refused\n");
    } finally {
      own.cleanup();
    }
  });

for (const [name, args, environment] of [
  ["alternative program argument", ["--import=untrusted.mjs"], {}],
  ["ambient Node program options", [], { NODE_OPTIONS: "--no-warnings" }],
])
  test(`the fixed entry refuses ${name} before service acquisition`, async () => {
    const own = fixture();
    const owned = start(own, args, environment);
    try {
      owned.child.stdin.end(JSON.stringify(own.input) + "\n");
      const result = await owned.exited;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "host-entry-refused\n");
    } finally {
      own.cleanup();
    }
  });

test("a second packet after readiness stops the original service rather than changing its binding", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const url = await ready(owned);
    owned.child.stdin.write("{}\n");
    const result = await finish(owned);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
    await assert.rejects(fetch(url + "/api/info", { signal: AbortSignal.timeout(1000) }));
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

test("EOF during native graph acquisition publishes no stale ready endpoint", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    owned.child.stdin.end(JSON.stringify(own.input) + "\n");
    const result = await owned.exited;
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    own.cleanup();
  }
});

test("a fragmented bounded packet boots once and an old native database cannot resume", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    const text = JSON.stringify(own.input);
    owned.child.stdin.write(text.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(owned.output(), "");
    owned.child.stdin.write(text.slice(20) + " ".repeat(16383 - Buffer.byteLength(text)) + "\n");
    await ready(owned);
    assert.equal((await finish(owned)).code, 0);
    const reused = start(own);
    reused.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await finish(reused);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

test("malformed UTF-8 is refused rather than replaced before JSON validation", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    const packet = Buffer.from(JSON.stringify(own.input) + "\n");
    packet[packet.indexOf(Buffer.from("run-fixed-entry-test"))] = 0xff;
    owned.child.stdin.end(packet);
    const result = await owned.exited;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
  } finally {
    own.cleanup();
  }
});

test("the fixed entry opens the existing launch producer's single database path", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    await ready(owned);
    assert.equal(existsSync(own.databasePath), true);
    assert.equal(readFileSync(own.databasePath).subarray(0, 16).toString(), "SQLite format 3\0");
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

test("the fixed entry refuses the existing launch producer's stale database before readiness", async () => {
  const own = fixture();
  writeFileSync(own.databasePath, "PRIVATE_PRIOR_NATIVE_STATE", { mode: 0o600 });
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await Promise.race([
      owned.exited,
      ready(owned).then(() => ({ code: 0, stdout: "unexpected-ready", stderr: "" })),
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(readFileSync(own.databasePath, "utf8"), "PRIVATE_PRIOR_NATIVE_STATE");
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

test("the fixed entry refuses a cwd different from its bound canonical workspace", async () => {
  const own = fixture();
  const owned = start(own, [], {}, own.root);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await Promise.race([
      owned.exited,
      ready(owned).then(() => ({ code: 0, stdout: "unexpected-ready", stderr: "" })),
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(existsSync(own.databasePath), false);
  } finally {
    await finish(owned);
    own.cleanup();
  }
});

test("the original native session and its echo retain the fixed entry's workspace Location", async () => {
  const own = fixture();
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const url = await ready(owned);
    const created = await fetch(url + "/api/session", {
      method: "POST",
      headers: { ...authenticated(own.input), "content-type": "application/json" },
      body: JSON.stringify({ title: "native workspace Location control" }),
    });
    assert.equal(created.status, 200);
    const session = await created.json();
    assert.equal(session.data.location.directory, own.input.workspace);
    const listed = await fetch(url + "/api/session", { headers: authenticated(own.input) });
    assert.equal(listed.status, 200);
    const echo = await listed.json();
    assert.equal(echo.data.length, 1);
    assert.equal(echo.data[0].id, session.data.id);
    assert.equal(echo.data[0].location.directory, own.input.workspace);
  } finally {
    await finish(owned);
    own.cleanup();
  }
});
