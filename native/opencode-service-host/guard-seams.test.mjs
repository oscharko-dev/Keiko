import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { fixedPostTransport, denyAmbientFetch } from "./guard-seams.mjs";

const { Response, Headers, Request, AbortController, TextEncoder } = globalThis;

const binding = {
  url: "http://127.0.0.1:1/api/coding-sidecar/tool",
  capability: "a".repeat(32),
};
function request(overrides = {}) {
  return {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${binding.capability}`, "Content-Type": "application/json" },
    body: "{}",
    ...overrides,
  };
}
test("the fixed POST capability refuses same-origin and foreign model choices before transport", async () => {
  let calls = 0;
  const send = fixedPostTransport(async () => {
    calls++;
    return new Response("{}");
  }, binding);
  for (const [url, init] of [
    ["http://127.0.0.1:1/api/health", request()],
    ["https://foreign.invalid/api/coding-sidecar/tool", request()],
    [binding.url, request({ method: "GET" })],
    [binding.url, request({ redirect: "follow" })],
    [
      binding.url,
      request({ headers: { Authorization: "Bearer other", "Content-Type": "application/json" } }),
    ],
    [binding.url, request({ headers: { ...request().headers, Origin: "http://127.0.0.1:1" } })],
    [binding.url, request({ headers: { ...request().headers, Cookie: "fixture" } })],
  ])
    await assert.rejects(send(url, init), /host-purpose-denied/);
  assert.equal(calls, 0);
  await send(binding.url, request());
  assert.equal(calls, 1);
});
test("it owns the binding, effective headers and body before asynchronous transport", async () => {
  const inputBinding = { ...binding };
  let captured;
  const send = fixedPostTransport(async (_url, init) => {
    captured = init;
    return new Response("{}");
  }, inputBinding);
  inputBinding.url = "http://127.0.0.1:1/api/health";
  inputBinding.capability = "b".repeat(32);
  const bytes = new Uint8Array([123, 125]);
  const headers = new Headers(request().headers);
  await send(binding.url, request({ headers, body: bytes }));
  bytes[0] = 0;
  headers.set("authorization", "Bearer changed");
  assert.equal(new Headers(captured.headers).get("authorization"), `Bearer ${binding.capability}`);
  assert.deepEqual(captured.body, new Uint8Array([123, 125]));
});
test("ambient generic fetch has no same-origin exception", async () => {
  await assert.rejects(denyAmbientFetch(binding.url, request()), /host-model-fetch-denied/);
});
test("malformed bindings and cancelled requests refuse before transport", async () => {
  for (const invalid of [
    { ...binding, url: "https://foreign.invalid/" },
    { ...binding, url: binding.url + "?x=1" },
    { ...binding, capability: "" },
  ])
    assert.throws(
      () => fixedPostTransport(() => assert.fail("transport"), invalid),
      /host-binding-invalid/,
    );
  const controller = new AbortController();
  controller.abort();
  const send = fixedPostTransport(() => assert.fail("transport"), binding);
  await assert.rejects(
    send(binding.url, request({ signal: controller.signal })),
    /host-purpose-denied/,
  );
});

test("an aborted Request refuses before transport without an explicit signal override", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const send = fixedPostTransport(async () => {
    calls++;
    return new Response("{}");
  }, binding);
  const input = new Request(binding.url, request({ signal: controller.signal }));
  await assert.rejects(send(input, request()), /host-purpose-denied/);
  assert.equal(calls, 0);
});

test("a live Request forwards cancellation to the pending owned transport", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const send = fixedPostTransport(async (_url, init) => {
    init.signal?.addEventListener(
      "abort",
      () => {
        cancelled = true;
      },
      { once: true },
    );
    controller.abort();
    assert.equal(init.signal?.aborted, true);
    return new Response("{}");
  }, binding);
  await send(new Request(binding.url, request({ signal: controller.signal })), request());
  assert.equal(cancelled, true);
});

test("an explicit live init signal overrides an aborted Request signal", async () => {
  const old = new AbortController();
  old.abort();
  const current = new AbortController();
  const send = fixedPostTransport(async (_url, init) => {
    assert.equal(init.signal, current.signal);
    return new Response("{}");
  }, binding);
  await send(
    new Request(binding.url, request({ signal: old.signal })),
    request({ signal: current.signal }),
  );
});

test("it preserves only the actual pinned native paired trace-header shape", async () => {
  let calls = 0;
  const send = fixedPostTransport(async () => {
    calls++;
    return new Response("{}");
  }, binding);
  const trace = `${"1".repeat(32)}-${"2".repeat(16)}`;
  const native = { ...request().headers, traceparent: `00-${trace}-01`, b3: `${trace}-1` };
  await send(binding.url, request({ headers: native }));
  for (const headers of [
    { ...native, b3: "arbitrary" },
    { ...native, b3: `${trace}-1-too-long-not-a-span` },
    { ...native, traceparent: "foreign" },
    { ...native, b3: `${trace}-0` },
    { ...request().headers, traceparent: native.traceparent },
  ])
    await assert.rejects(send(binding.url, request({ headers })), /host-purpose-denied/);
  assert.equal(calls, 1);
});

test("bindings reject accessors and unowned fields without reading them", () => {
  let touched = false;
  const accessor = { ...binding };
  Object.defineProperty(accessor, "capability", {
    get: () => {
      touched = true;
      return binding.capability;
    },
  });
  for (const invalid of [accessor, { ...binding, module: "untrusted" }])
    assert.throws(
      () => fixedPostTransport(() => assert.fail("transport"), invalid),
      /host-binding-invalid/,
    );
  assert.equal(touched, false);
});

test("a Request body cannot silently become a different empty provider request", async () => {
  const send = fixedPostTransport(() => assert.fail("transport"), binding);
  const input = new Request(binding.url, request());
  const init = request();
  Reflect.deleteProperty(init, "body");
  await assert.rejects(send(input, init), /host-purpose-denied/);
});

async function initialFixture(send) {
  const { pathToFileURL } = await import("node:url");
  const { join } = await import("node:path");
  const moduleRoot = process.env.KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT;
  if (!moduleRoot) throw new TypeError("qualified-host-test-modules-required");
  const runtime = await import(pathToFileURL(join(moduleRoot, "effect/dist/index.js")));
  const codec =
    await import("../../packages/keiko-server/dist/coding-runtime/secureWorkspaceTextReadProtocol.js");
  const { isDenied } = await import("../../packages/keiko-workspace/dist/ignore.js");
  const { createInitialInstructionBoundary } = await import("./guard-seams.mjs");
  const host = {
    workspace: "/accepted",
    stateRoot: "/accepted/.keiko/private",
    facadeURL: binding.url,
    facadeCapability: binding.capability,
    runId: "run-initial",
  };
  const phases = [];
  const fetch = fixedPostTransport(async (_url, init) => {
    const packet = JSON.parse(init.body);
    phases.push(packet.phase);
    if (packet.phase === "begin")
      return initialJSON({ ok: true, scopeId: "12345678-1234-1234-1234-123456789abc" });
    if (packet.phase === "end") return initialJSON({ ok: true });
    return send(packet, init, codec);
  }, binding);
  const owner = createInitialInstructionBoundary(host, fetch, codec, {
    ...runtime,
    isDenied,
    config: "fixed-constructor-config",
  });
  return { ...runtime, codec, host, owner, phases };
}
function initialJSON(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function initialBinary(codec, bytes, info = { type: "file", size: bytes.length, mtimeMs: 0 }) {
  const frame = codec.encodeSecureWorkspaceNativeResponse({ status: "ok", info, bytes });
  return new Response(frame, {
    status: 200,
    headers: { "content-type": "application/octet-stream", "content-length": String(frame.length) },
  });
}
function unavailableFilesystem(Effect) {
  return {
    exists: () => Effect.die(new Error("ambient-exists-forbidden")),
    readFileString: () => Effect.die(new Error("ambient-content-forbidden")),
    realPath: () => Effect.die(new Error("ambient-realpath-forbidden")),
  };
}

test("initial scope copies a real canonical decoder view before wiping the frame", async () => {
  const own = await initialFixture((_packet, _init, codec) =>
    initialBinary(codec, new TextEncoder().encode("original instruction")),
  );
  const { Effect } = own;
  const fs = own.owner.filesystem(unavailableFilesystem(Effect));
  const result = await Effect.runPromise(
    Effect.scoped(own.owner.wrap(() => fs.readFileString("/accepted/AGENTS.md"))({})),
  );
  assert.equal(result, "original instruction");
  assert.deepEqual(own.phases, ["begin", "readBytes", "end"]);
});

test("a captured original fiber context and a replayed generation cannot reopen initial authority", async () => {
  const own = await initialFixture((_packet, _init, codec) =>
    initialBinary(codec, new Uint8Array()),
  );
  const { Effect } = own;
  const fs = own.owner.filesystem(unavailableFilesystem(Effect));
  let context;
  const wrapped = own.owner.wrap(() =>
    Effect.gen(function* () {
      context = yield* Effect.context();
      return yield* fs.exists("/accepted/AGENTS.md");
    }),
  );
  assert.equal(await Effect.runPromise(Effect.scoped(wrapped({}))), true);
  const before = own.phases.length;
  await assert.rejects(
    Effect.runPromise(fs.exists("/accepted/AGENTS.md").pipe(Effect.provideContext(context))),
  );
  await assert.rejects(Effect.runPromise(Effect.scoped(wrapped({}))));
  assert.equal(own.phases.length, before);
});

test("closed bootstrap permits only constructor-owned metadata and already attested config text", async () => {
  const own = await initialFixture(() => assert.fail("initial IO"));
  const { Effect } = own;
  let metadata = 0;
  const fs = own.owner.filesystem({
    ...unavailableFilesystem(Effect),
    exists: () => Effect.succeed(false),
    realPath: (path) => {
      metadata++;
      return Effect.succeed(path);
    },
  });
  assert.equal(
    await Effect.runPromise(
      fs.readFileString(own.host.stateRoot + "/config/opencode/opencode.json"),
    ),
    "fixed-constructor-config",
  );
  assert.equal(
    await Effect.runPromise(fs.realPath(own.host.stateRoot + "/home")),
    own.host.stateRoot + "/home",
  );
  for (const path of [
    "/accepted/AGENTS.md",
    "/foreign/AGENTS.md",
    own.host.stateRoot + "/config/opencode/AGENTS.md",
  ])
    await assert.rejects(Effect.runPromise(fs.readFileString(path)));
  await assert.rejects(Effect.runPromise(fs.realPath("/foreign")));
  assert.equal(metadata, 1);
  assert.deepEqual(own.phases, []);
});

test("technical refusal remains an error while genuine absence is false", async () => {
  for (const reason of ["not-found", "process-failed", "preflight-refused"]) {
    const own = await initialFixture(() => initialJSON({ ok: false, reason }, 409));
    const { Effect } = own;
    const fs = own.owner.filesystem(unavailableFilesystem(Effect));
    const work = Effect.runPromise(
      Effect.scoped(own.owner.wrap(() => fs.exists("/accepted/AGENTS.md"))({})),
    );
    if (reason === "not-found") assert.equal(await work, false);
    else await assert.rejects(work);
    assert.deepEqual(own.phases, ["begin", "stat", "end"]);
  }
});

test("outside root, malformed response and oversized frame refuse inside the real bracket", async () => {
  const own = await initialFixture(() => assert.fail("workspace escape IO"));
  const { Effect } = own;
  const fs = own.owner.filesystem(unavailableFilesystem(Effect));
  await assert.rejects(
    Effect.runPromise(Effect.scoped(own.owner.wrap(() => fs.exists("/foreign/AGENTS.md"))({}))),
  );
  assert.deepEqual(own.phases, ["begin", "end"]);
  for (const response of [
    initialJSON({ ok: true, unexpected: "not-a-scope" }),
    new Response("", {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "67108897" },
    }),
  ]) {
    const bad = await initialFixture(() => response);
    const file = bad.owner.filesystem(unavailableFilesystem(bad.Effect));
    await assert.rejects(
      bad.Effect.runPromise(
        bad.Effect.scoped(bad.owner.wrap(() => file.exists("/accepted/AGENTS.md"))({})),
      ),
    );
    assert.deepEqual(bad.phases, ["begin", "stat", "end"]);
  }
});

test("interruption closes before end and withholds bytes from an uncooperative response", async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const own = await initialFixture(async (_packet, _init, codec) => {
    entered();
    await deferred;
    return initialBinary(codec, new TextEncoder().encode("late instruction"));
  });
  const { Effect } = own;
  const fs = own.owner.filesystem(unavailableFilesystem(Effect));
  const controller = new AbortController();
  const work = Effect.runPromise(
    Effect.scoped(own.owner.wrap(() => fs.readFileString("/accepted/AGENTS.md"))({})),
    { signal: controller.signal },
  );
  const stopped = assert.rejects(work);
  await started;
  controller.abort();
  await stopped;
  assert.deepEqual(own.phases, ["begin", "readBytes", "end"]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(Effect.runPromise(fs.readFileString("/accepted/AGENTS.md")));
  assert.deepEqual(own.phases, ["begin", "readBytes", "end"]);
});

test("startup-only metadata proves a nested canonical root and permanently closes at instruction end", async () => {
  const own = await initialFixture((_packet, _init, codec) =>
    initialBinary(codec, new Uint8Array()),
  );
  const { Effect } = own;
  let metadata = 0;
  const fs = own.owner.filesystem({
    ...unavailableFilesystem(Effect),
    realPath: (path) => {
      metadata++;
      return Effect.succeed(path);
    },
  });
  assert.equal(await Effect.runPromise(fs.realPath("/accepted/deep")), "/accepted/deep");
  const work = own.owner.wrap(() => fs.exists("/accepted/AGENTS.md"));
  assert.equal(await Effect.runPromise(Effect.scoped(work({}))), true);
  for (const path of ["/accepted", "/accepted/deep", own.host.stateRoot + "/home"])
    await assert.rejects(Effect.runPromise(fs.realPath(path)));
  assert.equal(metadata, 1);
  assert.deepEqual(own.phases, ["begin", "stat", "end"]);
});

test("startup metadata rejects denied namespaces and canonical link escapes before any content IO", async () => {
  const own = await initialFixture(() => assert.fail("content IO"));
  const { Effect } = own;
  let metadata = 0;
  const fs = own.owner.filesystem({
    ...unavailableFilesystem(Effect),
    realPath: () => {
      metadata++;
      return Effect.succeed("/foreign/target");
    },
  });
  for (const path of ["/foreign", "/accepted/.git", "/accepted/nested/.env", "/accepted/.ssh"])
    await assert.rejects(Effect.runPromise(fs.realPath(path)));
  assert.equal(metadata, 0);
  await assert.rejects(Effect.runPromise(fs.realPath("/accepted/link")));
  assert.equal(metadata, 1);
  assert.deepEqual(own.phases, []);
});

test("a pending constructor metadata resolution is refused once the genuine initial scope closes", async () => {
  const own = await initialFixture((_packet, _init, codec) =>
    initialBinary(codec, new Uint8Array()),
  );
  const { Effect } = own;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const fs = own.owner.filesystem({
    ...unavailableFilesystem(Effect),
    realPath: () => Effect.promise(() => pending),
  });
  const result = Effect.runPromise(fs.realPath("/accepted/deep"));
  const refused = assert.rejects(result);
  await Effect.runPromise(
    Effect.scoped(own.owner.wrap(() => fs.exists("/accepted/AGENTS.md"))({})),
  );
  release("/accepted/deep");
  await refused;
  await assert.rejects(
    Effect.runPromise(fs.readFileString(own.host.stateRoot + "/config/opencode/opencode.json")),
  );
  assert.deepEqual(own.phases, ["begin", "stat", "end"]);
});

test("a live original scoped child inherits the permanently closed initial reference", async () => {
  const own = await initialFixture((_packet, _init, codec) =>
    initialBinary(codec, new Uint8Array()),
  );
  const { Effect, Deferred, Exit } = own;
  const fs = own.owner.filesystem(unavailableFilesystem(Effect));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const trigger = yield* Deferred.make();
        const settled = yield* Deferred.make();
        yield* own.owner.wrap(() =>
          Effect.gen(function* () {
            yield* Deferred.await(trigger).pipe(
              Effect.andThen(fs.exists("/accepted/AGENTS.md")),
              Effect.exit,
              Effect.flatMap((exit) => Deferred.succeed(settled, exit)),
              Effect.forkScoped,
            );
            return yield* fs.exists("/accepted/AGENTS.md");
          }),
        )({});
        assert.deepEqual(own.phases, ["begin", "stat", "end"]);
        yield* Deferred.succeed(trigger, undefined);
        const exit = yield* Deferred.await(settled);
        assert.equal(Exit.isFailure(exit), true);
        assert.deepEqual(own.phases, ["begin", "stat", "end"]);
      }),
    ),
  );
});
