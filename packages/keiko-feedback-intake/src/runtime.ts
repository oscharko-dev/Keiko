import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Pool } from "pg";
import { FEEDBACK_INTAKE_REPORT_PATH_V1 } from "@oscharko-dev/keiko-contracts/feedback-intake";
import { FileSecretProvider } from "./file-secret-provider.js";
import {
  FeedbackPublicationRuntime,
  type FeedbackPublicationRuntimeOptions,
} from "./feedback-publication-runtime.js";
import type { FeedbackPublicationDiagnostic } from "./feedback-publication-worker.js";
import { PostgresFeedbackPublicationQuery } from "./feedback-publication-query.js";
import { PostgresFeedbackPublicationRepository } from "./feedback-publication-store.js";
import { createFeedbackIntakeHttpHandler } from "./http.js";
import type { MaintainerRuntimeConfig } from "./maintainer-config.js";
import type { MaintainerHttpOptions } from "./maintainer-http.js";
import type { MaintainerPublicationService } from "./maintainer-publication-http.js";
import type { MaintainerOidcClient } from "./maintainer-oidc.js";
import {
  createMaintainerRuntimeServer,
  loadFeedbackRuntimeConfigs,
  type MaintainerRuntimeServer,
} from "./maintainer-runtime.js";
import { applyFeedbackMigrations, type FeedbackMigration } from "./migrations.js";
import { PostgresIntakeRepository, type PgClientLike } from "./postgres.js";
import { createPostgresFeedbackIntake } from "./production-service.js";
import type { HostedRuntimeConfig } from "./runtime-config.js";
import {
  createRuntimePools,
  endPublicationPools,
  endRequestPools,
  endRuntimePools,
  type RuntimePool,
  type RuntimePoolFactory,
  type RuntimePools,
} from "./runtime-pools.js";
import {
  assertRepositoryKeyCustody,
  snapshotIndependentKeyCustody,
} from "./runtime-key-custody.js";
import { defaultRuntimeTimer, type RuntimeTimer } from "./runtime-timer.js";
import type { ContentFreeLogger, ContentFreeMetrics } from "./types.js";

type RuntimeServer = MaintainerRuntimeServer;
export interface RuntimeHealthState {
  dependenciesHealthy: boolean;
  publicationHealthy: boolean;
  running: boolean;
}

interface PublicationRuntimeLike {
  inspectReadiness(): Promise<void>;
  start(): void;
  stop(deadlineAt?: number): Promise<void>;
}

export interface HostedFeedbackIntakeRuntime {
  ready(): boolean;
  publicationReady(): boolean;
  runRetention(): Promise<void>;
  stop(): Promise<void>;
}

export interface HostedRuntimeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: (() => Date) | undefined;
  readonly logger?: ContentFreeLogger | undefined;
  readonly metrics?: ContentFreeMetrics | undefined;
  readonly poolFactory?: RuntimePoolFactory | undefined;
  readonly serverFactory?:
    ((handler: (req: IncomingMessage, res: ServerResponse) => void) => RuntimeServer) | undefined;
  readonly timer?: RuntimeTimer | undefined;
  readonly migrationSource?: (() => Promise<string>) | undefined;
  readonly migrationSources?: (() => Promise<readonly FeedbackMigration[]>) | undefined;
  readonly maintainerOidcClient?: MaintainerOidcClient | undefined;
  readonly maintainerDiagnostics?: MaintainerHttpOptions["diagnostics"];
  readonly publicationDiagnostics?: ((event: FeedbackPublicationDiagnostic) => void) | undefined;
  readonly publicationRuntimeFactory?:
    ((options: FeedbackPublicationRuntimeOptions) => PublicationRuntimeLike) | undefined;
}

function defaultPool(
  databaseUrl: string,
  max: number,
  connectionTimeoutMillis: number,
): RuntimePool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis,
    query_timeout: connectionTimeoutMillis,
  });
  return {
    connect: async (): Promise<PgClientLike> => {
      const client = await pool.connect();
      return {
        query: (text, values) => client.query(text, values === undefined ? [] : [...values]),
        release: (error?: Error): void => {
          client.release(error);
        },
      };
    },
    end: () => pool.end(),
  };
}

function defaultServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): RuntimeServer {
  return createServer(handler);
}

function migrationSources(
  options: HostedRuntimeOptions,
): () => Promise<readonly FeedbackMigration[]> {
  if (options.migrationSources !== undefined) return options.migrationSources;
  if (options.migrationSource !== undefined) {
    return async () => [{ version: 1, source: (await options.migrationSource?.()) ?? "" }];
  }
  const definitions = [
    [1, "feedback_intake"],
    [2, "feedback_review"],
    [3, "feedback_publication"],
    [4, "feedback_publication_worker"],
    [5, "feedback_publication_circuit"],
  ] as const;
  return async () =>
    Promise.all(
      definitions.map(async ([version, name]) => ({
        version,
        source: await readFile(
          new URL(`../migrations/${String(version).padStart(3, "0")}_${name}.sql`, import.meta.url),
          "utf8",
        ),
      })),
    );
}

function listen(server: RuntimeServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    server.once?.("error", onError);
    try {
      server.listen(port, host, () => {
        if (settled) return;
        settled = true;
        server.removeListener?.("error", onError);
        resolve();
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error("Feedback listener failed"));
    }
  });
}

function close(server: RuntimeServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function closeBounded(server: RuntimeServer, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const forced = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, deadlineMs);
  });
  try {
    await Promise.race([close(server), forced]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function publicationStatus(
  health: RuntimeHealthState,
  enabled: boolean,
): { readonly statusCode: number; readonly status: "disabled" | "ok" | "unavailable" } {
  if (!health.running) return { statusCode: 503, status: "unavailable" };
  if (!enabled) return { statusCode: 200, status: "disabled" };
  return health.publicationHealthy
    ? { statusCode: 200, status: "ok" }
    : { statusCode: 503, status: "unavailable" };
}

export function createManagementHandler(health: RuntimeHealthState, publicationEnabled: boolean) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const response = managementResponse(req, health, publicationEnabled);
    const body = Buffer.from(JSON.stringify({ status: response.status }));
    res.writeHead(response.statusCode, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    });
    res.end(body);
  };
}

function managementResponse(
  req: IncomingMessage,
  health: RuntimeHealthState,
  publicationEnabled: boolean,
): { readonly statusCode: number; readonly status: "disabled" | "ok" | "unavailable" } {
  if (req.method !== "GET") return { statusCode: 404, status: "unavailable" };
  if (req.url === "/ready/publication") return publicationStatus(health, publicationEnabled);
  if (req.url === "/live") {
    const statusCode = health.running ? 200 : 503;
    return { statusCode, status: statusCode === 200 ? "ok" : "unavailable" };
  }
  if (req.url === "/ready") {
    const statusCode = isReady(health) ? 200 : 503;
    return { statusCode, status: statusCode === 200 ? "ok" : "unavailable" };
  }
  return { statusCode: 404, status: "unavailable" };
}

function isReady(health: RuntimeHealthState): boolean {
  return health.running && health.dependenciesHealthy;
}

function rejectUnavailablePost(req: IncomingMessage, res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ error: "temporarily-unavailable" }));
  if (!req.complete && !req.destroyed) {
    req.pause();
    res.shouldKeepAlive = false;
    res.setHeader("Connection", "close");
    res.once("finish", () => {
      const timer = setTimeout(() => req.destroy(), 100);
      timer.unref();
    });
  }
  res.writeHead(503, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

interface RuntimeSurface {
  readonly intake: RuntimeServer;
  readonly management: RuntimeServer;
  readonly maintainer?: RuntimeServer | undefined;
  readonly repository: PostgresIntakeRepository;
  readonly abuseKeys: FileSecretProvider;
  readonly dedupeKeys: FileSecretProvider;
  readonly logger: ContentFreeLogger;
  readonly publication?: PublicationRuntimeLike | undefined;
}

function composeSurface(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pool: RuntimePool,
  health: RuntimeHealthState,
  now: () => Date,
): RuntimeSurface {
  const abuseKeys = new FileSecretProvider({
    directory: join(config.secretDirectory, "abuse"),
    kind: "abuse",
    now,
  });
  const dedupeKeys = new FileSecretProvider({
    directory: join(config.secretDirectory, "dedupe"),
    kind: "dedupe",
    now,
  });
  const at = now();
  snapshotIndependentKeyCustody(abuseKeys, dedupeKeys, at);
  const repository = new PostgresIntakeRepository(pool, 3, config.limits.storageDeadlineMs);
  const logger = options.logger ?? { event: (): void => undefined };
  const metrics = options.metrics ?? { increment: (): void => undefined };
  const service = createPostgresFeedbackIntake({
    repository,
    limits: config.limits,
    abuseKeys,
    dedupeKeys,
    now,
    logger,
    metrics,
    onUnavailable: () => {
      health.dependenciesHealthy = false;
    },
  });
  const route = createFeedbackIntakeHttpHandler({
    service,
    limits: config.limits,
    proxy: { family: config.proxyFamily, trustedCidrs: config.trustedProxyCidrs },
  });
  const factory = options.serverFactory ?? defaultServer;
  const intake = factory((req, res) => {
    if (!isReady(health) && req.method === "POST" && req.url === FEEDBACK_INTAKE_REPORT_PATH_V1) {
      rejectUnavailablePost(req, res);
      return;
    }
    void route(req, res);
  });
  const management = factory(createManagementHandler(health, config.publication.enabled));
  return { intake, management, repository, abuseKeys, dedupeKeys, logger };
}

async function retention(
  surface: RuntimeSurface,
  health: RuntimeHealthState,
  now: Date,
): Promise<void> {
  health.dependenciesHealthy = false;
  try {
    await surface.repository.purge(now);
    await surface.abuseKeys.purgeRetired(
      now,
      (keyId) => surface.repository.keyInUse("abuse", keyId, now),
      surface.repository,
    );
    await surface.dedupeKeys.purgeRetired(
      now,
      (keyId) => surface.repository.keyInUse("dedupe", keyId, now),
      surface.repository,
    );
    await assertRepositoryKeyCustody(
      surface.repository,
      surface.abuseKeys,
      surface.dedupeKeys,
      now,
    );
    health.dependenciesHealthy = true;
  } catch (error) {
    health.dependenciesHealthy = false;
    surface.logger.event("unavailable");
    throw error;
  }
}

async function stopServers(surface: RuntimeSurface, config: HostedRuntimeConfig): Promise<void> {
  const servers = [
    closeBounded(surface.intake, config.drainDeadlineMs),
    closeBounded(surface.management, config.drainDeadlineMs),
  ];
  if (surface.maintainer !== undefined) {
    servers.push(closeBounded(surface.maintainer, config.drainDeadlineMs));
  }
  await Promise.all(servers);
}

function createPublicationRuntime(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pools: RuntimePools,
  timer: RuntimeTimer,
  now: () => Date,
  health: RuntimeHealthState,
): PublicationRuntimeLike | undefined {
  if (!config.publication.enabled) return undefined;
  const primaryPool = pools.publicationPrimary;
  const sessionPool = pools.publicationSessions;
  if (primaryPool === undefined || sessionPool === undefined) {
    throw new Error("Publication database pools were not initialized");
  }
  const factory =
    options.publicationRuntimeFactory ??
    ((value: FeedbackPublicationRuntimeOptions): PublicationRuntimeLike =>
      new FeedbackPublicationRuntime(value));
  return factory({
    config: config.publication,
    primaryPool,
    sessionPool,
    timer,
    drainDeadlineMs: config.drainDeadlineMs,
    now,
    diagnostics: options.publicationDiagnostics,
    onHealthChange: (healthy): void => {
      health.publicationHealthy = healthy;
    },
  });
}

async function createConfiguredMaintainer(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pools: RuntimePools,
  maintainerConfig: MaintainerRuntimeConfig,
  now: () => Date,
): Promise<MaintainerRuntimeServer | undefined> {
  if (!maintainerConfig.enabled) return undefined;
  if (pools.maintainer === undefined) {
    throw new Error("Maintainer database pool was not initialized");
  }
  return createMaintainerRuntimeServer({
    config: maintainerConfig,
    runtimeConfig: config,
    pool: pools.maintainer,
    publication: maintainerPublicationService(config, pools, maintainerConfig),
    now,
    oidc: options.maintainerOidcClient,
    diagnostics: options.maintainerDiagnostics,
    serverFactory: options.serverFactory,
  });
}

function maintainerPublicationService(
  config: HostedRuntimeConfig,
  pools: RuntimePools,
  maintainerConfig: Extract<MaintainerRuntimeConfig, { readonly enabled: true }>,
): MaintainerPublicationService | undefined {
  if (!config.publication.enabled) return undefined;
  const publication = config.publication;
  const pool = pools.publicationPrimary;
  if (pool === undefined) throw new Error("Publication database pool was not initialized");
  const resolve = (key: string) => publication.github.targets.get(key)?.snapshot;
  return {
    query: new PostgresFeedbackPublicationQuery(pool, resolve),
    repository: new PostgresFeedbackPublicationRepository(
      pool,
      maintainerConfig.permissionPolicyVersion,
      resolve,
    ),
  };
}

async function initializeSurface(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pools: RuntimePools,
  health: RuntimeHealthState,
  now: () => Date,
  maintainerConfig: MaintainerRuntimeConfig,
  timer: RuntimeTimer,
): Promise<RuntimeSurface> {
  let surface: RuntimeSurface | undefined;
  try {
    await applyFeedbackMigrations(pools.intake, await migrationSources(options)());
    surface = composeSurface(options, config, pools.intake, health, now);
    const maintainer = await createConfiguredMaintainer(
      options,
      config,
      pools,
      maintainerConfig,
      now,
    );
    surface = { ...surface, maintainer };
    await retention(surface, health, now());
    const publication = createPublicationRuntime(options, config, pools, timer, now, health);
    if (publication !== undefined) {
      await publication.inspectReadiness();
      health.publicationHealthy = true;
    }
    surface = { ...surface, publication };
    await listen(surface.management, config.managementPort, config.managementHost);
    await listen(surface.intake, config.port, config.host);
    if (surface.maintainer !== undefined && maintainerConfig.enabled) {
      await listen(surface.maintainer, maintainerConfig.port, maintainerConfig.host);
    }
    health.running = true;
    surface.publication?.start();
    return surface;
  } catch (error) {
    if (surface !== undefined) await stopServers(surface, config).catch(() => undefined);
    await endRuntimePools(pools);
    throw error;
  }
}

interface RetentionSchedule {
  readonly handle: unknown;
  run(): Promise<void>;
  active(): Promise<void>;
}

function scheduleRetention(
  surface: RuntimeSurface,
  health: RuntimeHealthState,
  config: HostedRuntimeConfig,
  timer: RuntimeTimer,
  now: () => Date,
): RetentionSchedule {
  let active = Promise.resolve();
  const run = (): Promise<void> => {
    const next = active.catch(() => undefined).then(() => retention(surface, health, now()));
    active = next;
    return next;
  };
  const handle = timer.setInterval(() => {
    void run().catch(() => undefined);
  }, config.retentionIntervalMs);
  return { handle, run, active: () => active };
}

async function stopRuntime(
  surface: RuntimeSurface,
  pools: RuntimePools,
  config: HostedRuntimeConfig,
  activeRetention: Promise<void>,
): Promise<void> {
  let failure: unknown;
  const publicationDeadlineAt = Date.now() + config.drainDeadlineMs;
  failure = await captureShutdownFailure(
    () => surface.publication?.stop(publicationDeadlineAt) ?? Promise.resolve(),
    failure,
  );
  failure = await captureShutdownFailure(
    () => endPublicationPools(pools, publicationDeadlineAt),
    failure,
  );
  await activeRetention.catch(() => undefined);
  failure = await captureShutdownFailure(() => stopServers(surface, config), failure);
  failure = await captureShutdownFailure(() => endRequestPools(pools), failure);
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw new Error("Feedback runtime shutdown failed");
}

async function captureShutdownFailure(
  operation: () => Promise<void>,
  previous: unknown,
): Promise<unknown> {
  try {
    await operation();
    return previous;
  } catch (error) {
    return previous ?? error;
  }
}

async function runtimePools(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  maintainerConfig: MaintainerRuntimeConfig,
): Promise<RuntimePools> {
  return createRuntimePools(
    options.poolFactory ?? defaultPool,
    config.databaseUrl,
    config.limits.concurrency + config.limits.receiptConcurrency,
    config.limits.storageDeadlineMs,
    maintainerConfig.enabled,
    config.publication.enabled ? config.publication.maxConcurrentDeliveries : 0,
  );
}

export async function startHostedFeedbackIntake(
  options: HostedRuntimeOptions,
): Promise<HostedFeedbackIntakeRuntime> {
  const now = options.now ?? ((): Date => new Date());
  const { config, maintainerConfig } = loadFeedbackRuntimeConfigs(options.env, options, now());
  const health: RuntimeHealthState = {
    dependenciesHealthy: false,
    publicationHealthy: false,
    running: false,
  };
  const timer = options.timer ?? defaultRuntimeTimer();
  const pools = await runtimePools(options, config, maintainerConfig);
  const surface = await initializeSurface(
    options,
    config,
    pools,
    health,
    now,
    maintainerConfig,
    timer,
  );
  const retentionSchedule = scheduleRetention(surface, health, config, timer, now);
  let stopped = false;
  return {
    ready: (): boolean => isReady(health),
    publicationReady: (): boolean =>
      health.running && config.publication.enabled && health.publicationHealthy,
    runRetention: () =>
      health.running
        ? retentionSchedule.run()
        : Promise.reject(new Error("Feedback intake is stopped")),
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      health.running = false;
      health.publicationHealthy = false;
      timer.clearInterval(retentionSchedule.handle);
      await stopRuntime(surface, pools, config, retentionSchedule.active());
    },
  };
}
