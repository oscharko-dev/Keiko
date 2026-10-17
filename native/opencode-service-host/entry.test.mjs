import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

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

function fixture(toolProfile, own) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keiko-fixed-entry-test-#-"));
  own.cleanup = () => rmSync(temporaryRoot, { recursive: true, force: true });
  const root = realpathSync(temporaryRoot);
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
  const lifecycle = observeChild(child, own.children.length + 1);
  const owned = { child, exited, lifecycle, output: () => stdout };
  owned.settle = () => settleChild(owned);
  own.children.push(owned);
  return owned;
}

async function ready(owned) {
  owned.lifecycle.phase = "ready";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const line = owned
      .output()
      .split("\n")
      .find((value) => value.startsWith('{"url":'));
    if (line) {
      owned.lifecycle.readyPrefix = true;
      const parsed = JSON.parse(line);
      owned.lifecycle.readyParsed = true;
      owned.lifecycle.readyURLShape = /^http:\/\/127\.0\.0\.1:\d+$/u.test(parsed.url);
      owned.lifecycle.phase = "running";
      return parsed.url;
    }
    if (owned.child.exitCode !== null) throw new Error("fixed-entry-exited-before-ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixed-entry-ready-timeout");
}

// Fixture finalization controls begin.
async function finish(owned) {
  owned.lifecycle.phase = "eof";
  owned.child.stdin.end();
  return waitForExit(owned);
}

async function observeStartupRefusal(owned, observeReadiness = ready) {
  return Promise.race([
    owned.exited,
    observeReadiness(owned).then(() => ({ code: 0, stdout: "unexpected-ready", stderr: "" })),
  ]);
}

function waitForExit(owned) {
  return Promise.race([
    owned.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("fixed-entry-eof-timeout")), 5000);
      timer.unref();
    }),
  ]);
}

function withFixture(body, toolProfile = "direct") {
  return async (context) => {
    const own = { children: [], cleanup: () => undefined };
    await runFixtureCase(
      own,
      async () => {
        Object.assign(own, fixture(toolProfile, own));
        await body(own);
      },
      context,
    );
  };
}

function observeChild(child, ordinal) {
  const state = {
    ordinal,
    phase: "created",
    started: performance.now(),
    readyPrefix: false,
    readyParsed: false,
    readyURLShape: false,
    exited: false,
    closed: false,
    spawnError: false,
    stdinError: false,
    stdoutChunks: 0,
    stdoutChars: 0,
    stderrChunks: 0,
    stderrChars: 0,
    codeClass: "pending",
    signalClass: "none",
    cleanupClass: "not-started",
  };
  child.once("error", () => {
    state.spawnError = true;
  });
  child.once("exit", (code, signal) => {
    state.exited = true;
    state.codeClass = code === null ? "unavailable" : code === 0 ? "zero" : "nonzero";
    state.signalClass = signal === null ? "none" : signal === "SIGKILL" ? "killed" : "other";
  });
  child.once("close", () => {
    state.closed = true;
  });
  child.stdin.on("error", () => {
    state.stdinError = true;
  });
  for (const name of ["stdout", "stderr"])
    child[name].on("data", (data) => {
      state[name + "Chunks"] += 1;
      state[name + "Chars"] += data.length;
    });
  return state;
}

function childSnapshot(owned) {
  const state = owned.lifecycle;
  return {
    ordinal: state.ordinal,
    phase: state.phase,
    readyPrefix: state.readyPrefix,
    readyParsed: state.readyParsed,
    readyURLShape: state.readyURLShape,
    stdinEnded: owned.child.stdin.writableEnded,
    stdinDestroyed: owned.child.stdin.destroyed,
    stdinError: state.stdinError,
    exited: state.exited,
    closed: state.closed,
    spawnError: state.spawnError,
    codeClass: state.codeClass,
    signalClass: state.signalClass,
    cleanupClass: state.cleanupClass,
    stdoutChunks: Math.min(state.stdoutChunks, 1000000),
    stdoutChars: Math.min(state.stdoutChars, 1000000),
    stderrChunks: Math.min(state.stderrChunks, 1000000),
    stderrChars: Math.min(state.stderrChars, 1000000),
    elapsedMs: Math.min(60000, Math.max(0, Math.floor(performance.now() - state.started))),
  };
}

function diagnoseFixture(context, own, stage) {
  if (!context) return false;
  try {
    context.diagnostic(
      JSON.stringify({
        stage,
        childCount: own.children.length,
        children: own.children.map((child) =>
          stage === "cleanup"
            ? (child.cleanupSnapshot ?? childSnapshot(child))
            : childSnapshot(child),
        ),
      }),
    );
    return true;
  } catch {
    // Diagnostic delivery must never replace the original failure or prevent cleanup.
    return false;
  }
}

async function forceOwnedSettlement(owned) {
  try {
    if (!owned.lifecycle.exited && !owned.lifecycle.spawnError) owned.child.kill("SIGKILL");
    await waitForExit(owned);
    return "forced-settled";
  } catch {
    return "forced-unsettled";
  }
}

async function settleChild(owned) {
  try {
    await finish(owned);
    owned.lifecycle.cleanupClass = "natural";
  } catch (error) {
    owned.lifecycle.cleanupClass = "natural-failed";
    owned.cleanupSnapshot = childSnapshot(owned);
    owned.lifecycle.cleanupClass = await forceOwnedSettlement(owned);
    owned.cleanupSnapshot.cleanupClass = owned.lifecycle.cleanupClass;
    throw error;
  }
}

async function settleFixture(own) {
  let failed = false;
  let first;
  for (const settle of [
    ...own.children.map((child) => () => child.settle()),
    () => own.cleanup(),
  ]) {
    try {
      await settle();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
}

async function runFixtureCase(own, body, context) {
  let failed = false;
  let first;
  try {
    await body(own);
  } catch (error) {
    failed = true;
    first = error;
    diagnoseFixture(context, own, "body");
  }
  try {
    await settleFixture(own);
  } catch (error) {
    diagnoseFixture(context, own, "cleanup");
    if (!failed) first = error;
    failed = true;
  }
  if (failed) throw first;
}

function finalizationControl(children = [], cleanup = () => undefined) {
  return { children, cleanup };
}

test("fixture finalization preserves a body failure when process cleanup also fails", async () => {
  const original = new Error("body-control");
  const own = finalizationControl([
    {
      settle: async () => {
        throw new Error("cleanup-control");
      },
    },
  ]);
  await assert.rejects(
    runFixtureCase(own, async () => {
      throw original;
    }),
    (error) => error === original,
  );
});

test("fixture finalization preserves an undefined thrown value and still removes files", async () => {
  let cleaned = false;
  const own = finalizationControl(
    [
      {
        settle: async () => {
          throw new Error("cleanup-control");
        },
      },
    ],
    () => {
      cleaned = true;
    },
  );
  let rejected = false;
  await runFixtureCase(own, async () => {
    throw undefined;
  }).then(
    () => assert.fail("a thrown undefined must reject"),
    (error) => {
      rejected = true;
      assert.equal(error, undefined);
    },
  );
  assert.equal(rejected, true);
  assert.equal(cleaned, true);
});

test("fixture finalization attempts every child and files after process cleanup fails", async () => {
  const seen = [];
  const first = new Error("first-cleanup-control");
  const own = finalizationControl(
    [
      {
        settle: async () => {
          seen.push(1);
          throw first;
        },
      },
      {
        settle: async () => {
          seen.push(2);
        },
      },
    ],
    () => {
      seen.push("files");
    },
  );
  await assert.rejects(
    runFixtureCase(own, async () => undefined),
    (error) => error === first,
  );
  assert.deepEqual(seen, [1, 2, "files"]);
});

test("fixture finalization rejects a filesystem failure after a healthy body", async () => {
  const failure = new Error("filesystem-control");
  const own = finalizationControl([], () => {
    throw failure;
  });
  await assert.rejects(
    runFixtureCase(own, async () => undefined),
    (error) => error === failure,
  );
});

function observedControl(ordinal) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writableEnded = false;
  child.stdin.destroyed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return { child, lifecycle: observeChild(child, ordinal), settle: async () => undefined };
}

test("fixture finalization keeps exit separate from close and assigns child ordinals", () => {
  const first = observedControl(1);
  const second = observedControl(2);
  first.child.emit("exit", 0, null);
  assert.equal(childSnapshot(first).exited, true);
  assert.equal(childSnapshot(first).closed, false);
  assert.equal(childSnapshot(second).exited, false);
  first.child.emit("close");
  assert.equal(childSnapshot(first).closed, true);
  assert.deepEqual([childSnapshot(first).ordinal, childSnapshot(second).ordinal], [1, 2]);
});

test("fixture finalization diagnostics precede cleanup and exclude private child values", async () => {
  const owned = observedControl(1);
  const secret = "PRIVATE_AUTH_URL_PACKET_PATH_ERROR_CONTROL";
  owned.child.stdout.emit("data", secret);
  owned.child.stderr.emit("data", secret);
  owned.child.emit("error", new Error(secret));
  owned.child.private = secret;
  owned.lifecycle.phase = "ready";
  const diagnostics = [];
  const original = new Error(secret);
  const own = finalizationControl([owned], () => {
    owned.lifecycle.phase = "cleanup";
  });
  const context = { diagnostic: (text) => diagnostics.push(text) };
  await assert.rejects(
    runFixtureCase(
      own,
      async () => {
        throw original;
      },
      context,
    ),
    (error) => error === original,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].includes(secret), false);
  const diagnostic = JSON.parse(diagnostics[0]);
  assert.equal(diagnostic.stage, "body");
  assert.equal(diagnostic.children[0].phase, "ready");
  assert.equal(diagnostic.children[0].spawnError, true);
  assert.equal(diagnostic.children[0].stdoutChars, secret.length);
  assert.deepEqual(Object.keys(diagnostic).sort(), ["childCount", "children", "stage"]);
});

test("fixture finalization cleans partial setup and reports cleanup separately", async () => {
  const diagnostics = [];
  let attempted = false;
  const original = new Error("setup-control");
  const own = finalizationControl();
  const context = { diagnostic: (text) => diagnostics.push(JSON.parse(text)) };
  await assert.rejects(
    runFixtureCase(
      own,
      async () => {
        own.cleanup = () => {
          attempted = true;
          throw new Error("filesystem-control");
        };
        throw original;
      },
      context,
    ),
    (error) => error === original,
  );
  assert.equal(attempted, true);
  assert.deepEqual(
    diagnostics.map((entry) => entry.stage),
    ["body", "cleanup"],
  );
});

test("fixture finalization forces only a failed owned shutdown and retains its failure", async () => {
  const owned = observedControl(1);
  const original = new Error("eof-control");
  let signal;
  owned.exited = new Promise((resolve) => owned.child.once("exit", resolve));
  owned.child.stdin.end = () => {
    throw original;
  };
  owned.child.kill = (value) => {
    signal = value;
    owned.child.emit("exit", null, "SIGKILL");
  };
  await assert.rejects(settleChild(owned), (error) => error === original);
  assert.equal(signal, "SIGKILL");
  assert.equal(owned.lifecycle.cleanupClass, "forced-settled");
  assert.equal(owned.lifecycle.exited, true);
  assert.equal(owned.lifecycle.closed, false);
  assert.equal(owned.cleanupSnapshot.exited, false);
  assert.equal(owned.cleanupSnapshot.cleanupClass, "forced-settled");
});

test("fixture finalization accepts natural exit without requiring close or forcing a kill", async () => {
  const owned = observedControl(1);
  let killed = false;
  owned.exited = new Promise((resolve) => owned.child.once("exit", resolve));
  owned.child.stdin.end = () => owned.child.emit("exit", 0, null);
  owned.child.kill = () => {
    killed = true;
  };
  await settleChild(owned);
  assert.equal(owned.lifecycle.cleanupClass, "natural");
  assert.equal(owned.lifecycle.closed, false);
  assert.equal(killed, false);
});

test("fixture finalization preserves undefined and attempts all cleanup when diagnostics throw", async () => {
  const seen = [];
  const first = observedControl(1);
  const second = observedControl(2);
  first.settle = async () => {
    seen.push(1);
    throw new Error("process-control");
  };
  second.settle = async () => {
    seen.push(2);
  };
  const own = finalizationControl([first, second], () => {
    seen.push("files");
  });
  let diagnosticCount = 0;
  const context = {
    diagnostic: () => {
      diagnosticCount += 1;
      throw new Error("diagnostic-control");
    },
  };
  let rejected = false;
  let observed;
  await runFixtureCase(
    own,
    async () => {
      throw undefined;
    },
    context,
  ).then(
    () => assert.fail("the original body failure must reject"),
    (error) => {
      rejected = true;
      observed = error;
    },
  );
  assert.deepEqual(seen, [1, 2, "files"]);
  assert.equal(rejected, true);
  assert.equal(observed, undefined);
  assert.equal(diagnosticCount, 2);
});

test("fixture finalization preserves the first cleanup failure when diagnostics throw", async () => {
  const seen = [];
  const original = new Error("process-control");
  const first = observedControl(1);
  const second = observedControl(2);
  first.settle = async () => {
    seen.push(1);
    throw original;
  };
  second.settle = async () => {
    seen.push(2);
  };
  const own = finalizationControl([first, second], () => {
    seen.push("files");
    throw new Error("filesystem-control");
  });
  let diagnosticCount = 0;
  const context = {
    diagnostic: () => {
      diagnosticCount += 1;
      throw new Error("diagnostic-control");
    },
  };
  await assert.rejects(
    runFixtureCase(own, async () => undefined, context),
    (error) => error === original,
  );
  assert.deepEqual(seen, [1, 2, "files"]);
  assert.equal(diagnosticCount, 1);
});

function startupObservationControl(exited) {
  const owned = observedControl(1);
  let ended = false;
  owned.exited = exited;
  owned.child.stdin.end = () => {
    ended = true;
  };
  return { owned, ended: () => ended };
}

test("startup refusal preserves the actual exit without ending the owned stdin", async () => {
  const refusal = { code: 1, signal: null, stdout: "", stderr: "host-entry-refused\n" };
  const control = startupObservationControl(Promise.resolve(refusal));
  let observed = false;
  const result = await observeStartupRefusal(control.owned, () => {
    observed = true;
    return new Promise(() => undefined);
  });
  assert.equal(result, refusal);
  assert.equal(control.ended(), false);
  assert.equal(observed, true);
});

test("startup refusal treats unexpected readiness as failure without cancelling acquisition", async () => {
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const control = startupObservationControl(exited);
  let ended = false;
  control.owned.child.stdin.end = () => {
    ended = true;
    resolveExit({ code: 1, stdout: "", stderr: "host-entry-refused\n" });
  };
  const result = await observeStartupRefusal(control.owned, () =>
    Promise.resolve("http://127.0.0.1:1983"),
  );
  assert.deepEqual(result, { code: 0, stdout: "unexpected-ready", stderr: "" });
  assert.equal(ended, false);
});

test("startup refusal retains a failed readiness observation without ending stdin", async () => {
  const original = new Error("startup-observation-control");
  const control = startupObservationControl(new Promise(() => undefined));
  let ended = false;
  control.owned.child.stdin.end = () => {
    ended = true;
    control.owned.exited = Promise.resolve({ code: 1 });
  };
  await assert.rejects(
    observeStartupRefusal(control.owned, () => Promise.reject(original)),
    (error) => error === original,
  );
  assert.equal(ended, false);
});
// Fixture finalization controls end.

function authenticated(input) {
  return { authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}` };
}

test(
  "readiness uses the pinned predicate and refuses unsupported addresses without publishing",
  withFixture(async (own) => {
    const { publishFixedHostReadiness } = await import(pathToFileURL(join(own.root, "entry.mjs")));
    const { Cause, Effect, Exit } = await import(
      pathToFileURL(join(moduleRoot, "effect/dist/index.js"))
    );
    const endpoints = [];
    const ready = (endpoint) => endpoints.push(endpoint);
    const supported = await Effect.runPromiseExit(
      publishFixedHostReadiness({ _tag: "TcpAddress", port: 1983 }, ready),
    );
    assert.equal(Exit.isSuccess(supported), true);
    assert.deepEqual(endpoints, ["http://127.0.0.1:1983"]);
    for (const address of [{ _tag: "UnixAddress", path: "PRIVATE_SOCKET" }, {}, null]) {
      const refused = await Effect.runPromiseExit(publishFixedHostReadiness(address, ready));
      assert.equal(Exit.isFailure(refused), true);
      assert.deepEqual(Cause.squash(refused.cause), "host-address-invalid");
      assert.deepEqual(endpoints, ["http://127.0.0.1:1983"]);
    }
  }),
);

test(
  "native route acquisition failure remains a constant refusal and never publishes readiness",
  withFixture(async (own) => {
    writeFileSync(
      join(own.root, "host.mjs"),
      `
    import { Effect } from "effect";
    import { runFixedHostEntry } from "./entry.mjs";
    process.exitCode = await runFixedHostEntry(() => Effect.fail(new Error("PRIVATE_NATIVE_CAUSE")));
  `,
    );
    const owned = start(own);
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await owned.exited;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
  }),
);

test(
  "the fixed host entry serves original auth/routes/SSE and closes its socket on stdin EOF",
  withFixture(async (own) => {
    const owned = start(own);
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
  }),
);

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
  test(
    `the fixed entry refuses ${name} without publishing readiness or packet data`,
    withFixture(async (own) => {
      const owned = start(own);
      owned.child.stdin.end(packet(own.input));
      const result = await owned.exited;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "host-entry-refused\n");
    }),
  );

for (const [name, args, environment] of [
  ["alternative program argument", ["--import=untrusted.mjs"], {}],
  ["ambient Node program options", [], { NODE_OPTIONS: "--no-warnings" }],
])
  test(
    `the fixed entry refuses ${name} before service acquisition`,
    withFixture(async (own) => {
      const owned = start(own, args, environment);
      owned.child.stdin.end(JSON.stringify(own.input) + "\n");
      const result = await owned.exited;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "host-entry-refused\n");
    }),
  );

test(
  "a second packet after readiness stops the original service rather than changing its binding",
  withFixture(async (own) => {
    const owned = start(own);
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const url = await ready(owned);
    owned.child.stdin.write("{}\n");
    const result = await finish(owned);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
    await assert.rejects(fetch(url + "/api/info", { signal: AbortSignal.timeout(1000) }));
  }),
);

test(
  "EOF during native graph acquisition publishes no stale ready endpoint",
  withFixture(async (own) => {
    const owned = start(own);
    owned.child.stdin.end(JSON.stringify(own.input) + "\n");
    const result = await owned.exited;
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }),
);

test(
  "a fragmented bounded packet boots once and an old native database cannot resume",
  withFixture(async (own) => {
    const owned = start(own);
    const text = JSON.stringify(own.input);
    owned.child.stdin.write(text.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(owned.output(), "");
    owned.child.stdin.write(text.slice(20) + " ".repeat(16383 - Buffer.byteLength(text)) + "\n");
    await ready(owned);
    assert.equal((await finish(owned)).code, 0);
    const previousDatabaseDigest = sha(readFileSync(own.databasePath));
    const reused = start(own);
    reused.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await observeStartupRefusal(reused);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(sha(readFileSync(own.databasePath)), previousDatabaseDigest);
  }),
);

test(
  "malformed UTF-8 is refused rather than replaced before JSON validation",
  withFixture(async (own) => {
    const owned = start(own);
    const packet = Buffer.from(JSON.stringify(own.input) + "\n");
    packet[packet.indexOf(Buffer.from("run-fixed-entry-test"))] = 0xff;
    owned.child.stdin.end(packet);
    const result = await owned.exited;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
  }),
);

test(
  "the fixed entry opens the existing launch producer's single database path",
  withFixture(async (own) => {
    const owned = start(own);
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    await ready(owned);
    assert.equal(existsSync(own.databasePath), true);
    assert.equal(readFileSync(own.databasePath).subarray(0, 16).toString(), "SQLite format 3\0");
  }),
);

test(
  "the fixed entry refuses the existing launch producer's stale database before readiness",
  withFixture(async (own) => {
    writeFileSync(own.databasePath, "PRIVATE_PRIOR_NATIVE_STATE", { mode: 0o600 });
    const owned = start(own);
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await observeStartupRefusal(owned);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(readFileSync(own.databasePath, "utf8"), "PRIVATE_PRIOR_NATIVE_STATE");
  }),
);

test(
  "the fixed entry refuses a cwd different from its bound canonical workspace",
  withFixture(async (own) => {
    const owned = start(own, [], {}, own.root);
    owned.child.stdin.write(JSON.stringify(own.input) + "\n");
    const result = await observeStartupRefusal(owned);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "host-entry-refused\n");
    assert.equal(existsSync(own.databasePath), false);
  }),
);

test(
  "the original native session and its echo retain the fixed entry's workspace Location",
  withFixture(async (own) => {
    const owned = start(own);
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
  }),
);

test(
  "the sealed Code Mode packet preserves original service startup and EOF without native effect activation",
  withFixture(async (own) => {
    const owned = start(own);
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
  }, "code-mode"),
);
