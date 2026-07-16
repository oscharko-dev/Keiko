export const CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN = 8;
export const CODING_TOOL_INVOCATION_MAX_BYTES_PER_ENTRY = 262_144;
export const CODING_TOOL_INVOCATION_MAX_AGGREGATE_BYTES = 2 * 1024 * 1024;
const MAX_TTL_MS = 30_000;
const MAX_IDENTITIES = 2_048;
const MAX_REVOKED_RUNS = 2_048;

export interface CodingToolInvocationStage {
  readonly runId: string;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly authorityExpiresAt: string;
  readonly payload: Buffer;
}

export type CodingToolInvocationStageResult =
  | { readonly kind: "staged" | "duplicate" }
  | { readonly kind: "busy" | "invalid" | "conflict" | "replayed" | "revoked" };

export type CodingToolInvocationTakeResult =
  | { readonly kind: "ready"; readonly payload: Buffer; readonly signal: AbortSignal }
  | { readonly kind: "expired" | "replayed" | "revoked" | "missing" };

type InvocationIdentity = Pick<CodingToolInvocationStage, "runId" | "actionId" | "idempotencyKey">;

export interface CodingToolInvocationRegistry {
  readonly stage: (request: CodingToolInvocationStage) => CodingToolInvocationStageResult;
  readonly take: (request: InvocationIdentity) => CodingToolInvocationTakeResult;
  readonly settle: (request: InvocationIdentity) => boolean;
  readonly revokeRun: (runId: string) => number;
  readonly dispose: () => void;
  readonly tombstoneFor: (
    runId: string,
    actionId: string,
    idempotencyKey: string,
  ) => Readonly<Record<string, never>> | undefined;
}

export interface CodingToolInvocationRegistryOptions {
  readonly now?: (() => number) | undefined;
}

interface Entry {
  readonly digest: string;
  readonly expiresAt: number;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  payload: Buffer;
}

interface ClaimedEntry {
  readonly digest: string;
  readonly expiresAt: number;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  payload: Buffer;
}

interface Tombstone {
  readonly digest: string;
  readonly expiresAt: number;
  readonly kind: "expired" | "replayed";
}

class InvocationRegistry implements CodingToolInvocationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly claimed = new Map<string, ClaimedEntry>();
  private readonly revoked = new Set<string>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly actionIndex = new Map<string, string>();
  private readonly idempotencyIndex = new Map<string, string>();
  private totalBytes = 0;
  private disposed = false;

  public constructor(private readonly now: () => number) {}

  public stage(request: CodingToolInvocationStage): CodingToolInvocationStageResult {
    this.expire();
    if (this.disposed || this.revoked.has(request.runId)) return { kind: "revoked" };
    if (!validStage(request)) return { kind: "invalid" };
    const collision = this.collision(request);
    if (collision !== undefined) return collision;
    if (!this.hasCapacity(request)) return { kind: "busy" };
    this.add(request);
    return { kind: "staged" };
  }

  public take(request: InvocationIdentity): CodingToolInvocationTakeResult {
    this.expire();
    if (this.disposed || this.revoked.has(request.runId)) return { kind: "revoked" };
    const key = identity(request);
    if (this.claimed.has(key)) return { kind: "replayed" };
    const entry = this.entries.get(key);
    if (entry === undefined) return { kind: this.tombstones.get(key)?.kind ?? "missing" };
    this.removeLive(key, entry, false);
    this.remember(key, entry.digest, entry.expiresAt);
    this.claimed.set(key, {
      digest: entry.digest,
      expiresAt: entry.expiresAt,
      controller: entry.controller,
      timer: entry.timer,
      payload: entry.payload,
    });
    return { kind: "ready", payload: entry.payload, signal: entry.controller.signal };
  }

  public settle(request: InvocationIdentity): boolean {
    const key = identity(request);
    const entry = this.claimed.get(key);
    if (entry === undefined) return false;
    this.claimed.delete(key);
    this.dropClaimed(key, entry);
    return true;
  }

  public revokeRun(runId: string): number {
    if (this.revoked.has(runId)) return 0;
    this.rememberRevoked(runId);
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (!keyForRun(key, runId)) continue;
      this.dropLive(key, entry);
      count += 1;
    }
    for (const [key, entry] of this.claimed) {
      if (!keyForRun(key, runId)) continue;
      this.dropClaimed(key, entry);
      count += 1;
    }
    this.clearRunIdentities(runId);
    return count;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, entry] of this.entries) this.dropLive(key, entry);
    for (const [key, entry] of this.claimed) this.dropClaimed(key, entry);
    this.tombstones.clear();
    this.actionIndex.clear();
    this.idempotencyIndex.clear();
  }

  public tombstoneFor(
    runId: string,
    actionId: string,
    idempotencyKey: string,
  ): Readonly<Record<string, never>> | undefined {
    this.expire();
    return this.tombstones.has(identity({ runId, actionId, idempotencyKey })) ? {} : undefined;
  }

  private collision(
    request: CodingToolInvocationStage,
  ): CodingToolInvocationStageResult | undefined {
    const key = identity(request);
    const actionOwner = this.actionIndex.get(actionIdentity(request));
    const keyOwner = this.idempotencyIndex.get(idempotencyIdentity(request));
    const ownership = collisionOwnership(actionOwner, keyOwner, key);
    if (ownership === "none") return undefined;
    if (ownership !== "same") return ownership;
    const live = this.entries.get(key);
    if (live !== undefined) {
      return { kind: live.digest === request.digest ? "duplicate" : "conflict" };
    }
    const digest = this.claimed.get(key)?.digest ?? this.tombstones.get(key)?.digest;
    return { kind: digest === request.digest ? "replayed" : "conflict" };
  }

  private hasCapacity(request: CodingToolInvocationStage): boolean {
    return (
      this.runEntryCount(request.runId) < CODING_TOOL_INVOCATION_MAX_LIVE_PER_RUN &&
      this.runIdentityCount(request.runId) < MAX_IDENTITIES &&
      this.totalBytes + request.payload.length <= CODING_TOOL_INVOCATION_MAX_AGGREGATE_BYTES
    );
  }

  private add(request: CodingToolInvocationStage): void {
    const key = identity(request);
    const expiresAt = expiryFor(request.authorityExpiresAt, this.now());
    const timer = setTimeout(
      () => {
        this.expireKey(key);
      },
      Math.max(0, expiresAt - this.now()),
    );
    timer.unref();
    this.entries.set(key, {
      digest: request.digest,
      expiresAt,
      controller: new AbortController(),
      timer,
      payload: request.payload,
    });
    this.actionIndex.set(actionIdentity(request), key);
    this.idempotencyIndex.set(idempotencyIdentity(request), key);
    this.totalBytes += request.payload.length;
  }

  private expire(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.dropLive(key, entry, "expired");
    }
    for (const [key, entry] of this.claimed) {
      if (entry.expiresAt <= this.now()) this.dropClaimed(key, entry, "expired");
    }
  }

  private expireKey(_key: string): void {
    this.expire();
  }

  private removeLive(key: string, entry: Entry, releaseBytes = true): void {
    this.entries.delete(key);
    if (releaseBytes) this.totalBytes -= entry.payload.length;
  }

  private dropLive(key: string, entry: Entry, kind: "expired" | "replayed" = "replayed"): void {
    clearTimeout(entry.timer);
    this.removeLive(key, entry);
    entry.payload.fill(0);
    entry.controller.abort();
    this.remember(key, entry.digest, entry.expiresAt, kind);
  }

  private dropClaimed(
    key: string,
    entry: ClaimedEntry,
    kind: "expired" | "replayed" = "replayed",
  ): void {
    clearTimeout(entry.timer);
    this.claimed.delete(key);
    this.totalBytes -= entry.payload.length;
    wipeClaimed(entry);
    this.remember(key, entry.digest, entry.expiresAt, kind);
  }

  private remember(
    key: string,
    digest: string,
    expiresAt: number,
    kind: "expired" | "replayed" = "replayed",
  ): void {
    if (this.tombstones.has(key)) return;
    this.tombstones.set(key, { digest, expiresAt, kind });
  }

  private runEntryCount(runId: string): number {
    let count = 0;
    for (const key of this.entries.keys()) if (keyForRun(key, runId)) count += 1;
    for (const key of this.claimed.keys()) if (keyForRun(key, runId)) count += 1;
    return count;
  }

  private runIdentityCount(runId: string): number {
    let count = 0;
    for (const key of this.actionIndex.values()) if (keyForRun(key, runId)) count += 1;
    return count;
  }

  private clearRunIdentities(runId: string): void {
    for (const [key, owner] of this.actionIndex) {
      if (keyForRun(owner, runId)) this.actionIndex.delete(key);
    }
    for (const [key, owner] of this.idempotencyIndex) {
      if (keyForRun(owner, runId)) this.idempotencyIndex.delete(key);
    }
    for (const key of this.tombstones.keys()) {
      if (keyForRun(key, runId)) this.tombstones.delete(key);
    }
  }

  private rememberRevoked(runId: string): void {
    this.revoked.add(runId);
    while (this.revoked.size > MAX_REVOKED_RUNS) {
      const oldest = this.revoked.values().next().value;
      if (oldest === undefined) return;
      this.revoked.delete(oldest);
    }
  }
}

function collisionOwnership(
  actionOwner: string | undefined,
  keyOwner: string | undefined,
  key: string,
): "none" | "same" | CodingToolInvocationStageResult {
  if (actionOwner === undefined && keyOwner === undefined) return "none";
  return actionOwner === key && keyOwner === key ? "same" : { kind: "conflict" };
}

function wipeClaimed(entry: ClaimedEntry): void {
  entry.payload.fill(0);
  entry.controller.abort();
}

function validStage(request: CodingToolInvocationStage): boolean {
  return (
    nonEmpty(request.runId) &&
    nonEmpty(request.actionId) &&
    nonEmpty(request.idempotencyKey) &&
    /^[a-f0-9]{64}$/u.test(request.digest) &&
    request.payload.length <= CODING_TOOL_INVOCATION_MAX_BYTES_PER_ENTRY &&
    validExpiry(request.authorityExpiresAt)
  );
}

function validExpiry(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function expiryFor(authorityExpiresAt: string, now: number): number {
  return Math.min(Date.parse(authorityExpiresAt), now + MAX_TTL_MS);
}

function identity(request: InvocationIdentity): string {
  return `${request.runId}\u0000${request.actionId}\u0000${request.idempotencyKey}`;
}

function actionIdentity(request: Pick<CodingToolInvocationStage, "runId" | "actionId">): string {
  return `${request.runId}\u0000${request.actionId}`;
}

function idempotencyIdentity(
  request: Pick<CodingToolInvocationStage, "runId" | "idempotencyKey">,
): string {
  return `${request.runId}\u0000${request.idempotencyKey}`;
}

function keyForRun(key: string, runId: string): boolean {
  return key.startsWith(`${runId}\u0000`);
}

export function createCodingToolInvocationRegistry(
  options: CodingToolInvocationRegistryOptions = {},
): CodingToolInvocationRegistry {
  return new InvocationRegistry(options.now ?? Date.now);
}
