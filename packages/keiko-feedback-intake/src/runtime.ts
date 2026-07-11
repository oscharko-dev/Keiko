import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Pool } from "pg";
import { FEEDBACK_INTAKE_REPORT_PATH_V1 } from "@oscharko-dev/keiko-contracts/feedback-intake";
import { FileSecretProvider } from "./file-secret-provider.js";
import { createFeedbackIntakeHttpHandler } from "./http.js";
import type { MaintainerRuntimeConfig } from "./maintainer-config.js";
import type { MaintainerHttpOptions } from "./maintainer-http.js";
import type { MaintainerOidcClient } from "./maintainer-oidc.js";
import {
  createMaintainerRuntimeServer,
  loadFeedbackRuntimeConfigs,
  type MaintainerRuntimeServer,
} from "./maintainer-runtime.js";
import { applyFeedbackMigrations, type FeedbackMigration } from "./migrations.js";
import { PostgresIntakeRepository, type PgClientLike, type PgPoolLike } from "./postgres.js";
import { createPostgresFeedbackIntake } from "./production-service.js";
import type { HostedRuntimeConfig } from "./runtime-config.js";
import {
  assertRepositoryKeyCustody,
  snapshotIndependentKeyCustody,
} from "./runtime-key-custody.js";
import { defaultRuntimeTimer, type RuntimeTimer } from "./runtime-timer.js";
import type { ContentFreeLogger, ContentFreeMetrics } from "./types.js";

interface RuntimePool extends PgPoolLike {
  end(): Promise<void>;
}
type RuntimeServer = MaintainerRuntimeServer;
interface RuntimeHealth {
  dependenciesHealthy: boolean;
  running: boolean;
}

export interface HostedFeedbackIntakeRuntime {
  ready(): boolean;
  runRetention(): Promise<void>;
  stop(): Promise<void>;
}

export interface HostedRuntimeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: (() => Date) | undefined;
  readonly logger?: ContentFreeLogger | undefined;
  readonly metrics?: ContentFreeMetrics | undefined;
  readonly poolFactory?:
    ((databaseUrl: string, max: number, connectTimeoutMs: number) => RuntimePool) | undefined;
  readonly serverFactory?:
    ((handler: (req: IncomingMessage, res: ServerResponse) => void) => RuntimeServer) | undefined;
  readonly timer?: RuntimeTimer | undefined;
  readonly migrationSource?: (() => Promise<string>) | undefined;
  readonly migrationSources?: (() => Promise<readonly FeedbackMigration[]>) | undefined;
  readonly maintainerOidcClient?: MaintainerOidcClient | undefined;
  readonly maintainerDiagnostics?: MaintainerHttpOptions["diagnostics"];
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
        release: (): void => {
          client.release();
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
  return async () =>
    Promise.all(
      [1, 2].map(async (version) => ({
        version,
        source: await readFile(
          new URL(
            `../migrations/${String(version).padStart(3, "0")}_${version === 1 ? "feedback_intake" : "feedback_review"}.sql`,
            import.meta.url,
          ),
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

function managementHandler(health: RuntimeHealth) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const live = req.method === "GET" && req.url === "/live";
    const ready = req.method === "GET" && req.url === "/ready";
    const status = live
      ? health.running
        ? 200
        : 503
      : ready
        ? isReady(health)
          ? 200
          : 503
        : 404;
    const body = Buffer.from(JSON.stringify({ status: status === 200 ? "ok" : "unavailable" }));
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    });
    res.end(body);
  };
}

function isReady(health: RuntimeHealth): boolean {
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
}

function composeSurface(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pool: RuntimePool,
  health: RuntimeHealth,
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
  const management = factory(managementHandler(health));
  return { intake, management, repository, abuseKeys, dedupeKeys, logger };
}

async function retention(surface: RuntimeSurface, health: RuntimeHealth, now: Date): Promise<void> {
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

async function initializeSurface(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pool: RuntimePool,
  health: RuntimeHealth,
  now: () => Date,
  maintainerConfig: MaintainerRuntimeConfig,
): Promise<RuntimeSurface> {
  let surface: RuntimeSurface | undefined;
  try {
    await applyFeedbackMigrations(pool, await migrationSources(options)());
    surface = composeSurface(options, config, pool, health, now);
    const maintainer = maintainerConfig.enabled
      ? await createMaintainerRuntimeServer({
          config: maintainerConfig,
          runtimeConfig: config,
          pool,
          now,
          oidc: options.maintainerOidcClient,
          diagnostics: options.maintainerDiagnostics,
          serverFactory: options.serverFactory,
        })
      : undefined;
    surface = { ...surface, maintainer };
    await retention(surface, health, now());
    await listen(surface.management, config.managementPort, config.managementHost);
    await listen(surface.intake, config.port, config.host);
    if (surface.maintainer !== undefined && maintainerConfig.enabled) {
      await listen(surface.maintainer, maintainerConfig.port, maintainerConfig.host);
    }
    health.running = true;
    return surface;
  } catch (error) {
    if (surface !== undefined) await stopServers(surface, config).catch(() => undefined);
    await pool.end();
    throw error;
  }
}

export async function startHostedFeedbackIntake(
  options: HostedRuntimeOptions,
): Promise<HostedFeedbackIntakeRuntime> {
  const { config, maintainerConfig } = loadFeedbackRuntimeConfigs(options.env, options);
  const now = options.now ?? ((): Date => new Date());
  const health: RuntimeHealth = { dependenciesHealthy: false, running: false };
  const pool = (options.poolFactory ?? defaultPool)(
    config.databaseUrl,
    config.limits.concurrency + config.limits.receiptConcurrency,
    config.limits.storageDeadlineMs,
  );
  const activeSurface = await initializeSurface(
    options,
    config,
    pool,
    health,
    now,
    maintainerConfig,
  );
  const timer = options.timer ?? defaultRuntimeTimer();
  let activeRetention = Promise.resolve();
  const runRetention = (): Promise<void> => {
    const next = activeRetention
      .catch(() => undefined)
      .then(() => retention(activeSurface, health, now()));
    activeRetention = next;
    return next;
  };
  const handle = timer.setInterval(() => {
    void runRetention().catch(() => undefined);
  }, config.retentionIntervalMs);
  let stopped = false;
  return {
    ready: (): boolean => isReady(health),
    runRetention: () =>
      health.running ? runRetention() : Promise.reject(new Error("Feedback intake is stopped")),
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      health.running = false;
      timer.clearInterval(handle);
      try {
        await activeRetention.catch(() => undefined);
        await stopServers(activeSurface, config);
      } finally {
        await pool.end();
      }
    },
  };
}
