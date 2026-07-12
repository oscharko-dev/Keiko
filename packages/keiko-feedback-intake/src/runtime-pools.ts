import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

export interface RuntimePool extends PgPoolLike {
  end(): Promise<void>;
  abortCheckedOut?(error: Error): void;
}

export type RuntimePoolFactory = (
  databaseUrl: string,
  max: number,
  connectTimeoutMs: number,
) => RuntimePool;

export interface RuntimePools {
  readonly intake: RuntimePool;
  readonly maintainer?: RuntimePool | undefined;
  readonly publicationPrimary?: RuntimePool | undefined;
  readonly publicationSessions?: RuntimePool | undefined;
}

export const MAINTAINER_POOL_MAX = 4;

function optionalPool(
  factory: RuntimePoolFactory,
  databaseUrl: string,
  maximum: number,
  connectTimeoutMs: number,
  enabled: boolean,
): RuntimePool | undefined {
  return enabled ? factory(databaseUrl, maximum, connectTimeoutMs) : undefined;
}

function trackedPublicationPool(pool: RuntimePool): RuntimePool {
  const checkedOut = new Set<PgClientLike>();
  return {
    connect: async (): Promise<PgClientLike> => {
      const client = await pool.connect();
      let released = false;
      const tracked: PgClientLike = {
        query: (text, values) => client.query(text, values),
        release: (error): void => {
          if (released) return;
          released = true;
          checkedOut.delete(tracked);
          client.release(error);
        },
      };
      checkedOut.add(tracked);
      return tracked;
    },
    end: () => pool.end(),
    abortCheckedOut: (error): void => {
      for (const client of [...checkedOut]) client.release(error);
    },
  };
}

function trackedOptional(pool: RuntimePool | undefined): RuntimePool | undefined {
  return pool === undefined ? undefined : trackedPublicationPool(pool);
}

export async function createRuntimePools(
  factory: RuntimePoolFactory,
  databaseUrl: string,
  intakeMax: number,
  connectTimeoutMs: number,
  maintainerEnabled: boolean,
  publicationConcurrency = 0,
): Promise<RuntimePools> {
  const intake = factory(databaseUrl, intakeMax, connectTimeoutMs);
  const created: RuntimePool[] = [intake];
  try {
    const maintainer = optionalPool(
      factory,
      databaseUrl,
      MAINTAINER_POOL_MAX,
      connectTimeoutMs,
      maintainerEnabled,
    );
    if (maintainer !== undefined) created.push(maintainer);
    const rawPublicationPrimary = optionalPool(
      factory,
      databaseUrl,
      publicationConcurrency,
      connectTimeoutMs,
      publicationConcurrency > 0,
    );
    const publicationPrimary = trackedOptional(rawPublicationPrimary);
    if (rawPublicationPrimary !== undefined) created.push(rawPublicationPrimary);
    const rawPublicationSessions = optionalPool(
      factory,
      databaseUrl,
      publicationConcurrency,
      connectTimeoutMs,
      publicationConcurrency > 0,
    );
    const publicationSessions = trackedOptional(rawPublicationSessions);
    if (rawPublicationSessions !== undefined) created.push(rawPublicationSessions);
    if (new Set(created).size !== created.length)
      throw new Error("Runtime database pools must be isolated");
    return { intake, maintainer, publicationPrimary, publicationSessions };
  } catch (error) {
    await Promise.all([...new Set(created)].map((pool) => pool.end()));
    throw error;
  }
}

export async function endRuntimePools(pools: RuntimePools): Promise<void> {
  await Promise.all([endRequestPools(pools), endPublicationPools(pools)]);
}

export async function endRequestPools(pools: RuntimePools): Promise<void> {
  const active = [pools.intake, ...(pools.maintainer === undefined ? [] : [pools.maintainer])];
  await Promise.all(active.map((pool) => Promise.resolve().then(() => pool.end())));
}

async function closePublicationPool(pool: RuntimePool, deadlineAt?: number): Promise<void> {
  const closing = Promise.resolve().then(() => pool.end());
  if (deadlineAt === undefined) return closing;
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  let timeout: NodeJS.Timeout | undefined;
  const forced = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      pool.abortCheckedOut?.(new Error("Feedback publication shutdown deadline exceeded"));
      resolve();
    }, remainingMs);
    timeout.unref();
  });
  try {
    await Promise.race([closing, forced]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function endPublicationPools(pools: RuntimePools, deadlineAt?: number): Promise<void> {
  const active = [
    ...(pools.publicationPrimary === undefined ? [] : [pools.publicationPrimary]),
    ...(pools.publicationSessions === undefined ? [] : [pools.publicationSessions]),
  ];
  await Promise.all(active.map((pool) => closePublicationPool(pool, deadlineAt)));
}
