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

function retainedSourceCapacity(limits: MaintainerLoginLimits): number {
  // Inactive source windows live for at most W and therefore overlap at most two
  // global W windows (2 * global). Older live entries must be active (concurrency).
  return 2 * limits.global + limits.concurrency;
}

export class MaintainerLoginLimiter {
  private readonly key = randomBytes(32);
  private readonly sources = new Map<string, SourceWindow>();
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
    return this.releaseHandle(context.source);
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

  private releaseHandle(source: SourceWindow): MaintainerLoginAdmission {
    let released = false;
    return {
      ok: true,
      release: (): void => {
        if (released) return;
        released = true;
        source.active -= 1;
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
    }
    for (const [key, source] of this.sources) {
      if (source.active === 0 && at - source.startedAt >= this.limits.windowMs) {
        this.sources.delete(key);
      }
    }
  }
}
