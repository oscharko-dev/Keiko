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
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, FileSystem, Layer, PlatformError } from "effect";
import { FSUtil } from "@opencode/util/fs-util";
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction";
import { InstructionDiscovery } from "@opencode/core/instruction-discovery";
import * as nativeCodec from "./keiko-native-file-io-codec.mjs";
import { isDenied } from "./keiko-workspace-path-policy/ignore.js";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerFetch } from "@opencode/server/fetch";
import { createRoutes } from "@opencode/server/routes";
import { NodeHttpServer } from "@effect/platform-node";
import { SessionRestart } from "@opencode/core/session/execution/restart";
import { runFixedHostEntry } from "./entry.mjs";
import { requestExecutor } from "@opencode/core/effect/app-node-platform";
import { RequestExecutor } from "@opencode/ai/route/executor";
import { Tool } from "@opencode/core/tool";
import { Plugin } from "@opencode/core/plugin";
import { fromPromise } from "@opencode/plugin/promise/adapter";
import createGovernedPlugin from "./keiko-governed-tools.mjs";
import createGovernedCodeModePlugin from "./keiko-governed-tools-code-mode.mjs";
import { fields, profiles } from "./keiko-host-packet-data.mjs";

import nativeContextPlugin from "./keiko-native-context.mjs";
import {
  fixedPostTransport,
  denyAmbientFetch,
  decorateRequestExecutor,
  decorateSnapshot,
  createInitialInstructionBoundary,
} from "./guard-seams.mjs";

const governedFactories = Object.freeze({
  direct: createGovernedPlugin,
  "code-mode": createGovernedCodeModePlugin,
});

/**
 * Inactive fixed bootstrap API for a separately attested external payload. It is not a CLI/packet
 * selector or launch authorization. The existing manager, current-authority IO and real facade
 * drain must bind it before activation; the original service owns task execution and SQLite IO.
 * These generated imports are fixed builder assets, never input/module locators.
 */
export function makeFixedOpenCodeServiceHost(input) {
  return Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => acquireHost(input)),
      (owned) => Effect.sync(() => owned.release()),
    );
    return yield* ServerFetch.make(hostOptions(host), { overrides: host.overrides });
  });
}

/** The original published graph acquires replacements before its consumers capture services. */
export function makeFixedOpenCodeServiceHostRoutes(input) {
  return Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => acquireHost(input)),
      (owned) => Effect.sync(() => owned.release()),
    );
    const context = yield* Layer.build(
      createRoutes(hostOptions(host), () => [], host.overrides).pipe(
        Layer.provideMerge(NodeHttpServer.layerHttpServices),
      ),
    );
    yield* Effect.forkScoped(Context.get(context, SessionRestart.Service).resumeSuspendedSessions);
    return context;
  });
}

function hostOptions(host) {
  return {
    app: { name: "keiko-opencode-service-host", version: "2.0.10" },
    password: host.binding.password,
    database: { path: join(host.binding.stateRoot, "state", "opencode.db") },
    config: {
      directory: join(host.binding.stateRoot, "config", "opencode"),
      project: false,
      content: host.config,
    },
    models: { fetch: false },
    fs: { fff: false, filewatcher: false },
  };
}

function acquireHost(input) {
  const binding = copyHostBinding(input);
  const config = readFixedConfig(binding);
  if (existsSync(join(binding.stateRoot, "state", "opencode.db")))
    throw new Error("host-state-not-fresh");
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
  const overrides = fixedOverrides(binding, providerFetch, facadeFetch, config);
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
  if (!input || Reflect.ownKeys(input).length !== fields.length)
    throw new TypeError("host-input-invalid");
  return Object.fromEntries(
    fields.map((key) => {
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
    !profiles.includes(binding.toolProfile) ||
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

function fixedOverrides(binding, providerFetch, facadeFetch, config) {
  let owner;
  const runtime = fixedRuntime(binding, facadeFetch, (value) => {
    if (owner !== undefined) throw new Error("host-owner-already-bound");
    owner = value;
  });
  const initial = createInitialInstructionBoundary(binding, facadeFetch, nativeCodec, {
    Context,
    Effect,
    PlatformError,
    isDenied,
    config,
  });
  const plugins = [governedFactories[binding.toolProfile](runtime), nativeContextPlugin].map(
    (plugin) => ({
      ...fromPromise(plugin),
      revision: "keiko-fixed-host-v1",
      source: { type: "builtin" },
    }),
  );
  return [
    providerOverride(providerFetch),
    toolOverride(() => {
      if (owner === undefined) throw new Error("host-owner-unavailable");
      return owner;
    }),
    initialFilesystemOverride(initial),
    InstructionDiscovery.node.replace(
      InstructionDiscovery.configured({ project: true, global: false }),
    ),
    pluginOverride(plugins, initial),
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

function guardedToolService(original, currentOwner) {
  return {
    ...original,
    snapshot: (...args) =>
      original
        .snapshot(...args)
        .pipe(Effect.map((snapshot) => decorateSnapshot(snapshot, currentOwner(), Effect))),
  };
}

function toolOverride(currentOwner) {
  return Tool.node.replace(
    Tool.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, Tool.Service);
          return Layer.succeed(Tool.Service, guardedToolService(original, currentOwner));
        }),
      ),
    ),
  );
}

function guardedPluginService(original, plugins, initial) {
  return {
    ...original,
    activate: (native, failures) =>
      original.activate(
        [...native.map((generation) => initialGeneration(generation, initial)), ...plugins],
        failures,
      ),
  };
}

function pluginOverride(plugins, initial) {
  return Plugin.node.replace(
    Plugin.node.mapLayer((layer) =>
      layer.pipe(
        Layer.flatMap((context) => {
          const original = Context.get(context, Plugin.Service);
          return Layer.succeed(Plugin.Service, guardedPluginService(original, plugins, initial));
        }),
      ),
    ),
  );
}

function initialGeneration(generation, initial) {
  // PluginInternal.list owns the service-capturing effect wrapper for this builtin generation.
  if (
    generation.id !== ConfigInstructionPlugin.Plugin.id ||
    generation.revision !== "internal" ||
    generation.source?.type !== "builtin"
  )
    return generation;
  return { ...generation, effect: initial.wrap(generation.effect) };
}

/** Preserve original up/resolve/readFileStringSafe closures over the decorated dependency. */
function initialFilesystemOverride(initial) {
  return FSUtil.node.replace(
    FSUtil.node.mapLayer((original) =>
      Layer.unwrap(
        Effect.gen(function* () {
          const filesystem = yield* FileSystem.FileSystem;
          return original.pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, initial.filesystem(filesystem))),
          );
        }),
      ),
    ),
  );
}

function makeFixedHostEntry(input) {
  return Effect.suspend(() => {
    const binding = copyHostBinding(input);
    if (realpathSync(process.cwd()) !== binding.workspace)
      return Effect.fail(new TypeError("host-workspace-mismatch"));
    return makeFixedOpenCodeServiceHostRoutes(binding);
  });
}

// The attested program remains this exact fixed entry; no packet/env field chooses executable code.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runFixedHostEntry(makeFixedHostEntry);
