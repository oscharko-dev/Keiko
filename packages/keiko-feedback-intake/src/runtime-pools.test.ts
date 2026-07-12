import { describe, expect, it } from "vitest";
import type { PgClientLike } from "./postgres-types.js";
import {
  createRuntimePools,
  endPublicationPools,
  endRuntimePools,
  type RuntimePool,
} from "./runtime-pools.js";

describe("runtime pool isolation", () => {
  it("creates physically distinct publication state and exactly-sized session pools", async () => {
    const maximums: number[] = [];
    const ended: number[] = [];
    const pools = await createRuntimePools(
      (_url, maximum) => {
        const index = maximums.length;
        maximums.push(maximum);
        return {
          connect: (): Promise<PgClientLike> => Promise.reject(new Error("unused")),
          end: (): Promise<void> => {
            ended.push(index);
            return Promise.resolve();
          },
        } satisfies RuntimePool;
      },
      "postgres://unused",
      6,
      2_000,
      true,
      3,
    );
    expect(maximums).toEqual([6, 4, 3, 3]);
    expect(
      new Set([pools.intake, pools.maintainer, pools.publicationPrimary, pools.publicationSessions])
        .size,
    ).toBe(4);
    await endRuntimePools(pools);
    expect(ended.sort()).toEqual([0, 1, 2, 3]);
  });

  it("does not create publication pools while disabled", async () => {
    let created = 0;
    const pools = await createRuntimePools(
      () => {
        created += 1;
        return {
          connect: (): Promise<PgClientLike> => Promise.reject(new Error("unused")),
          end: (): Promise<void> => Promise.resolve(),
        };
      },
      "postgres://unused",
      6,
      2_000,
      false,
    );
    expect(created).toBe(1);
    expect(pools.publicationPrimary).toBeUndefined();
    await endRuntimePools(pools);
  });

  it("keeps intake and maintainer capacity available while publication sessions are blocked", async () => {
    let index = 0;
    const client: PgClientLike = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      release: () => undefined,
    };
    const pools = await createRuntimePools(
      () => {
        const poolIndex = index++;
        return {
          connect: (): Promise<PgClientLike> =>
            poolIndex === 3 ? new Promise(() => undefined) : Promise.resolve(client),
          end: (): Promise<void> => Promise.resolve(),
        };
      },
      "postgres://unused",
      6,
      2_000,
      true,
      2,
    );
    const blocked = pools.publicationSessions?.connect();
    await expect(pools.intake.connect()).resolves.toBe(client);
    await expect(pools.maintainer?.connect()).resolves.toBe(client);
    expect(blocked).toBeInstanceOf(Promise);
    await endRuntimePools(pools);
  });

  it("discards checked-out publication clients at one bounded close deadline", async () => {
    let index = 0;
    const discarded: number[] = [];
    const pools = await createRuntimePools(
      () => {
        const poolIndex = index++;
        return {
          connect: (): Promise<PgClientLike> =>
            Promise.resolve({
              query: () => new Promise(() => undefined),
              release: (error): void => {
                if (error !== undefined) discarded.push(poolIndex);
              },
            }),
          end: (): Promise<void> =>
            poolIndex >= 1 ? new Promise(() => undefined) : Promise.resolve(),
        };
      },
      "postgres://unused",
      6,
      2_000,
      false,
      2,
    );
    await pools.publicationPrimary?.connect();
    await pools.publicationSessions?.connect();
    const startedAt = Date.now();
    await endPublicationPools(pools, startedAt + 25);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(discarded.sort()).toEqual([1, 2]);
    await pools.intake.end();
  });
});
