import type { PgPoolLike } from "./postgres-types.js";

export interface RuntimePool extends PgPoolLike {
  end(): Promise<void>;
}

export type RuntimePoolFactory = (
  databaseUrl: string,
  max: number,
  connectTimeoutMs: number,
) => RuntimePool;

export interface RuntimePools {
  readonly intake: RuntimePool;
  readonly maintainer?: RuntimePool | undefined;
}

export const MAINTAINER_POOL_MAX = 4;

export async function createRuntimePools(
  factory: RuntimePoolFactory,
  databaseUrl: string,
  intakeMax: number,
  connectTimeoutMs: number,
  maintainerEnabled: boolean,
): Promise<RuntimePools> {
  const intake = factory(databaseUrl, intakeMax, connectTimeoutMs);
  try {
    const maintainer = maintainerEnabled
      ? factory(databaseUrl, MAINTAINER_POOL_MAX, connectTimeoutMs)
      : undefined;
    if (maintainer === intake) {
      throw new Error("Maintainer database pool must be isolated from intake");
    }
    return {
      intake,
      ...(maintainer === undefined ? {} : { maintainer }),
    };
  } catch (error) {
    await intake.end();
    throw error;
  }
}

export async function endRuntimePools(pools: RuntimePools): Promise<void> {
  const active = [pools.intake, ...(pools.maintainer === undefined ? [] : [pools.maintainer])];
  await Promise.all(active.map((pool) => Promise.resolve().then(() => pool.end())));
}
