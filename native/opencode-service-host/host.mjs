import { createHash, webcrypto } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerFetch } from "@opencode/server/fetch";
import { requestExecutor } from "@opencode/core/effect/app-node-platform";
import { RequestExecutor } from "@opencode/ai/route/executor";
import { Tool } from "@opencode/core/tool";
import { Plugin } from "@opencode/core/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import createGovernedPlugin from "./keiko-governed-tools.mjs";
import nativeContextPlugin from "./keiko-native-context.mjs";
import {
  fixedPostTransport,
  denyAmbientFetch,
  decorateRequestExecutor,
  decorateSnapshot,
} from "./guard-seams.mjs";

/**
 * Inactive fixed bootstrap API for a separately attested external payload. It is not a CLI/packet
 * selector or launch authorization. The existing manager, current-authority IO and real facade
 * drain must bind it before activation; the original service owns task execution and SQLite IO.
 * These two generated imports are fixed builder assets, never input/module locators.
 */
export function makeFixedOpenCodeServiceHost(input) {
  return Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => acquireHost(input)),
      (owned) => Effect.sync(() => owned.release()),
    );
    return yield* ServerFetch.make(
      {
        app: { name: "keiko-opencode-service-host", version: "2.0.10" },
        password: host.binding.password,
        database: { path: join(host.binding.stateRoot, "opencode.db") },
        config: {
          directory: join(host.binding.stateRoot, "config", "opencode"),
          project: false,
          content: host.config,
        },
        models: { fetch: false },
        fs: { fff: false, filewatcher: false },
      },
      { overrides: host.overrides },
    );
  });
}

function acquireHost(input) {
  const binding = copyHostBinding(input);
  const config = readFixedConfig(binding);
  if (existsSync(join(binding.stateRoot, "opencode.db"))) throw new Error("host-state-not-fresh");
  const rawFetch = globalThis.fetch;
  if (rawFetch === denyAmbientFetch) throw new Error("host-already-owned");
  const providerFetch = fixedPostTransport(rawFetch, {
    url: binding.providerURL,
    capability: binding.providerCapability,
  });
  const facadeFetch = fixedPostTransport(rawFetch, {
    url: binding.facadeURL,
    capability: binding.facadeCapability,
  });
  const overrides = fixedOverrides(binding, providerFetch, facadeFetch);
  const environment = hostEnvironment(binding);
  const before = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  globalThis.fetch = denyAmbientFetch;
  return {
    binding,
    config,
    overrides,
    release: () => {
      if (globalThis.fetch === denyAmbientFetch) globalThis.fetch = rawFetch;
      for (const key of Object.keys(environment)) {
        if (process.env[key] !== environment[key]) continue;
        if (before[key] === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = before[key];
      }
    },
  };
}

function copyHostBinding(input) {
  const binding = copyHostFields(input);
  validateHostRoots(binding);
  validateHostScalars(binding);
  if (
    binding.providerCapability === binding.facadeCapability ||
    new URL(binding.providerURL).origin !== new URL(binding.facadeURL).origin
  )
    throw new TypeError("host-input-invalid");
  return Object.freeze(binding);
}

function copyHostFields(input) {
  const names = [
    "workspace",
    "stateRoot",
    "password",
    "providerURL",
    "providerCapability",
    "facadeURL",
    "facadeCapability",
    "mode",
    "runId",
    "configDigest",
  ];
  if (!input || Reflect.ownKeys(input).length !== names.length)
    throw new TypeError("host-input-invalid");
  return Object.fromEntries(
    names.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string")
        throw new TypeError("host-input-invalid");
      return [key, descriptor.value];
    }),
  );
}

function validateHostRoots(binding) {
  for (const key of ["workspace", "stateRoot"])
    if (!isAbsolute(binding[key]) || realpathSync(binding[key]) !== binding[key])
      throw new TypeError("host-root-invalid");
}

function validateHostScalars(binding) {
  const modes = new Set(["governed-assist", "supervised-coding", "autonomous-delivery"]);
  if (
    !/^[a-f0-9]{64}$/u.test(binding.configDigest) ||
    binding.password.length < 32 ||
    binding.password.length > 128 ||
    !modes.has(binding.mode) ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(binding.runId)
  )
    throw new TypeError("host-input-invalid");
}

function readFixedConfig(binding) {
  const file = openSync(
    join(binding.stateRoot, "config", "opencode", "opencode.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("host-config-invalid");
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== binding.configDigest)
      throw new Error("host-config-invalid");
    const config = JSON.parse(bytes.toString("utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      "plugins" in config ||
      "plugin" in config
    )
      throw new Error("host-config-invalid");
    return bytes.toString("utf8");
  } finally {
    closeSync(file);
  }
}

function hostEnvironment(binding) {
  return Object.freeze({
    HOME: join(binding.stateRoot, "home"),
    XDG_CONFIG_HOME: join(binding.stateRoot, "config"),
    XDG_DATA_HOME: join(binding.stateRoot, "data"),
    XDG_STATE_HOME: join(binding.stateRoot, "state"),
    XDG_CACHE_HOME: join(binding.stateRoot, "cache"),
    TMPDIR: join(binding.stateRoot, "tmp"),
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    KEIKO_MODEL_GATEWAY_URL: binding.providerURL.replace(/\/chat\/completions$/u, ""),
    KEIKO_MODEL_GATEWAY_CAPABILITY: binding.providerCapability,
  });
}

function fixedOverrides(binding, providerFetch, facadeFetch) {
  let owner;
  const runtime = fixedRuntime(binding, facadeFetch, (value) => {
    if (owner !== undefined) throw new Error("host-owner-already-bound");
    owner = value;
  });
  const plugins = [createGovernedPlugin(runtime), nativeContextPlugin].map((plugin) => ({
    ...fromPromise(plugin),
    revision: "keiko-fixed-host-v1",
    source: { type: "builtin" },
  }));
  return [
    providerOverride(providerFetch),
    toolOverride(() => {
      if (owner === undefined) throw new Error("host-owner-unavailable");
      return owner;
    }),
    pluginOverride(plugins),
  ];
}

function fixedRuntime(binding, facadeFetch, bindOwner) {
  return Object.freeze({
    process: Object.freeze({
      env: Object.freeze({
        KEIKO_CODING_MODE: binding.mode,
        KEIKO_CODING_RUN_ID: binding.runId,
        KEIKO_TOOL_FACADE_URL: binding.facadeURL,
        KEIKO_TOOL_FACADE_CAPABILITY: binding.facadeCapability,
      }),
    }),
    crypto: webcrypto,
    fetch: facadeFetch,
    bindOwner,
  });
}

function providerOverride(fetch) {
  return requestExecutor.replace(
    requestExecutor.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) =>
          Layer.succeed(
            RequestExecutor.Service,
            decorateRequestExecutor(
              Context.get(context, RequestExecutor.Service),
              fetch,
              Effect,
              FetchHttpClient,
            ),
          ),
        ),
      ),
    ),
  );
}

function toolOverride(currentOwner) {
  return Tool.node.replace(
    Tool.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, Tool.Service);
          return Layer.succeed(Tool.Service, {
            ...original,
            snapshot: (...args) =>
              original
                .snapshot(...args)
                .pipe(Effect.map((snapshot) => decorateSnapshot(snapshot, currentOwner(), Effect))),
          });
        }),
      ),
    ),
  );
}

function pluginOverride(plugins) {
  return Plugin.node.replace(
    Plugin.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, Plugin.Service);
          return Layer.succeed(Plugin.Service, {
            ...original,
            activate: (native, failures) => original.activate([...native, ...plugins], failures),
          });
        }),
      ),
    ),
  );
}
