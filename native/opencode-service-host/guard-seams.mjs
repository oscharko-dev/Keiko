import { isAbsolute, join, relative, resolve } from "node:path";
/** Fixed host capabilities. No native planner, interpreter or transport algorithm is replaced. */
export function fixedPostTransport(raw, inputBinding) {
  const binding = copyBinding(inputBinding);
  return async (input, init) => {
    const request = ownedRequest(input, init, binding);
    return raw(binding.url, request);
  };
}

const { Headers, Request, AbortSignal } = globalThis;

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
  const signal = effectiveSignal(input, init);
  if (url !== binding.url || !validRequestInit(input, init, signal))
    throw new Error("host-purpose-denied");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  if (!validHeaders(headers, binding)) throw new Error("host-purpose-denied");
  return {
    method: "POST",
    redirect: "manual",
    signal,
    headers: Object.fromEntries(headers),
    ...ownedBody(init.body),
  };
}

function effectiveSignal(input, init) {
  return init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
}

function validRequestInit(input, init, signal) {
  return (
    init?.method === "POST" &&
    init.redirect === "manual" &&
    !signal?.aborted &&
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

const INITIAL_REQUEST_TIMEOUT_MS = 30_000;
const PRIVATE_RESULT_MAX_BYTES = 4096;
const INITIAL_REFUSALS = new Set([
  "invalid-request",
  "initialization-closed",
  "initialization-refused",
  "initialization-failed",
  "cancelled",
  "timeout",
  "busy",
  "unsupported-platform",
  "workspace-unavailable",
  "artifact-unverified",
  "process-failed",
  "protocol-invalid",
  "denied",
  "not-found",
  "not-text",
  "too-large",
  "unstable",
  "native-io-unavailable",
  "preflight-refused",
  "postflight-refused",
  "exception",
]);

/** The actual first plugin effect owns one permanently closed reference, including child fibers. */
export function createInitialInstructionBoundary(binding, fetch, codec, runtime) {
  const { Context, Effect } = runtime;
  const reference = Context.Reference("keiko.native.initial-instructions", {
    defaultValue: () => undefined,
  });
  const environment = {
    ...runtime,
    binding,
    fetch,
    codec,
    reference,
    privateMetadata: privateHostMetadata(binding),
    startupMetadata: { open: true },
  };
  let attempted = false;
  const acquire = () =>
    Effect.suspend(() => {
      if (attempted) return Effect.succeed({ open: false });
      attempted = true;
      return Effect.tryPromise({
        try: (signal) => initializationRequest(binding, fetch, codec, "begin", {}, signal),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: (cause) => {
            environment.startupMetadata.open = false;
            return { open: false, cause };
          },
          onSuccess: (result) => {
            if (result.ok && typeof result.scopeId === "string")
              return { open: true, id: result.scopeId };
            environment.startupMetadata.open = false;
            return { open: false };
          },
        }),
      );
    });
  return {
    wrap: (original) => (context) =>
      Effect.acquireUseRelease(
        acquire(),
        (state) => original(context).pipe(Effect.provideService(reference, state)),
        (state) => closeInitialState(state, environment),
      ),
    filesystem: (original) => initialFilesystem(original, environment),
  };
}

function closeInitialState(state, { Effect, binding, fetch, codec, startupMetadata }) {
  return Effect.promise(async () => {
    state.open = false;
    startupMetadata.open = false;
    if (state.id === undefined) return;
    const result = await initializationRequest(binding, fetch, codec, "end", { scopeId: state.id });
    if (!result.ok) throw new Error("host-initialization-close-unproven");
  });
}

async function initializationRequest(binding, fetch, codec, phase, fields = {}, callerSignal) {
  const timeout = AbortSignal.timeout(INITIAL_REQUEST_TIMEOUT_MS);
  const signal = callerSignal === undefined ? timeout : AbortSignal.any([timeout, callerSignal]);
  const response = await fetch(binding.facadeURL, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      authorization: `Bearer ${binding.facadeCapability}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "native-initialization",
      phase,
      runId: binding.runId,
      ...fields,
    }),
  });
  return initializationResponse(response, phase, codec, signal);
}

async function initializationResponse(response, phase, codec, signal) {
  const binary = response.headers.get("content-type") === "application/octet-stream";
  const maxBytes = binary
    ? codec.SECURE_WORKSPACE_NATIVE_MAX_RESPONSE_BYTES
    : PRIVATE_RESULT_MAX_BYTES;
  if (binary && response.headers.get("content-length") === null)
    throw new Error("host-initialization-response-invalid");
  const frame = await boundedResponseBytes(response, maxBytes, signal);
  try {
    if (!binary)
      return ownedInitializationResult(JSON.parse(frame.toString("utf8")), phase, response.status);
    if (response.status !== 200 || phase === "begin" || phase === "end")
      throw new Error("host-initialization-response-invalid");
    return ownedInitialBinary(codec.decodeSecureWorkspaceNativeResponse(frame), phase, codec);
  } finally {
    frame.fill(0);
  }
}

function ownedInitialBinary(decoded, phase, codec) {
  if (decoded.status !== "ok")
    return {
      ok: false,
      reason: decoded.status,
      ...("info" in decoded ? { info: decoded.info } : {}),
    };
  // The canonical decoder returns a view. The consumer owns a copy before wiping its frame.
  const bytes = new Uint8Array(decoded.bytes);
  if (phase === "readBytes") return { ok: true, info: decoded.info, bytes };
  try {
    if (phase === "list")
      return {
        ok: true,
        info: decoded.info,
        entries: codec.decodeSecureWorkspaceNativeDirectory(bytes),
      };
    if (phase !== "stat" || bytes.length !== 0)
      throw new Error("host-initialization-response-invalid");
    return { ok: true, info: decoded.info };
  } finally {
    bytes.fill(0);
  }
}

function ownedInitializationResult(value, phase, status) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("host-initialization-response-invalid");
  const keys = Object.keys(value);
  if (status === 200) return successfulInitialJSON(value, phase, keys.length);
  if (value.ok === false && keys.length === 2 && INITIAL_REFUSALS.has(value.reason))
    return { ok: false, reason: value.reason };
  throw new Error("host-initialization-response-invalid");
}

function successfulInitialJSON(value, phase, keyCount) {
  if (phase === "end" && value.ok === true && keyCount === 1) return { ok: true };
  if (
    phase === "begin" &&
    value.ok === true &&
    keyCount === 2 &&
    typeof value.scopeId === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.scopeId)
  )
    return { ok: true, scopeId: value.scopeId };
  throw new Error("host-initialization-response-invalid");
}

function responseFrameSize(response, maxBytes) {
  const length = response.headers.get("content-length");
  const size = length === null ? maxBytes : Number(length);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
    throw new Error("host-initialization-response-too-large");
  return { size, exact: length !== null };
}

async function boundedResponseBytes(response, maxBytes, signal) {
  const { size, exact } = responseFrameSize(response, maxBytes);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("host-initialization-response-invalid");
  const frame = Buffer.alloc(size);
  try {
    return await readInitialFrame(reader, frame, exact, signal);
  } catch (error) {
    frame.fill(0);
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readInitialFrame(reader, frame, exact, signal) {
  let offset = 0;
  while (true) {
    if (signal.aborted) throw new Error("host-initialization-cancelled");
    const next = await reader.read();
    if (signal.aborted) throw new Error("host-initialization-cancelled");
    if (next.done) break;
    if (offset + next.value.length > frame.length)
      throw new Error("host-initialization-response-too-large");
    frame.set(next.value, offset);
    offset += next.value.length;
  }
  if (exact && offset !== frame.length) throw new Error("host-initialization-response-invalid");
  return frame.subarray(0, offset);
}

function initialFilesystem(original, environment) {
  return {
    ...original,
    exists: (path) => initialExists(path, environment),
    readFileString: (path) => initialReadFileString(path, original, environment),
    realPath: (path) => initialRealPath(path, original, environment),
  };
}

function runInitialIO(phase, path, environment) {
  const { Effect, reference, binding, fetch, codec, PlatformError } = environment;
  return Effect.gen(function* () {
    const state = yield* reference;
    if (state?.open !== true)
      return yield* Effect.fail(initialUnavailable(phase, "closed", PlatformError, state?.cause));
    const relativePath = initialRelativePath(binding.workspace, path);
    if (relativePath === undefined)
      return yield* Effect.fail(initialUnavailable(phase, "denied", PlatformError));
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        initializationRequest(
          binding,
          fetch,
          codec,
          phase,
          { scopeId: state.id, relativePath },
          signal,
        ),
      catch: (cause) => initialUnavailable(phase, "technical", PlatformError, cause),
    });
    if (!state.open) {
      if (result.ok && "bytes" in result) result.bytes.fill(0);
      return yield* Effect.fail(initialUnavailable(phase, "closed", PlatformError));
    }
    return result;
  });
}

function initialExists(path, environment) {
  const { Effect, PlatformError } = environment;
  return runInitialIO("stat", path, environment).pipe(
    Effect.flatMap((result) => {
      if (result.ok) return Effect.succeed(true);
      if (result.reason === "not-found") return Effect.succeed(false);
      return Effect.fail(initialUnavailable("exists", result.reason, PlatformError));
    }),
  );
}

function initialReadFileString(path, original, environment) {
  const { Effect, reference, binding, config, PlatformError } = environment;
  return Effect.gen(function* () {
    const state = yield* reference;
    if (
      state === undefined &&
      environment.startupMetadata.open &&
      path === join(binding.stateRoot, "config", "opencode", "opencode.json")
    )
      return config;
    if (
      state === undefined &&
      environment.startupMetadata.open &&
      path === join(binding.stateRoot, "config", "opencode", "opencode.jsonc")
    ) {
      const exists = yield* original.exists(path);
      return yield* Effect.fail(
        initialUnavailable(
          "readFileString",
          exists ? "unapproved-config" : "not-found",
          PlatformError,
        ),
      );
    }
    const result = yield* runInitialIO("readBytes", path, environment);
    if (!result.ok)
      return yield* Effect.fail(initialUnavailable("readFileString", result.reason, PlatformError));
    try {
      return Buffer.from(result.bytes).toString("utf8");
    } finally {
      result.bytes.fill(0);
    }
  });
}

function initialRelativePath(root, path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return undefined;
  const value = relative(root, path);
  return value === ".." || value.startsWith("../") || isAbsolute(value) ? undefined : value;
}

function initialRealPath(path, original, environment) {
  const { Effect, reference, privateMetadata, PlatformError } = environment;
  return Effect.gen(function* () {
    const state = yield* reference;
    if (state === undefined && environment.startupMetadata.open)
      return yield* initialStartupRealPath(path, original, environment);
    if (state?.open !== true)
      return yield* Effect.fail(initialUnavailable("realPath", "closed", PlatformError));
    if (privateMetadata.has(path))
      return yield* privateInitialMetadata(path, original, environment, () => state.open);
    const result = yield* runInitialIO("stat", path, environment);
    if (!result.ok)
      return yield* Effect.fail(initialUnavailable("realPath", result.reason, PlatformError));
    if (result.info.type === "symlink")
      return yield* Effect.fail(initialUnavailable("realPath", "denied", PlatformError));
    return path;
  });
}

function initialStartupRealPath(path, original, environment) {
  const { Effect, binding, privateMetadata, PlatformError, isDenied } = environment;
  return Effect.gen(function* () {
    if (privateMetadata.has(path))
      return yield* privateInitialMetadata(
        path,
        original,
        environment,
        () => environment.startupMetadata.open,
      );
    const lexical = initialRelativePath(binding.workspace, path);
    if (lexical === undefined || isDenied(lexical))
      return yield* Effect.fail(initialUnavailable("realPath", "denied", PlatformError));
    const canonical = yield* original.realPath(path);
    const resolved = initialRelativePath(binding.workspace, canonical);
    if (resolved === undefined || isDenied(resolved) || !environment.startupMetadata.open)
      return yield* Effect.fail(initialUnavailable("realPath", "denied", PlatformError));
    return canonical;
  });
}

function privateInitialMetadata(path, original, environment, isOpen) {
  const { Effect, PlatformError } = environment;
  return Effect.gen(function* () {
    const canonical = yield* original.realPath(path);
    if (canonical !== path || !isOpen())
      return yield* Effect.fail(initialUnavailable("realPath", "denied", PlatformError));
    return canonical;
  });
}

function initialUnavailable(method, reason, PlatformError, cause) {
  return new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: reason === "not-found" ? "NotFound" : "Unknown",
      module: "FileSystem",
      method,
      ...(cause === undefined ? {} : { cause }),
    }),
  );
}

function privateHostMetadata(binding) {
  return new Set([
    binding.stateRoot,
    ...[
      "home",
      "home/.agents",
      "home/.claude",
      "home/.opencode",
      "config",
      "config/opencode",
      "config/opencode/AGENTS.md",
      "config/opencode/opencode.json",
      "config/opencode/opencode.jsonc",
      "data",
      "state",
      "cache",
      "tmp",
    ].map((name) => join(binding.stateRoot, name)),
  ]);
}
