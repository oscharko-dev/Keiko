import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The capability bookkeeping every credential relay shares (the MCP relay of #3903 AC3 and the
 * repository relay of #4522): a relay id and a capability minted per binding, the capability held
 * only as a SHA-256 digest and compared in constant time, a binding revoked when its run is
 * released or its signal aborts, and a bounded memory of revoked capabilities so a late request can
 * be told why it was refused. A relay keeps what it forwards and how; this store keeps who may.
 */
const RELAY_ID = /^[A-Za-z0-9_-]{22}$/u;
const DEFAULT_MAX_BINDINGS = 256;
/** Revoked capabilities remembered so a late request can be told why it was refused. */
const MAX_REVOKED_BINDINGS = 1024;

export interface RelayStoreTarget {
  readonly runId: string;
  readonly signal?: AbortSignal | undefined;
}

export interface RelayBinding {
  readonly relayId: string;
  readonly capability: string;
}

export interface RelayAdmission<Target extends RelayStoreTarget> {
  readonly target: Target;
  /** Aborted once the binding is revoked, which ends every exchange it still holds. */
  readonly signal: AbortSignal;
}

export interface RelayCapabilityStoreOptions<Target extends RelayStoreTarget> {
  /** The immutable copy the store keeps of a bound target. */
  readonly freeze: (target: Target) => Target;
  readonly maxBindings?: number;
  /** Called once per binding, after it was revoked by its signal or by `releaseRun`. */
  readonly onRevoke?: (target: Target) => void;
}

interface StoredBinding<Target extends RelayStoreTarget> {
  readonly capabilityHash: Buffer;
  readonly target: Target;
  readonly controller: AbortController;
  readonly detach: () => void;
}

export function relayCapabilityHash(capability: string): Buffer {
  return createHash("sha256").update(capability, "utf8").digest();
}

export class RelayCapabilityStore<Target extends RelayStoreTarget> {
  private readonly bindings = new Map<string, StoredBinding<Target>>();
  private readonly revoked = new Map<string, Buffer>();
  private readonly maxBindings: number;

  public constructor(private readonly options: RelayCapabilityStoreOptions<Target>) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS;
  }

  private remember(relayId: string, stored: StoredBinding<Target>): void {
    this.revoked.set(relayId, stored.capabilityHash);
    if (this.revoked.size > MAX_REVOKED_BINDINGS) {
      const [oldest] = this.revoked.keys();
      if (oldest !== undefined) this.revoked.delete(oldest);
    }
  }

  private revoke(relayId: string): void {
    const stored = this.bindings.get(relayId);
    if (stored === undefined) return;
    stored.controller.abort();
    stored.detach();
    this.remember(relayId, stored);
    this.bindings.delete(relayId);
    this.options.onRevoke?.(stored.target);
  }

  /**
   * Whether this exact capability once belonged to a binding that was revoked. The proof of the
   * capability is required, so an unauthenticated caller learns nothing about relay ids.
   */
  public wasRevoked(relayId: string, capability: string | undefined): boolean {
    const hash = this.revoked.get(relayId);
    return (
      hash !== undefined &&
      capability !== undefined &&
      timingSafeEqual(hash, relayCapabilityHash(capability))
    );
  }

  /** A capability for one run and one target; `undefined` when the store holds its maximum. */
  public bind(target: Target): RelayBinding | undefined {
    if (this.bindings.size >= this.maxBindings || target.signal?.aborted === true) return undefined;
    const relayId = randomBytes(16).toString("base64url");
    const capability = randomBytes(32).toString("base64url");
    const revoke = (): void => {
      this.revoke(relayId);
    };
    target.signal?.addEventListener("abort", revoke, { once: true });
    this.bindings.set(relayId, {
      capabilityHash: relayCapabilityHash(capability),
      target: this.options.freeze(target),
      controller: new AbortController(),
      detach: () => target.signal?.removeEventListener("abort", revoke),
    });
    return { relayId, capability };
  }

  public authenticate(
    relayId: string,
    capability: string | undefined,
  ): RelayAdmission<Target> | undefined {
    if (!RELAY_ID.test(relayId) || capability === undefined) return undefined;
    const stored = this.bindings.get(relayId);
    if (stored === undefined) return undefined;
    if (!timingSafeEqual(stored.capabilityHash, relayCapabilityHash(capability))) return undefined;
    return { target: stored.target, signal: stored.controller.signal };
  }

  public releaseRun(runId: string): void {
    for (const [relayId, stored] of [...this.bindings]) {
      if (stored.target.runId === runId) this.revoke(relayId);
    }
  }
}

/**
 * The credential as a reflecting server may return it: each value, and the base64 and base64url
 * text any byte alignment of it produces. A caller hands these to the secret-spelling stream
 * redactor (or scans for them) so a credential cannot reach a run in a spelling a parser restores.
 */
export function relayCredentialSpellings(values: readonly string[]): readonly string[] {
  return [...new Set([...values, ...values.flatMap(base64Cores)])];
}

// The characters every base64 text holding `value` contains, at each of the three byte alignments:
// the characters that depend on a neighbouring byte at either end are left out. An admitted
// credential has at least 16 characters, so each core has at least 20.
export function base64Cores(value: string): readonly string[] {
  const bytes = Buffer.from(value, "utf8");
  return [0, 1, 2].flatMap((offset) => {
    // base64url carries no padding; the standard alphabet differs only in two characters.
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64url");
    const head = [0, 2, 3][offset] ?? 0;
    const tail = (offset + bytes.length) % 3 === 0 ? 0 : 1;
    const core = encoded.slice(head, encoded.length - tail);
    return [core.replaceAll("-", "+").replaceAll("_", "/"), core];
  });
}
