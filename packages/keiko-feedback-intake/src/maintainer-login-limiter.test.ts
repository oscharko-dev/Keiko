import { describe, expect, it } from "vitest";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";

describe("maintainer login limiter", () => {
  it("bounds concurrency before work and releases the exact admission", () => {
    const limiter = new MaintainerLoginLimiter(
      { perSource: 10, global: 10, windowMs: 60_000, concurrency: 1 },
      () => 1,
    );
    const first = limiter.begin(new Uint8Array([192, 0, 2, 1]));
    expect(first.ok).toBe(true);
    expect(limiter.begin(new Uint8Array([192, 0, 2, 2]))).toMatchObject({ ok: false });
    if (!first.ok) throw new Error("Expected admission");
    first.release();
    first.release();
    expect(limiter.begin(new Uint8Array([192, 0, 2, 2])).ok).toBe(true);
  });
});
