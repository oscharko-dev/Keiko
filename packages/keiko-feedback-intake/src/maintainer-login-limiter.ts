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
  readonly source: SourceWindow;
  readonly count: number;
  readonly startedAt: number;
}

interface SourceExpiry {
  readonly expiresAt: number;
  readonly sourceKey: string;
  readonly startedAt: number;
}

class SourceExpiryQueue {
  private readonly records: SourceExpiry[] = [];

  get size(): number {
    return this.records.length;
  }

  peek(): SourceExpiry | undefined {
    return this.records[0];
  }

  push(record: SourceExpiry): void {
    this.records.push(record);
    let index = this.records.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if ((this.records[parent]?.expiresAt ?? 0) <= record.expiresAt) break;
      this.records[index] = this.recordAt(parent);
      index = parent;
    }
    this.records[index] = record;
  }

  pop(): SourceExpiry | undefined {
    const first = this.records[0];
    const last = this.records.pop();
    if (first === undefined || last === undefined || this.records.length === 0) return first;
    this.records[0] = last;
    this.siftDown();
    return first;
  }

  private siftDown(): void {
    let index = 0;
    let smaller = this.smallerChild(index);
    while (
      smaller !== undefined &&
      this.recordAt(index).expiresAt > this.recordAt(smaller).expiresAt
    ) {
      [this.records[index], this.records[smaller]] = [this.recordAt(smaller), this.recordAt(index)];
      index = smaller;
      smaller = this.smallerChild(index);
    }
  }

  private smallerChild(index: number): number | undefined {
    const left = 2 * index + 1;
    if (left >= this.records.length) return undefined;
    const right = left + 1;
    if (right >= this.records.length) return left;
    return this.recordAt(right).expiresAt < this.recordAt(left).expiresAt ? right : left;
  }

  private recordAt(index: number): SourceExpiry {
    const record = this.records[index];
    if (record === undefined) throw new Error("Maintainer login expiry heap invariant violated");
    return record;
  }
}

function retainedSourceCapacity(limits: MaintainerLoginLimits): number {
  // Inactive source windows live for at most W and therefore overlap at most two
  // global W windows (2 * global). Older live entries must be active (concurrency).
  return 2 * limits.global + limits.concurrency;
}

export class MaintainerLoginLimiter {
  private readonly key = randomBytes(32);
  private readonly sources = new Map<string, SourceWindow>();
  private readonly expiries = new SourceExpiryQueue();
  private readonly maxTrackedSources: number;
  private globalInitialized = false;
  private globalStartedAt = 0;
  private globalCount = 0;
  private globalActive = 0;

  constructor(
    private readonly limits: MaintainerLoginLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.maxTrackedSources = retainedSourceCapacity(limits);
  }

  begin(address: Uint8Array): MaintainerLoginAdmission {
    const at = this.now();
    this.cleanup(at);
    const sourceKey = createHmac("sha256", this.key).update(address).digest("base64url");
    const context = this.sourceContext(sourceKey, at);
    if (context === undefined) return this.denied(at, at + 1_000);
    const retryAt = this.retryAt(context.count, context.startedAt, at);
    if (retryAt !== undefined) return this.denied(at, retryAt);
    this.recordAdmission(sourceKey, context.source);
    this.globalCount += 1;
    this.globalActive += 1;
    return this.releaseHandle(sourceKey, context.source);
  }

  private sourceContext(sourceKey: string, at: number): SourceContext | undefined {
    const source = this.sources.get(sourceKey);
    if (source !== undefined) {
      if (at - source.startedAt >= this.limits.windowMs && source.active === 0) {
        source.startedAt = at;
        source.count = 0;
      }
      return { source, count: source.count, startedAt: source.startedAt };
    }
    if (this.sources.size >= this.maxTrackedSources) return undefined;
    const created = { startedAt: at, count: 0, active: 0 };
    return { source: created, count: 0, startedAt: at };
  }

  private recordAdmission(sourceKey: string, source: SourceWindow): void {
    source.count += 1;
    source.active += 1;
    this.sources.set(sourceKey, source);
  }

  private releaseHandle(sourceKey: string, source: SourceWindow): MaintainerLoginAdmission {
    let released = false;
    return {
      ok: true,
      release: (): void => {
        if (released) return;
        released = true;
        source.active -= 1;
        this.globalActive -= 1;
        if (source.active === 0) this.scheduleExpiry(sourceKey, source);
      },
    };
  }

  private scheduleExpiry(sourceKey: string, source: SourceWindow): void {
    // Each record represents an admitted active-to-inactive transition. At most
    // two global admission windows plus concurrency can remain live together.
    if (this.expiries.size >= this.maxTrackedSources) {
      throw new Error("Maintainer login expiry capacity invariant violated");
    }
    this.expiries.push({
      expiresAt: source.startedAt + this.limits.windowMs,
      sourceKey,
      startedAt: source.startedAt,
    });
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
    }
    let expiry = this.expiries.peek();
    while (expiry !== undefined && expiry.expiresAt <= at) {
      this.expiries.pop();
      const source = this.sources.get(expiry.sourceKey);
      if (source?.active === 0 && source.startedAt === expiry.startedAt) {
        this.sources.delete(expiry.sourceKey);
      }
      expiry = this.expiries.peek();
    }
  }
}
