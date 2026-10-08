/** Fixed host capabilities. No native planner, interpreter or transport algorithm is replaced. */
export function fixedPostTransport(raw, inputBinding) {
  const binding = copyBinding(inputBinding);
  return async (input, init) => {
    const request = ownedRequest(input, init, binding);
    return raw(binding.url, request);
  };
}

const { Headers, Request } = globalThis;

function copyBinding(input) {
  if (!input || Reflect.ownKeys(input).length !== 2) throw new TypeError("host-binding-invalid");
  const values = ["url", "capability"].map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string")
      throw new TypeError("host-binding-invalid");
    return descriptor.value;
  });
  const [urlText, capability] = values;
  const url = new URL(urlText);
  if (!validBindingURL(url, urlText) || capability.length < 32 || capability.length > 4096)
    throw new TypeError("host-binding-invalid");
  return Object.freeze({ url: url.href, authorization: `Bearer ${capability}` });
}

function validBindingURL(url, text) {
  return (
    url.href === text &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function ownedRequest(input, init, binding) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  if (url !== binding.url || !validRequestInit(input, init)) throw new Error("host-purpose-denied");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  if (!validHeaders(headers, binding)) throw new Error("host-purpose-denied");
  return {
    method: "POST",
    redirect: "manual",
    signal: init.signal,
    headers: Object.fromEntries(headers),
    ...ownedBody(init.body),
  };
}

function validRequestInit(input, init) {
  return (
    init?.method === "POST" &&
    init.redirect === "manual" &&
    !init.signal?.aborted &&
    !(input instanceof Request && input.body !== null && init.body === undefined)
  );
}

function ownedBody(body) {
  if (body === undefined) return {};
  if (typeof body === "string") return { body };
  if (body instanceof Uint8Array) return { body: new Uint8Array(body) };
  throw new Error("host-purpose-denied");
}

function validHeaders(headers, binding) {
  const allowed = new Set(["authorization", "content-type", "b3", "traceparent"]);
  return (
    headers.get("authorization") === binding.authorization &&
    headers.get("content-type") === "application/json" &&
    [...headers.keys()].every((name) => allowed.has(name)) &&
    validNativeTrace(headers)
  );
}

// The pinned Effect HttpClient produces both headers together, after request preparation.
function validNativeTrace(headers) {
  const trace = headers.get("traceparent");
  const b3 = headers.get("b3");
  if (trace === null && b3 === null) return true;
  const matched = /^00-([a-f0-9]{32})-([a-f0-9]{16})-(00|01)$/u.exec(trace ?? "");
  if (matched === null) return false;
  const prefix = `${matched[1]}-${matched[2]}-${matched[3] === "01" ? "1" : "0"}`;
  return b3 === prefix || new RegExp(`^${prefix}-[a-f0-9]{16}$`, "u").test(b3 ?? "");
}

export function denyAmbientFetch() {
  return Promise.reject(new Error("host-model-fetch-denied"));
}

/** Supply Fetch only at the original provider RequestExecutor's actual execution boundary. */
export function decorateRequestExecutor(original, fetch, Effect, FetchHttpClient) {
  return {
    ...original,
    execute: (request, middleware) =>
      original
        .execute(request, middleware)
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        ),
  };
}

/** The original Snapshot.execute retains all work and results; Scope closes its existing owner. */
export function decorateSnapshot(original, owner, Effect) {
  return {
    ...original,
    execute: (input) =>
      Effect.acquireUseRelease(
        Effect.sync(() => ({ sessionID: input.sessionID, id: input.call.id })),
        () => original.execute(input),
        (context) => Effect.sync(() => owner.close(context)),
      ),
  };
}
