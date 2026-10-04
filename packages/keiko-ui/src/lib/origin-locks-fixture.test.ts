import { describe, expect, it } from "vitest";
import { createOriginLocksFixture } from "../test-utils/origin-locks-fixture";

describe("origin locks browser fixture", (): void => {
  it("holds the grant until settlement and retains FIFO order after a queued abort", async (): Promise<void> => {
    const locks = createOriginLocksFixture();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve): void => {
      release = resolve;
    });
    const owner = new AbortController();
    const order: number[] = [];
    const first = locks.request("slot", { signal: owner.signal }, async (): Promise<void> => {
      order.push(1);
      await held;
    });
    await Promise.resolve();
    await Promise.resolve();
    const cancelled = new AbortController();
    const second = locks.request("slot", { signal: cancelled.signal }, (): void => {
      order.push(2);
    });
    const third = locks.request("slot", {}, (): void => {
      order.push(3);
    });
    const rejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    cancelled.abort();
    owner.abort();
    await rejection;
    expect((await locks.query()).held).toHaveLength(1);
    expect((await locks.query()).pending).toHaveLength(1);
    expect(order).toEqual([1]);
    release?.();
    await first;
    await third;
    expect(order).toEqual([1, 3]);
    expect((await locks.query()).held).toEqual([]);
  });
});
