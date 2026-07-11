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

const MAX_TRACKED_SOURCES = 10_000;

export class MaintainerLoginLimiter {
  private readonly key = randomBytes(32);
  private readonly sources = new Map<string, SourceWindow>();
  private globalStartedAt = 0;
  private globalCount = 0;
  private globalActive = 0;

  constructor(
    private readonly limits: MaintainerLoginLimits,
    private readonly now: () => number = Date.now,
  ) {}

  begin(address: Uint8Array): MaintainerLoginAdmission {
    const at = this.now();
    this.cleanup(at);
    const sourceKey = createHmac("sha256", this.key).update(address).digest("base64url");
    const existing = this.sources.get(sourceKey);
    if (existing === undefined && this.sources.size >= MAX_TRACKED_SOURCES) {
      return this.denied(at, this.globalStartedAt + this.limits.windowMs);
    }
    const source = existing ?? { startedAt: at, count: 0, active: 0 };
    if (at - source.startedAt >= this.limits.windowMs && source.active === 0) {
      source.startedAt = at;
      source.count = 0;
    }
    const retryAt = this.retryAt(source, at);
    if (retryAt !== undefined) return this.denied(at, retryAt);
    source.count += 1;
    source.active += 1;
    this.globalCount += 1;
    this.globalActive += 1;
    this.sources.set(sourceKey, source);
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

  private retryAt(source: SourceWindow, at: number): number | undefined {
    let resetAt = 0;
    if (source.count >= this.limits.perSource) {
      resetAt = source.startedAt + this.limits.windowMs;
    }
    if (this.globalCount >= this.limits.global) {
      resetAt = Math.max(resetAt, this.globalStartedAt + this.limits.windowMs);
    }
    if (this.globalActive >= this.limits.concurrency) resetAt = Math.max(resetAt, at + 1_000);
    return resetAt === 0 ? undefined : resetAt;
  }

  private cleanup(at: number): void {
    if (this.globalStartedAt === 0 || at - this.globalStartedAt >= this.limits.windowMs) {
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
