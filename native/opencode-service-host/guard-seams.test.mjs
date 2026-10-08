import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedPostTransport, denyAmbientFetch } from "./guard-seams.mjs";

const { Response, Headers, Request, AbortController } = globalThis;

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
