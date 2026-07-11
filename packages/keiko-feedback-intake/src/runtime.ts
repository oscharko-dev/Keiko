import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Pool } from "pg";
import { FEEDBACK_INTAKE_REPORT_PATH_V1 } from "@oscharko-dev/keiko-contracts/feedback-intake";
import { FileSecretProvider } from "./file-secret-provider.js";
import { createFeedbackIntakeHttpHandler } from "./http.js";
import { PostgresIntakeRepository, type PgClientLike, type PgPoolLike } from "./postgres.js";
import { createPostgresFeedbackIntake } from "./production-service.js";
import { loadHostedRuntimeConfig, type HostedRuntimeConfig } from "./runtime-config.js";
import {
  assertRepositoryKeyCustody,
  snapshotIndependentKeyCustody,
} from "./runtime-key-custody.js";
import type { ContentFreeLogger, ContentFreeMetrics } from "./types.js";

interface RuntimePool extends PgPoolLike {
  end(): Promise<void>;
}
interface RuntimeServer {
  listen(port: number, host: string, callback: () => void): void;
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
  once?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
}
interface RuntimeTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}
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

function defaultTimer(): RuntimeTimer {
  return {
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle): void => {
      clearInterval(handle as NodeJS.Timeout);
    },
  };
}

async function applyMigration(pool: RuntimePool, source: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [2_074_001]);
    const exists = await client.query<{ readonly name: string | null }>(
      "SELECT to_regclass('feedback_schema_migrations')::text AS name",
    );
    if (exists.rows[0]?.name === null) {
      await client.query(source);
    } else {
      const versions = await client.query<{ readonly version: number }>(
        "SELECT version FROM feedback_schema_migrations ORDER BY version",
      );
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) {
        throw new Error("Unsupported feedback schema version");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function migrationSource(options: HostedRuntimeOptions): () => Promise<string> {
  return (
    options.migrationSource ??
    ((): Promise<string> =>
      readFile(new URL("../migrations/001_feedback_intake.sql", import.meta.url), "utf8"))
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
  await Promise.all([
    closeBounded(surface.intake, config.drainDeadlineMs),
    closeBounded(surface.management, config.drainDeadlineMs),
  ]);
}

async function initializeSurface(
  options: HostedRuntimeOptions,
  config: HostedRuntimeConfig,
  pool: RuntimePool,
  health: RuntimeHealth,
  now: () => Date,
): Promise<RuntimeSurface> {
  let surface: RuntimeSurface | undefined;
  try {
    await applyMigration(pool, await migrationSource(options)());
    surface = composeSurface(options, config, pool, health, now);
    await retention(surface, health, now());
    await listen(surface.management, config.managementPort, config.managementHost);
    await listen(surface.intake, config.port, config.host);
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
  const config = loadHostedRuntimeConfig(options.env);
  const now = options.now ?? ((): Date => new Date());
  const health: RuntimeHealth = { dependenciesHealthy: false, running: false };
  const pool = (options.poolFactory ?? defaultPool)(
    config.databaseUrl,
    config.limits.concurrency + config.limits.receiptConcurrency,
    config.limits.storageDeadlineMs,
  );
  const activeSurface = await initializeSurface(options, config, pool, health, now);
  const timer = options.timer ?? defaultTimer();
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
