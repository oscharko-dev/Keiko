// Reuse the existing lab's native BFF lifecycle, pairing, proxy and credential resolver.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  cpSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { createChaosProxy, createChaosState } from "./chaos-proxy.mjs";
import { importBuilt, REPO_ROOT } from "./lab-common.mjs";
import { startObservedBff, listenProxy, responseObservation } from "../chat-skills-lab/runtime.mjs";

export function continuityResponseObservation(raw) {
  const observed = responseObservation(raw);
  const usage = Object.fromEntries(
    ["prompt_tokens", "completion_tokens", "total_tokens"]
      .filter((key) => Number.isSafeInteger(observed.usage?.[key]) && observed.usage[key] >= 0)
      .map((key) => [key, observed.usage[key]]),
  );
  const known = new Set(["stop", "length", "tool_calls", "function_call", "content_filter"]);
  const finishReason =
    observed.finishReason == null
      ? null
      : known.has(observed.finishReason)
        ? observed.finishReason
        : "other";
  return {
    usage: Object.keys(usage).length ? usage : null,
    finishReason,
    responseKind: finishReason === "other" ? "unrecognized-finish-reason" : observed.responseKind,
  };
}

export async function continuityRequestTimeouts(providers) {
  const { bufferedCallBudgetMs, streamedCallBudgetMs } = await importBuilt(
    "keiko-model-gateway",
    "resilience.js",
  );
  return Object.fromEntries(
    providers.map((provider) => [
      provider.modelId,
      Math.min(
        Math.max(bufferedCallBudgetMs(provider, 0), streamedCallBudgetMs(provider, 0)) + 1000,
        2147483647,
      ),
    ]),
  );
}

export function privateContinuityOutput(path) {
  const resolved = resolve(path);
  const candidate = join(realpathSync(dirname(resolved)), basename(resolved));
  const local = relative(realpathSync(REPO_ROOT), candidate);
  if (local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)))
    throw new TypeError("external-output-required");
  return candidate;
}

export async function snapshotContinuityState(source, target) {
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(join(target, "ui"), { mode: 0o700 });
  const path = join(target, "ui", "keiko-ui.db");
  const database = new DatabaseSync(join(source, "ui", "keiko-ui.db"), { readOnly: true });
  try {
    await backup(database, path);
    chmodSync(path, 0o600);
  } finally {
    database.close();
  }
  for (const name of ["evidence", "memory"])
    if (existsSync(join(source, name)))
      cpSync(join(source, name), join(target, name), { recursive: true });
}

function observeResponse(res, row) {
  const chunks = [];
  let bytes = 0;
  const capture = (chunk) => {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes <= 2000000) chunks.push(Buffer.from(chunk));
  };
  const write = res.write.bind(res),
    end = res.end.bind(res);
  res.write = (chunk, ...args) => {
    capture(chunk);
    return write(chunk, ...args);
  };
  res.end = (chunk, ...args) => {
    capture(chunk);
    return end(chunk, ...args);
  };
  res.on("close", () => {
    Object.assign(row, { status: res.statusCode, durationMs: Date.now() - row.startedAt });
    try {
      if (bytes > 2000000) throw new Error("bounded-response-observation");
      Object.assign(row, continuityResponseObservation(Buffer.concat(chunks).toString("utf8")));
    } catch {
      row.responseKind = "interrupted-or-invalid";
    }
  });
}

export async function configuredContinuityModels(configPath, env = process.env) {
  const { loadConfigFromFile } = await importBuilt("keiko-model-gateway", "index.js");
  const { createProviderSecretResolver } = await importBuilt("keiko-server", "credentialVault.js");
  const config = loadConfigFromFile(configPath, env, {
    secretResolver: createProviderSecretResolver({ configPath, env }),
  });
  return config.providers.filter(
    (provider) =>
      config.capabilities.find((entry) => entry.id === provider.modelId)?.kind === "chat",
  );
}

function providerEnvironment(configPath, providers, config, port, dir, inherited) {
  const env = { ...inherited };
  const upstream = new URL(providers[0].baseUrl);
  for (const provider of providers) {
    if (new URL(provider.baseUrl).origin !== upstream.origin)
      throw new Error("continuity-lab-requires-one-configured-gateway");
    env[`KEIKO_MODEL_${provider.modelId.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_API_KEY`] =
      provider.apiKey;
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  raw.providers = raw.providers
    .filter((entry) => providers.some((p) => p.modelId === entry.modelId))
    .map((entry) => {
      const { apiKey: _key, apiKeySecretRef: _reference, ...safe } = entry;
      return { ...safe, baseUrl: `http://127.0.0.1:${port}${new URL(entry.baseUrl).pathname}` };
    });
  raw.capabilities = raw.capabilities.filter((entry) =>
    providers.some((p) => p.modelId === entry.id),
  );
  writeFileSync(config, JSON.stringify(raw), { mode: 0o600 });
  const project = realpathSync(join(dir, "synthetic-project"));
  return {
    project,
    env: {
      ...env,
      KEIKO_STATE_DIR: join(dir, "state"),
      KEIKO_UI_DATA_DIR: join(dir, "ui"),
      KEIKO_MEMORY_DIR: join(dir, "memory"),
      KEIKO_EVIDENCE_DIR: join(dir, "evidence"),
      KEIKO_CONFIG_FILE: config,
      KEIKO_INITIAL_PROJECT_PATH: project,
      KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: randomBytes(32).toString("hex"),
    },
  };
}

export async function startContinuityRuntime(dir, configPath, physical, options = {}) {
  const { pathIsDenied } = await importBuilt("keiko-server", "files-deny.js");
  if (pathIsDenied(join(dir, "synthetic-project")))
    throw new TypeError("qualification-source-location-denied");
  const inherited = options.env ?? process.env;
  const providers = await configuredContinuityModels(configPath, inherited);
  if (providers.length === 0) throw new Error("no-configured-chat-models");
  options.signal?.throwIfAborted();
  const requestTimeoutByModel = await continuityRequestTimeouts(providers);
  const requestTimeoutMs = Math.max(...Object.values(requestTimeoutByModel));
  const upstream = new URL(providers[0].baseUrl);
  if (
    upstream.protocol !== "http:" ||
    !new Set(["localhost", "127.0.0.1", "[::1]"]).has(upstream.hostname)
  )
    throw new Error("continuity-lab-requires-configured-loopback-gateway");
  mkdirSync(join(dir, "synthetic-project"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "synthetic-project", "concept.md"),
    "# Synthetic source\nThe source inspection label is amber. This source supplies no conversation agreements.\n",
  );
  const observed = observedProxy(upstream, physical);
  const { proxy } = observed;
  await listenProxy(proxy);
  const runtime = await startObservedBff(dir, proxy, {}, 0, async (_dir, port) =>
    providerEnvironment(
      configPath,
      providers,
      join(dir, "gateway.private.json"),
      options.port ?? port,
      dir,
      inherited,
    ),
  );
  if (options.signal?.aborted) {
    await runtime.close();
    options.signal.throwIfAborted();
  }
  return continuityRuntimeView(runtime, {
    dir,
    providers,
    physical,
    observed,
    options,
    requestTimeoutByModel,
    requestTimeoutMs,
  });
}

function continuityRuntimeView(
  runtime,
  { dir, providers, physical, observed, options, requestTimeoutByModel, requestTimeoutMs },
) {
  const { proxy } = observed;
  return {
    ...runtime,
    dir,
    proxyPort: options.port ?? proxy.address().port,
    models: providers.map((entry) => entry.modelId),
    physical,
    requestTimeoutByModel,
    request: (method, path, body, requestOptions = {}) =>
      runtime.bff.request(method, path, body, {
        timeoutMs: requestTimeoutByModel[body?.modelId] ?? requestTimeoutMs,
        signal: options.signal,
        ...requestOptions,
      }),
    setActive: observed.setActive,
    drain: () => drainRequests(physical, requestTimeoutMs, options.signal),
    restart: async () => {
      options.signal?.throwIfAborted();
      await runtime.bff.stop();
      options.signal?.throwIfAborted();
      await runtime.bff.start();
    },
  };
}

function observedProxy(upstream, physical) {
  let active = "setup";
  const proxy = createChaosProxy({
    upstream: { host: upstream.hostname, port: Number(upstream.port || 80) },
    state: createChaosState(),
    log: () => undefined,
    logError: () => physical.push({ caseId: active, error: "upstream-failed" }),
  });
  proxy.on("request", (req, res) => {
    if (!req.url.endsWith("/chat/completions")) return;
    const row = { caseId: active, startedAt: Date.now() };
    physical.push(row);
    observeResponse(res, row);
  });
  return {
    proxy,
    setActive: (id) => {
      active = id;
    },
  };
}

export async function drainRequests(physical, budgetMs, signal) {
  signal?.throwIfAborted();
  const deadline = globalThis.performance.now() + budgetMs;
  while (physical.some((row) => row.startedAt && row.status === undefined)) {
    if (globalThis.performance.now() >= deadline)
      throw new Error("continuity-provider-drain-timeout");
    await delay(100, undefined, { signal });
  }
}
