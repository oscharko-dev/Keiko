import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CodingWorkbenchRuntimeAdapterKind } from "@oscharko-dev/keiko-contracts";

export type RuntimeCapabilityAudience = "model-gateway" | "tool-facade";

export interface RuntimeCapabilityBinding {
  readonly runId: string;
  readonly workspaceRootDigest: string;
  readonly envelopeDigest: string;
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly audience: RuntimeCapabilityAudience;
  readonly expiresAtMs: number;
}

export interface RuntimeCapabilityResolutionInput extends RuntimeCapabilityBinding {
  readonly capability: string;
  readonly nowMs: number;
}

export type RuntimeCapabilityIssue =
  | { readonly ok: true; readonly capability: string }
  | { readonly ok: false; readonly reason: "revoked" | "invalid" };

export type RuntimeCapabilityResolution =
  | { readonly ok: true; readonly binding: RuntimeCapabilityBinding }
  | { readonly ok: false; readonly reason: "invalid" | "expired" | "revoked" };

export interface RuntimeCapabilityStore {
  issue(binding: RuntimeCapabilityBinding): RuntimeCapabilityIssue;
  authenticate(capability: string, nowMs: number): RuntimeCapabilityResolution;
  resolve(input: RuntimeCapabilityResolutionInput): RuntimeCapabilityResolution;
  revokeRun(runId: string): void;
}

export interface RuntimeCapabilityStoreOptions {
  readonly maxRecords?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly newCapability?: (() => string) | undefined;
}

interface StoredCapability {
  readonly capabilityHash: string;
  readonly binding: RuntimeCapabilityBinding;
}

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CAPABILITY_AUDIENCES: ReadonlySet<string> = new Set(["model-gateway", "tool-facade"]);
const DEFAULT_MAX_RECORDS = 64;

/**
 * Holds only capability hashes. Delegation budgets, replay, and live-fact decisions remain in the
 * editor authority registry; this store only authenticates the private runtime-to-server capability.
 */
export function createInMemoryRuntimeCapabilityStore(
  options: RuntimeCapabilityStoreOptions = {},
): RuntimeCapabilityStore {
  return new InMemoryRuntimeCapabilityStore(options);
}

class InMemoryRuntimeCapabilityStore implements RuntimeCapabilityStore {
  private readonly maxRecords: number;
  private readonly nowMs: () => number;
  private readonly newCapability: () => string;
  private readonly records = new Map<string, StoredCapability>();
  private readonly revokedRuns = new Map<string, number>();

  public constructor(options: RuntimeCapabilityStoreOptions) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.nowMs = options.nowMs ?? Date.now;
    this.newCapability = options.newCapability ?? defaultCapability;
  }

  public issue(binding: RuntimeCapabilityBinding): RuntimeCapabilityIssue {
    if (!validBinding(binding)) return { ok: false, reason: "invalid" };
    pruneExpired(this.records, this.revokedRuns, this.nowMs());
    if (this.revokedRuns.has(binding.runId)) return { ok: false, reason: "revoked" };
    if (this.records.size >= this.maxRecords) return { ok: false, reason: "invalid" };
    const capability = this.newCapability();
    if (!CAPABILITY_PATTERN.test(capability)) return { ok: false, reason: "invalid" };
    const hash = capabilityHash(capability);
    if (this.records.has(hash)) return { ok: false, reason: "invalid" };
    this.records.set(hash, { capabilityHash: hash, binding });
    return { ok: true, capability };
  }

  public authenticate(capability: string, resolutionNowMs: number): RuntimeCapabilityResolution {
    if (!CAPABILITY_PATTERN.test(capability) || !Number.isSafeInteger(resolutionNowMs)) {
      return { ok: false, reason: "invalid" };
    }
    const hash = capabilityHash(capability);
    pruneExpired(this.records, this.revokedRuns, resolutionNowMs, hash);
    const record = this.records.get(hash);
    if (record === undefined || !constantTimeEqual(record.capabilityHash, hash)) {
      return { ok: false, reason: "invalid" };
    }
    if (this.revokedRuns.has(record.binding.runId)) return { ok: false, reason: "revoked" };
    if (record.binding.expiresAtMs <= resolutionNowMs) {
      this.records.delete(hash);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, binding: record.binding };
  }

  public resolve(input: RuntimeCapabilityResolutionInput): RuntimeCapabilityResolution {
    if (!validResolutionInput(input)) return { ok: false, reason: "invalid" };
    const authenticated = this.authenticate(input.capability, input.nowMs);
    if (!authenticated.ok) return authenticated;
    return bindingsEqual(authenticated.binding, input)
      ? authenticated
      : { ok: false, reason: "invalid" };
  }

  public revokeRun(runId: string): void {
    if (runId.length === 0) return;
    const expiry = [...this.records.values()]
      .filter((record) => record.binding.runId === runId)
      .reduce((latest, record) => Math.max(latest, record.binding.expiresAtMs), 0);
    if (expiry > this.nowMs()) this.revokedRuns.set(runId, expiry);
  }
}

function defaultCapability(): string {
  return randomBytes(32).toString("base64url");
}

function pruneExpired(
  records: Map<string, StoredCapability>,
  revokedRuns: Map<string, number>,
  nowMs: number,
  retainedHash?: string,
): void {
  for (const [hash, record] of records) {
    if (hash !== retainedHash && record.binding.expiresAtMs <= nowMs) records.delete(hash);
  }
  for (const [runId, expiresAtMs] of revokedRuns) {
    if (expiresAtMs <= nowMs) revokedRuns.delete(runId);
  }
}

function validResolutionInput(input: RuntimeCapabilityResolutionInput): boolean {
  return (
    validBinding(input) &&
    CAPABILITY_PATTERN.test(input.capability) &&
    Number.isSafeInteger(input.nowMs)
  );
}

function validBinding(binding: RuntimeCapabilityBinding): boolean {
  return (
    binding.runId.length > 0 &&
    DIGEST_PATTERN.test(binding.workspaceRootDigest) &&
    DIGEST_PATTERN.test(binding.envelopeDigest) &&
    ["model-gateway-sidecar", "codex-cli-adapter"].includes(binding.adapterKind) &&
    CAPABILITY_AUDIENCES.has(binding.audience) &&
    Number.isSafeInteger(binding.expiresAtMs) &&
    binding.expiresAtMs > 0
  );
}

function bindingsEqual(
  expected: RuntimeCapabilityBinding,
  actual: RuntimeCapabilityBinding,
): boolean {
  return (
    expected.runId === actual.runId &&
    expected.workspaceRootDigest === actual.workspaceRootDigest &&
    expected.envelopeDigest === actual.envelopeDigest &&
    expected.adapterKind === actual.adapterKind &&
    expected.audience === actual.audience &&
    expected.expiresAtMs === actual.expiresAtMs
  );
}

function capabilityHash(capability: string): string {
  return createHash("sha256").update(capability, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
