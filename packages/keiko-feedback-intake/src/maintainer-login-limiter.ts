import { createHmac, randomBytes } from "node:crypto";

export interface MaintainerLoginLimits {
  readonly perSource: number;
  readonly global: number;
  readonly windowMs: number;
  readonly concurrency: number;
}

export type MaintainerLoginAdmission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly retryAfterSeconds: number };

interface SourceWindow {
  startedAt: number;
  count: number;
  active: number;
}

interface SourceContext {
  readonly source?: SourceWindow | undefined;
  readonly count: number;
  readonly startedAt: number;
}

const MAX_TRACKED_SOURCES = 10_000;
export const MAINTAINER_LOGIN_OVERFLOW_DEPTH = 4;
export const MAINTAINER_LOGIN_OVERFLOW_WIDTH = 262_144;
export const MAINTAINER_LOGIN_OVERFLOW_BYTES =
  MAINTAINER_LOGIN_OVERFLOW_DEPTH * MAINTAINER_LOGIN_OVERFLOW_WIDTH * Uint16Array.BYTES_PER_ELEMENT;

// Under the configured 10,000-admission global maximum, the keyed independent-row
// union bound is (10,000 / 262,144)^4, or less than 2.2e-6 per unseen source.
export function maintainerLoginOverflowFalsePositiveUpperBound(admissions: number): number {
  return Math.min(
    1,
    (admissions / MAINTAINER_LOGIN_OVERFLOW_WIDTH) ** MAINTAINER_LOGIN_OVERFLOW_DEPTH,
  );
}

class OverflowCountMinSketch {
  private readonly counters: Uint16Array;

  constructor(private readonly width: number) {
    this.counters = new Uint16Array(MAINTAINER_LOGIN_OVERFLOW_DEPTH * width);
  }

  estimate(digest: Buffer): number {
    let estimate = 65_535;
    for (let row = 0; row < MAINTAINER_LOGIN_OVERFLOW_DEPTH; row += 1) {
      estimate = Math.min(estimate, this.counters[this.offset(digest, row)] ?? 0);
    }
    return estimate;
  }

  increment(digest: Buffer): void {
    const estimate = this.estimate(digest);
    if (estimate === 65_535) return;
    for (let row = 0; row < MAINTAINER_LOGIN_OVERFLOW_DEPTH; row += 1) {
      const offset = this.offset(digest, row);
      if (this.counters[offset] === estimate) this.counters[offset] = estimate + 1;
    }
  }

  reset(): void {
    this.counters.fill(0);
  }

  private offset(digest: Buffer, row: number): number {
    return row * this.width + (digest.readUInt32BE(row * 4) % this.width);
  }
}

export class MaintainerLoginLimiter {
  private readonly key = randomBytes(32);
  private readonly sources = new Map<string, SourceWindow>();
  private readonly overflow: OverflowCountMinSketch;
  private globalInitialized = false;
  private globalStartedAt = 0;
  private globalCount = 0;
  private globalActive = 0;

  constructor(
    private readonly limits: MaintainerLoginLimits,
    private readonly now: () => number = Date.now,
    private readonly maxTrackedSources = MAX_TRACKED_SOURCES,
    overflowWidth = MAINTAINER_LOGIN_OVERFLOW_WIDTH,
  ) {
    if (!Number.isSafeInteger(maxTrackedSources) || maxTrackedSources < 1) {
      throw new Error("Maintainer login source capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(overflowWidth) || overflowWidth < 1) {
      throw new Error("Maintainer login overflow width must be a positive safe integer");
    }
    this.overflow = new OverflowCountMinSketch(overflowWidth);
  }

  begin(address: Uint8Array): MaintainerLoginAdmission {
    const at = this.now();
    this.cleanup(at);
    const digest = createHmac("sha256", this.key).update(address).digest();
    const sourceKey = digest.toString("base64url");
    const context = this.sourceContext(sourceKey, digest, at);
    const retryAt = this.retryAt(context.count, context.startedAt, at);
    if (retryAt !== undefined) return this.denied(at, retryAt);
    this.recordAdmission(sourceKey, digest, context.source);
    this.globalCount += 1;
    this.globalActive += 1;
    return this.releaseHandle(context.source);
  }

  private sourceContext(sourceKey: string, digest: Buffer, at: number): SourceContext {
    const source = this.sources.get(sourceKey);
    if (source !== undefined) {
      if (at - source.startedAt >= this.limits.windowMs && source.active === 0) {
        source.startedAt = at;
        source.count = 0;
      }
      return { source, count: source.count, startedAt: source.startedAt };
    }
    const count = this.overflow.estimate(digest);
    if (count > 0 || this.sources.size >= this.maxTrackedSources) {
      return { count, startedAt: this.globalStartedAt };
    }
    return { source: { startedAt: at, count: 0, active: 0 }, count: 0, startedAt: at };
  }

  private recordAdmission(sourceKey: string, digest: Buffer, source?: SourceWindow): void {
    if (source === undefined) {
      this.overflow.increment(digest);
      return;
    }
    source.count += 1;
    source.active += 1;
    this.sources.set(sourceKey, source);
  }

  private releaseHandle(source?: SourceWindow): MaintainerLoginAdmission {
    let released = false;
    return {
      ok: true,
      release: (): void => {
        if (released) return;
        released = true;
        if (source !== undefined) source.active -= 1;
        this.globalActive -= 1;
      },
    };
  }

  private denied(at: number, resetAt: number): MaintainerLoginAdmission {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - at) / 1_000)),
    };
  }

  private retryAt(count: number, startedAt: number, at: number): number | undefined {
    let resetAt = 0;
    if (count >= this.limits.perSource) {
      resetAt = startedAt + this.limits.windowMs;
    }
    if (this.globalCount >= this.limits.global) {
      resetAt = Math.max(resetAt, this.globalStartedAt + this.limits.windowMs);
    }
    if (this.globalActive >= this.limits.concurrency) resetAt = Math.max(resetAt, at + 1_000);
    return resetAt === 0 ? undefined : resetAt;
  }

  private cleanup(at: number): void {
    if (!this.globalInitialized || at - this.globalStartedAt >= this.limits.windowMs) {
      this.globalInitialized = true;
      this.globalStartedAt = at;
      this.globalCount = 0;
      this.overflow.reset();
    }
    for (const [key, source] of this.sources) {
      if (source.active === 0 && at - source.startedAt >= this.limits.windowMs) {
        this.sources.delete(key);
      }
    }
  }
}
