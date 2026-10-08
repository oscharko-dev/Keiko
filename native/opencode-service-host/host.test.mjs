import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const { Request, Response, TextDecoder, AbortController, fetch } = globalThis;

const moduleRoot = process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT;
if (!moduleRoot) throw new TypeError("qualified-host-test-modules-required");
const { Effect, References, Option, Context, Layer } = await import(
  pathToFileURL(join(moduleRoot, "effect/dist/index.js"))
);
const { NodeServices } = await import(
  pathToFileURL(join(moduleRoot, "@effect/platform-node/dist/index.js"))
);
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
const { HttpTraceContext, HttpRouter } = await import(
  pathToFileURL(join(moduleRoot, "effect/dist/unstable/http/index.js"))
);
const { fixedPostTransport } = await import("./guard-seams.mjs");
const artifact = await import(
  new URL(
    "../../packages/keiko-server/dist/coding-runtime/opencodeServiceHostArtifact.js",
    import.meta.url,
  )
);
const contract = await import(
  new URL("../../packages/keiko-server/dist/coding-runtime/opencodeToolSchemas.js", import.meta.url)
);
const { Tool } = await import(pathToFileURL(join(moduleRoot, "@opencode/core/dist/tool.js")));
const { LocationServiceMap } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/core/dist/location-services.js"))
);
const { Plugin } = await import(pathToFileURL(join(moduleRoot, "@opencode/core/dist/plugin.js")));
const { Location } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/core/dist/location.js"))
);
const nativeChat = await import(
  pathToFileURL(join(moduleRoot, "@opencode/ai/dist/protocols/openai-chat.js"))
);
const source = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(toolProfile = "direct") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-fixed-host-test-")));
  const workspace = join(root, "workspace");
  const stateRoot = join(workspace, ".keiko", "runtime-test");
  for (const path of [
    workspace,
    stateRoot,
    ...["config/opencode", "home", "cache", "data", "state", "tmp"].map((name) =>
      join(stateRoot, name),
    ),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const name of ["host.mjs", "guard-seams.mjs", "entry.mjs"])
    copyFileSync(join(source, name), join(root, name));
  symlinkSync(moduleRoot, join(root, "node_modules"));
  writeFileSync(
    join(root, "keiko-governed-tools.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory(),
  );
  writeFileSync(
    join(root, "keiko-governed-tools-code-mode.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory("code-mode"),
  );
  const packetAsset = artifact.createOpenCodeServiceHostPacketDataAsset();
  writeFileSync(join(root, "keiko-host-packet-data.mjs"), packetAsset);
  const packetData = await import(
    "data:text/javascript;base64," + Buffer.from(packetAsset).toString("base64")
  );
  writeFileSync(
    join(root, "keiko-native-context.mjs"),
    generated.createGeneratedOpenCodeV2Plugins().keiko_native_context,
  );
  const config = JSON.stringify(
    profile.createFixedOpenCodeV2Config(
      {
        contextWindowTokens: 32768,
        maxInputTokens: 28672,
        maxOutputTokens: 4096,
      },
      undefined,
      toolProfile,
    ),
  );
  writeFileSync(join(stateRoot, "config", "opencode", "opencode.json"), config, { mode: 0o600 });
  const host = await import(pathToFileURL(join(root, "host.mjs")));
  const values = {
    workspace,
    stateRoot,
    password: "p".repeat(32),
    providerURL: "http://127.0.0.1:1/api/coding-sidecar/gateway/chat/completions",
    providerCapability: "a".repeat(32),
    facadeURL: "http://127.0.0.1:1/api/coding-sidecar/tool",
    facadeCapability: "b".repeat(32),
    mode: "autonomous-delivery",
    runId: "run-fixed-host-test",
    configDigest: sha(config),
    toolProfile,
  };
  const input = Object.freeze(
    Object.fromEntries(packetData.fields.map((field) => [field, values[field]])),
  );
  return {
    root,
    stateRoot,
    input,
    host,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(effect) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );
}

test("the original authenticated server retains its scoped generic-fetch guard and private SQLite IO", async () => {
  const own = await fixture();
  const previous = globalThis.fetch;
  globalThis.fetch = () => assert.fail("outbound-transport-forbidden");
  const original = globalThis.fetch;
  try {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* own.host.makeFixedOpenCodeServiceHost(own.input);
          assert.notEqual(globalThis.fetch, original);
          yield* Effect.promise(() =>
            assert.rejects(globalThis.fetch(own.input.facadeURL), /host-model-fetch-denied/),
          );
          const unauthenticated = yield* Effect.promise(() =>
            handle(new Request("http://127.0.0.1/api/info")),
          );
          assert.equal(unauthenticated.status, 401);
          const authenticated = yield* Effect.promise(() =>
            handle(
              new Request("http://127.0.0.1/api/info", {
                headers: {
                  authorization: `Basic ${Buffer.from(`opencode:${own.input.password}`).toString("base64")}`,
                },
              }),
            ),
          );
          assert.equal(authenticated.status, 200);
          yield* assertOriginalLocation(handle, own);
        }),
      ),
    );
    assert.equal(globalThis.fetch, original);
    await assert.rejects(
      run(Effect.scoped(own.host.makeFixedOpenCodeServiceHost(own.input))),
      /host-state-not-fresh/,
    );
  } finally {
    globalThis.fetch = previous;
    own.cleanup();
  }
});

test("source/module input, changed materialized config, and accessor bindings refuse before boot", async () => {
  const own = await fixture();
  const previous = globalThis.fetch;
  try {
    await assert.rejects(
      run(
        Effect.scoped(
          own.host.makeFixedOpenCodeServiceHost({ ...own.input, module: "untrusted.mjs" }),
        ),
      ),
      /host-input-invalid/,
    );
    let touched = false;
    const withAccessor = { ...own.input };
    Object.defineProperty(withAccessor, "providerURL", {
      get: () => {
        touched = true;
        return own.input.providerURL;
      },
    });
    await assert.rejects(
      run(Effect.scoped(own.host.makeFixedOpenCodeServiceHost(withAccessor))),
      /host-input-invalid/,
    );
    assert.equal(touched, false);
    writeFileSync(join(own.stateRoot, "config", "opencode", "opencode.json"), "{}");
    await assert.rejects(
      run(Effect.scoped(own.host.makeFixedOpenCodeServiceHost(own.input))),
      /host-config-invalid/,
    );
    assert.equal(globalThis.fetch, previous);
  } finally {
    own.cleanup();
  }
});

test("the pinned HTTP trace producer preserves bounded nested span headers", async () => {
  let calls = 0;
  const capability = "a".repeat(32);
  const url = "http://127.0.0.1:1/api/coding-sidecar/tool";
  const send = fixedPostTransport(
    async () => {
      calls++;
      return new Response("{}");
    },
    { url, capability },
  );
  for (const parent of [Option.none(), Option.some({ spanId: "3".repeat(16) })]) {
    const headers = HttpTraceContext.toHeaders({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      sampled: true,
      parent,
    });
    await send(url, {
      method: "POST",
      redirect: "manual",
      body: "{}",
      headers: {
        ...headers,
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
    });
  }
  assert.equal(calls, 2);
});

function assertOriginalLocation(handle, own) {
  return Effect.gen(function* () {
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${own.input.password}`).toString("base64")}`,
      "content-type": "application/json",
    };
    const created = yield* Effect.promise(() =>
      handle(
        new Request("http://127.0.0.1/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "fixed host control",
            location: { directory: own.input.workspace },
          }),
        }),
      ),
    );
    assert.equal(created.status, 200);
    const session = yield* Effect.promise(() => created.json());
    assert.equal(typeof session.data.id, "string");
    const url = new URL("http://127.0.0.1/api/agent");
    url.searchParams.set("location[directory]", own.input.workspace);
    const agents = yield* Effect.promise(() => handle(new Request(url, { headers })));
    assert.equal(agents.status, 200);
    const readyURL = new URL("http://127.0.0.1/api/integration");
    readyURL.searchParams.set("location[directory]", own.input.workspace);
    const ready = yield* Effect.promise(() => handle(new Request(readyURL, { headers })));
    assert.equal(ready.status, 200);
    const pluginsURL = new URL("http://127.0.0.1/api/plugin");
    pluginsURL.searchParams.set("location[directory]", own.input.workspace);
    const plugins = yield* Effect.promise(() => handle(new Request(pluginsURL, { headers })));
    assert.equal(plugins.status, 200);
    const list = yield* Effect.promise(() => plugins.json());
    for (const id of ["keiko.governed-tools", "keiko.native-context", "opencode.tool.read"])
      assert.equal(
        list.data.some((entry) => entry.id === id && entry.state.status === "active"),
        true,
        JSON.stringify({
          expectedId: id,
          states: list.data.map((entry) => ({ id: entry.id, status: entry.state.status })),
        }),
      );
  });
}

test("the fixed original native route graph serves authenticated routes before its owned scope closes", async () => {
  const own = await fixture();
  const previous = globalThis.fetch;
  globalThis.fetch = () => assert.fail("outbound-transport-forbidden");
  const original = globalThis.fetch;
  try {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          assert.equal(typeof own.host.makeFixedOpenCodeServiceHostRoutes, "function");
          const context = yield* own.host.makeFixedOpenCodeServiceHostRoutes(own.input);
          const app = Context.get(context, HttpRouter.HttpRouter).asHttpEffect();
          const { HttpEffect } = yield* Effect.promise(
            () => import(pathToFileURL(join(moduleRoot, "effect/dist/unstable/http/index.js"))),
          );
          const handle = HttpEffect.toWebHandlerWith(context)(app);
          const unauthenticated = yield* Effect.promise(() =>
            handle(new Request("http://127.0.0.1/api/info")),
          );
          assert.equal(unauthenticated.status, 401);
          yield* assertOriginalLocation(handle, own);
        }),
      ),
    );
    assert.equal(globalThis.fetch, original);
  } finally {
    globalThis.fetch = previous;
    own.cleanup();
  }
});

const { createRoutes } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/server/dist/routes.js"))
);
const { Bus } = await import(pathToFileURL(join(moduleRoot, "@opencode/core/dist/bus.js")));
const { PersistentPty } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/core/dist/persistent-pty.js"))
);
const { PersistentPty: PersistentPtySchema } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/schema/dist/persistent-pty.js"))
);
const { Pty } = await import(pathToFileURL(join(moduleRoot, "@opencode/schema/dist/pty.js")));
const { Session } = await import(
  pathToFileURL(join(moduleRoot, "@opencode/schema/dist/session.js"))
);
const { NodeHttpServer } = await import(
  pathToFileURL(join(moduleRoot, "@effect/platform-node/dist/index.js"))
);
const { WebSocket } = await import(pathToFileURL(join(moduleRoot, "ws/wrapper.mjs")));

function privateEnvironment(own) {
  const values = Object.fromEntries(
    ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR"].map(
      (key, index) => [
        key,
        join(own.stateRoot, ["home", "config", "data", "state", "cache", "tmp"][index]),
      ],
    ),
  );
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const key of Object.keys(values)) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = before[key];
    }
  };
}

function originalRoutes(own, overrides) {
  return createRoutes(
    {
      app: { name: "keiko-capture-control", version: "2.0.10" },
      password: own.input.password,
      database: { path: join(own.stateRoot, "opencode.db") },
      config: {
        directory: join(own.stateRoot, "config", "opencode"),
        project: false,
        content: own.config,
      },
      models: { fetch: false },
      fs: { fff: false, filewatcher: false },
    },
    () => [],
    overrides,
  ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices));
}

function observeBus(counter) {
  return Bus.node.replace(
    Bus.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, Bus.Service);
          return Layer.succeed(Bus.Service, {
            ...original,
            listen: (listener) =>
              Effect.sync(() => counter.value++).pipe(Effect.andThen(original.listen(listener))),
          });
        }),
      ),
    ),
  );
}

test("original EventFeed captures the guarded Bus before acquisition and ignores a late replacement", async () => {
  const own = await fixture();
  const restore = privateEnvironment(own);
  const early = { value: 0 };
  const late = { value: 0 };
  try {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(originalRoutes(own, [observeBus(early)]));
          const captured = early.value;
          assert.ok(captured > 0);
          const original = Context.get(context, Bus.Service);
          const lateBus = {
            ...original,
            listen: (listener) =>
              Effect.sync(() => late.value++).pipe(Effect.andThen(original.listen(listener))),
          };
          const app = Context.get(context, HttpRouter.HttpRouter)
            .asHttpEffect()
            .pipe(Effect.provideService(Bus.Service, lateBus));
          const { HttpEffect } = yield* Effect.promise(
            () => import(pathToFileURL(join(moduleRoot, "effect/dist/unstable/http/index.js"))),
          );
          const handle = HttpEffect.toWebHandlerWith(context)(app);
          yield* Effect.promise(async () => {
            const response = await handle(
              new Request("http://127.0.0.1/api/event", {
                headers: {
                  authorization: `Basic ${Buffer.from(`opencode:${own.input.password}`).toString("base64")}`,
                },
              }),
            );
            const reader = response.body.getReader();
            const frame = await reader.read();
            assert.equal(
              JSON.parse(new TextDecoder().decode(frame.value).split("\n\n")[0].slice(6)).type,
              "server.connected",
            );
            await reader.cancel();
          });
          assert.equal(early.value, captured);
          assert.equal(late.value, 0);
        }),
      ),
    );
  } finally {
    restore();
    own.cleanup();
  }
});

function controlledPty(own, observed) {
  const info = PersistentPtySchema.Info.make({
    id: Pty.ID.create(),
    sessionID: Session.ID.create(),
    title: "native upgrade control",
    command: "controlled",
    args: [],
    cwd: own.input.workspace,
    status: "running",
    pid: 0,
    foregroundProcess: null,
    size: { cols: 80, rows: 24 },
    output: { head: 0, tail: 0 },
  });
  const replacement = PersistentPty.node.replace(
    PersistentPty.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, PersistentPty.Service);
          return Layer.succeed(PersistentPty.Service, {
            ...original,
            get: (id) => {
              assert.equal(id, info.id);
              return Effect.succeed(info);
            },
            attach: (id, input) =>
              Effect.sync(() => {
                assert.equal(id, info.id);
                observed.attached++;
                return {
                  info,
                  role: input.role,
                  generation: 1,
                  replay: {
                    requestedOffset: input.cursor,
                    availableOffset: 0,
                    endOffset: 0,
                    truncated: false,
                    data: new Uint8Array(),
                  },
                  activate: () => {
                    observed.activated++;
                    input.onEvent({ type: "output", data: Buffer.from("original-native-upgrade") });
                  },
                  detach: () => {
                    observed.detached++;
                  },
                };
              }),
          });
        }),
      ),
    ),
  );
  return { info, replacement };
}

function connectNative(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const connected = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("message", (data) => messages.push(data.toString()));
  return { socket, connected, closed, messages };
}

async function waitMessages(connection, count) {
  const deadline = Date.now() + 2000;
  while (connection.messages.length < count && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connection.messages.length, count);
}

test("the original persistent PTY route retains Node upgrade, single-use tickets and native attachment finalization", async () => {
  const own = await fixture();
  const restore = privateEnvironment(own);
  const observed = { attached: 0, activated: 0, detached: 0 };
  const controlled = controlledPty(own, observed);
  const controller = new AbortController();
  const { serveFixedHostRoutes } = await import(pathToFileURL(join(own.root, "entry.mjs")));
  let url;
  const running = Effect.runPromise(
    Effect.scoped(
      serveFixedHostRoutes(
        () => Layer.build(originalRoutes(own, [controlled.replacement])),
        own.input,
        controller.signal,
        (value) => {
          url = value;
        },
      ),
    ).pipe(
      Effect.provide(NodeHttpServer.layerHttpServices),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
    { signal: controller.signal },
  );
  const stopped = assert.rejects(running);
  try {
    const deadline = Date.now() + 2000;
    while (!url && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(typeof url, "string");
    const route = `${url}/api/experimental/persistent-pty/${controlled.info.id}`;
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${own.input.password}`).toString("base64")}`,
      "x-opencode-ticket": "1",
    };
    const wrongOrigin = await fetch(route + "/connect-token", {
      method: "POST",
      headers: { ...headers, origin: "http://untrusted.invalid" },
    });
    assert.equal(wrongOrigin.status, 403);
    const missingTokenHeader = await fetch(route + "/connect-token", {
      method: "POST",
      headers: { authorization: headers.authorization },
    });
    assert.equal(missingTokenHeader.status, 403);
    const invalidTicket = await fetch(route + "/connect?ticket=invalid");
    assert.equal(invalidTicket.status, 403);
    assert.equal(observed.attached, 0);
    const tokenResponse = await fetch(route + "/connect-token", { method: "POST", headers });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    const connection = connectNative(
      route.replace("http:", "ws:") + "/connect?ticket=" + token.data.ticket,
    );
    await connection.connected;
    await waitMessages(connection, 3);
    const attached = JSON.parse(connection.messages[0]);
    assert.equal(attached.type, "attached");
    assert.equal(attached.info.id, controlled.info.id);
    assert.equal(JSON.parse(connection.messages[1]).type, "replay_complete");
    assert.equal(connection.messages[2], "original-native-upgrade");
    connection.socket.close();
    await connection.closed;
    const replay = await fetch(route + "/connect?ticket=" + token.data.ticket);
    assert.equal(replay.status, 403);
    assert.equal(observed.attached, 1);
    assert.equal(observed.activated, 1);
  } finally {
    controller.abort();
    // This test keeps an Effect-owned fiber, not a fabricated native after hook.
    await stopped;
    restore();
    own.cleanup();
  }
  assert.equal(observed.detached, 1);
});

for (const toolProfile of ["direct", "code-mode"]) {
  test(`the original native advertisement matches the fixed ${toolProfile} factory and canonical profile`, async (t) => {
    const own = await fixture(toolProfile);
    const previous = globalThis.fetch;
    let transports = 0;
    globalThis.fetch = () => {
      transports++;
      throw new Error("no-transport-qualified");
    };
    try {
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* own.host.makeFixedOpenCodeServiceHostRoutes(own.input);
            const locations = Context.get(context, LocationServiceMap.Service);
            const instance = yield* locations.contextEffect(
              Location.Ref.make({ directory: own.input.workspace }),
            );
            yield* Context.get(instance, Plugin.Service).awaitActivation;
            const tools = Context.get(instance, Tool.Service);
            const snapshot = yield* tools.snapshot(JSON.parse(own.config).permissions);
            const request = yield* nativeChat.fromRequest({
              model: {
                id: "hermetic",
                provider: "keiko-runtime",
                route: { endpoint: { baseURL: own.input.providerURL } },
              },
              system: [],
              messages: [],
              tools: snapshot.definitions,
            });
            const wire = request.tools.map((tool) => ({
              name: tool.function.name,
              parameters: tool.function.parameters,
            }));
            assert.equal(contract.hasExactOpenCodeVisibleToolContract(wire, toolProfile), true);
            assert.equal(
              contract.hasExactOpenCodeVisibleToolContract(
                wire,
                toolProfile === "direct" ? "code-mode" : "direct",
              ),
              false,
            );
            const handlers = (yield* tools.list()).filter((tool) => tool.name.startsWith("keiko_"));
            assert.equal(handlers.length, 17);
            assert.equal(
              handlers.every((tool) => tool.options.codemode === (toolProfile === "code-mode")),
              true,
            );
            if (toolProfile === "code-mode") {
              const inventory = snapshot.codeModeCatalog.tools;
              const managed = inventory.filter(
                (entry) => entry.type === "tool" && entry.name.startsWith("keiko_"),
              );
              assert.deepEqual(
                managed.map((entry) => entry.name).sort(),
                handlers.map((entry) => entry.name).sort(),
              );
              t.diagnostic(
                JSON.stringify({
                  profile: toolProfile,
                  managedCount: managed.length,
                  nativeInventoryItems: inventory.length,
                  additionalItems: inventory.length - managed.length,
                }),
              );
            }
          }),
        ),
      );
      assert.equal(transports, 0);
    } finally {
      globalThis.fetch = previous;
      own.cleanup();
    }
  });
}
