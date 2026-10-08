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

const { Request, Response } = globalThis;

const moduleRoot = process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT;
if (!moduleRoot) throw new TypeError("qualified-host-test-modules-required");
const { Effect, References, Option } = await import(
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
const { HttpTraceContext } = await import(
  pathToFileURL(join(moduleRoot, "effect/dist/unstable/http/index.js"))
);
const { fixedPostTransport } = await import("./guard-seams.mjs");
const source = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
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
  for (const name of ["host.mjs", "guard-seams.mjs"])
    copyFileSync(join(source, name), join(root, name));
  symlinkSync(moduleRoot, join(root, "node_modules"));
  writeFileSync(
    join(root, "keiko-governed-tools.mjs"),
    generated.createGeneratedOpenCodeV2HostFactory(),
  );
  writeFileSync(
    join(root, "keiko-native-context.mjs"),
    generated.createGeneratedOpenCodeV2Plugins().keiko_native_context,
  );
  const config = JSON.stringify(
    profile.createFixedOpenCodeV2Config({
      contextWindowTokens: 32768,
      maxInputTokens: 28672,
      maxOutputTokens: 4096,
    }),
  );
  writeFileSync(join(stateRoot, "config", "opencode", "opencode.json"), config, { mode: 0o600 });
  const host = await import(pathToFileURL(join(root, "host.mjs")));
  const input = Object.freeze({
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
  });
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
