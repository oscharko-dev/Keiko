import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { performance } from "node:perf_hooks";

const { fetch, AbortSignal, TextDecoder } = globalThis;
const moduleRoot =
  process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT ??
  fileURLToPath(new URL("./node_modules", import.meta.url));
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
const artifact = await import(
  new URL(
    "../../packages/keiko-server/dist/coding-runtime/opencodeServiceHostArtifact.js",
    import.meta.url,
  )
);
const packetContract = await import(
  new URL("../../packages/keiko-contracts/dist/opencode-service-host.js", import.meta.url)
);
const source = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(toolProfile = "direct") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-fixed-entry-test-")));
  const workspace = join(root, "workspace");
  const stateRoot = join(workspace, ".keiko", "runtime-test");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["config/opencode", "home", "cache", "data", "state", "tmp"])
    mkdirSync(join(stateRoot, name), { recursive: true, mode: 0o700 });
  for (const name of ["host.mjs", "guard-seams.mjs", "entry.mjs"])
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(root, name));
  symlinkSync(moduleRoot, join(root, "node_modules"), "junction");
  const codecAsset = artifact.createOpenCodeServiceHostNativeCodecAsset();
  copyFileSync(codecAsset.source, join(root, codecAsset.filename));
  for (const asset of artifact.createOpenCodeServiceHostNativePolicyAssets()) {
    mkdirSync(dirname(join(root, asset.filename)), { recursive: true });
    copyFileSync(asset.source, join(root, asset.filename));
  }
  writeFileSync(
    join(root, "keiko-governed-tools.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory(),
  );
  writeFileSync(
    join(root, "keiko-governed-tools-code-mode.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory("code-mode"),
  );
  writeFileSync(
    join(root, "keiko-host-packet-data.mjs"),
    artifact.createOpenCodeServiceHostPacketDataAsset(),
  );
  writeFileSync(
    join(root, "keiko-native-context.mjs"),
    generated.createGeneratedOpenCodeV2Plugins().keiko_native_context,
  );
  const launch = profile.buildOpenCodeLaunchProfile({
    executable: process.execPath,
    stateRoot,
    toolProfile,
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
    toolProfile,
  };
  return {
    root,
    input,
    databasePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function start(own, args = [], environment = {}, cwd = own.input.workspace) {
  const startedAt = performance.now();
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
  let firstStderrAtMs;
  let refusalAtMs;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    firstStderrAtMs ??= Math.round(performance.now() - startedAt);
    if (stderr.split("\n").includes("host-entry-refused"))
      refusalAtMs ??= Math.round(performance.now() - startedAt);
  });
  child.stdin.on("error", () => undefined);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    child,
    exited,
    startedAt,
    output: () => stdout,
    observation: () => ({
      refusalObserved: refusalAtMs !== undefined,
      stderrByteCount: Buffer.byteLength(stderr),
      ...(firstStderrAtMs === undefined ? {} : { firstStderrAtMs }),
      ...(refusalAtMs === undefined ? {} : { refusalAtMs }),
    }),
  };
}

function timeoutError(owned, phase) {
  return new Error(`fixed-entry-${phase}-timeout`, {
    cause: {
      ageMs: Math.round(performance.now() - owned.startedAt),
      readinessObserved: owned
        .output()
        .split("\n")
        .some((line) => line.startsWith('{"url":')),
      processExited: owned.child.exitCode !== null || owned.child.signalCode !== null,
      ...owned.observation(),
    },
  });
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
  throw timeoutError(owned, "ready");
}

async function finish(owned, phase = "eof") {
  owned.child.stdin.end();
  let timer;
  try {
    return await Promise.race([
      owned.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(owned, phase)), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyObservedExit({ code, signal }) {
  if (signal !== null) return "signalled";
  if (code === 1) return "exit-1";
  return code === 0 ? "clean-exit" : "other-exit";
}

async function observeRemainingColdHorizon(owned) {
  const ended = owned.exited.then(classifyObservedExit, () => "observation-failed");
  const remaining = Math.max(0, owned.startedAt + 10000 - performance.now());
  if (remaining === 0) return "deadline";
  let timer;
  try {
    return await Promise.race([
      ended,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("deadline"), remaining);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function finishColdRefusal(owned, t, finishImpl = finish) {
  try {
    return await finishImpl(owned, "cold-refusal");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "fixed-entry-cold-refusal-timeout")
      throw error;
    const disposition = await observeRemainingColdHorizon(owned);
    t.diagnostic(
      JSON.stringify({
        phase: "cold-refusal-after-timeout",
        originalTimeout: error.cause,
        observedAtHorizon: timeoutError(owned, "cold-observation").cause,
        disposition,
      }),
    );
    throw error;
  }
}

async function disposeChild(owned) {
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill();
  let timer;
  try {
    await Promise.race([
      owned.exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill("SIGKILL");
  await owned.exited;
}

function probeExitPromise(probe, child) {
  if (probe.pending) return new Promise(() => undefined);
  if (probe.rejected) return Promise.reject(new Error("synthetic-private-exit-body"));
  return Promise.resolve(probe.result).then((result) => {
    Object.assign(child, { exitCode: result.code, signalCode: result.signal });
    return { ...result, stderr: "synthetic-private-exit-body" };
  });
}

function probeStartTime(probe) {
  if (probe.expired) return performance.now() - 10001;
  return performance.now() - (probe.pending ? 9999 : 0);
}

for (const probe of [
  { name: "late exit 1", result: { code: 1, signal: null }, expected: "exit-1" },
  { name: "late clean exit", result: { code: 0, signal: null }, expected: "clean-exit" },
  { name: "late signal", result: { code: null, signal: "SIGTERM" }, expected: "signalled" },
  { name: "late other exit", result: { code: 2, signal: null }, expected: "other-exit" },
  { name: "rejected exit observation", rejected: true, expected: "observation-failed" },
  { name: "pending exit", pending: true, expected: "deadline" },
  { name: "already expired horizon", rejected: true, expired: true, expected: "deadline" },
]) {
  test(`cold-refusal late observation preserves the original failure for ${probe.name}`, async () => {
    const original = new Error("fixed-entry-cold-refusal-timeout", {
      cause: Object.freeze({ ageMs: 5000, refusalObserved: false, stderrByteCount: 0 }),
    });
    const child = { exitCode: null, signalCode: null };
    const owned = {
      child,
      exited: probeExitPromise(probe, child),
      startedAt: probeStartTime(probe),
      output: () => "",
      observation: () => ({ refusalObserved: false, stderrByteCount: 0 }),
    };
    const diagnostics = [];
    let finishCount = 0;
    const keepAlive = setTimeout(() => undefined, 1000);
    try {
      await assert.rejects(
        finishColdRefusal(
          owned,
          { diagnostic: (value) => diagnostics.push(JSON.parse(value)) },
          async () => {
            finishCount += 1;
            throw original;
          },
        ),
        (error) => error === original,
      );
      assert.equal(finishCount, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].disposition, probe.expected);
      assert.deepEqual(diagnostics[0].originalTimeout, original.cause);
      assert.equal(JSON.stringify(diagnostics).includes("synthetic-private-exit-body"), false);
    } finally {
      clearTimeout(keepAlive);
    }
  });
}

test("cold-refusal late observation preserves ordinary results and unrelated errors", async () => {
  const result = { code: 1, signal: null };
  const sink = { diagnostic: () => assert.fail("Unexpected diagnostic") };
  assert.equal(await finishColdRefusal({}, sink, async () => result), result);
  const original = new Error("synthetic-unrelated-failure");
  await assert.rejects(
    finishColdRefusal({}, sink, async () => {
      throw original;
    }),
    (error) => error === original,
  );
});

function authenticated(input) {
  return { authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}` };
}

test("owned-child cleanup reaps a fixture that ignores graceful termination", async () => {
  const own = fixture();
  writeFileSync(
    join(own.root, "host.mjs"),
    'process.on("SIGTERM", () => undefined); process.stdin.resume(); process.stdout.write("fixture-ready\\n");',
  );
  const owned = start(own);
  let timer;
  try {
    await once(owned.child.stdout, "data", { signal: AbortSignal.timeout(1000) });
    await Promise.race([
      disposeChild(owned),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("owned-child-cleanup-not-bounded")), 3000);
      }),
    ]);
    assert.equal((await owned.exited).signal, "SIGKILL");
  } finally {
    clearTimeout(timer);
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill("SIGKILL");
    await owned.exited;
    own.cleanup();
  }
});

for (const probe of [
  { name: "pending", line: "", refusal: false },
  { name: "refused", line: "host-entry-refused\n", refusal: true },
  { name: "other-stderr", line: "SYNTHETIC_PRIVATE_STDERR_CANARY\n", refusal: false },
]) {
  test(`timeout diagnostics classify ${probe.name} without stderr content`, async () => {
    const own = fixture();
    writeFileSync(
      join(own.root, "host.mjs"),
      `process.stdin.resume(); process.stderr.write(${JSON.stringify(probe.line)}); process.stdout.write("fixture-ready\\n"); process.stdin.once("end", () => { process.exitCode = 0; });`,
    );
    const owned = start(own);
    try {
      await once(probe.line === "" ? owned.child.stdout : owned.child.stderr, "data", {
        signal: AbortSignal.timeout(1000),
      });
      const error = timeoutError(owned, "diagnostic-probe");
      assert.equal(error.cause.refusalObserved, probe.refusal);
      assert.equal(error.cause.stderrByteCount, Buffer.byteLength(probe.line));
      assert.equal(error.cause.processExited, false);
      if (probe.line !== "")
        assert.equal(JSON.stringify(error.cause).includes(probe.line.trim()), false);
    } finally {
      await finish(owned);
      own.cleanup();
    }
  });
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
    await disposeChild(owned);
    own.cleanup();
  }
});

for (const [name, packet] of [
  ["premature EOF", () => ""],
  ["missing newline", (input) => JSON.stringify(input)],
  ["extra packet", (input) => JSON.stringify(input) + "\n{}\n"],
  ["invalid JSON", () => "{\n"],
  [
    "oversized packet",
    () => "x".repeat(packetContract.OPENCODE_SERVICE_HOST_START_PACKET_MAX_BYTES + 1) + "\n",
  ],
  ["module selector", (input) => JSON.stringify({ ...input, module: "untrusted.mjs" }) + "\n"],
  ["unknown profile", (input) => JSON.stringify({ ...input, toolProfile: "invented" }) + "\n"],
  [
    "missing profile",
    (input) => {
      const { toolProfile: _profile, ...missing } = input;
      return JSON.stringify(missing) + "\n";
    },
  ],
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

test("a fragmented bounded packet boots once and an old native database cannot resume", async (t) => {
  const own = fixture();
  const owned = start(own);
  const children = [owned];
  try {
    const text = JSON.stringify(own.input);
    owned.child.stdin.write(text.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(owned.output(), "");
    owned.child.stdin.write(text.slice(20) + " ".repeat(16383 - Buffer.byteLength(text)) + "\n");
    await ready(owned);
    assert.equal((await finish(owned)).code, 0);
    const reused = start(own);
    children.push(reused);
    reused.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await finishColdRefusal(reused, t);
    t.diagnostic(JSON.stringify({ phase: "cold-refusal", ...reused.observation() }));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
  } finally {
    await Promise.all(children.map(disposeChild));
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

test("the sealed Code Mode packet preserves original service startup and EOF without native effect activation", async () => {
  const own = fixture("code-mode");
  const owned = start(own);
  try {
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const url = await ready(owned);
    const info = await fetch(url + "/api/info", { headers: authenticated(own.input) });
    assert.equal(info.status, 200);
    assert.equal(own.input.toolProfile, "code-mode");
    const result = await finish(owned);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
  } finally {
    await finish(owned);
    own.cleanup();
  }
});
