export type OpenCodeEventKind = "observation" | "permission" | "question" | "tool" | "terminal";
export interface OpenCodeReconciliationEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly digest: string;
  readonly kind: OpenCodeEventKind;
}
export interface OpenCodeProjection {
  readonly id: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly kind: OpenCodeEventKind;
  readonly digest: string;
}
export type OpenCodeReconciliationResult =
  | {
      readonly ok: true;
      readonly applied: number;
      readonly projections: readonly OpenCodeProjection[];
    }
  | {
      readonly ok: false;
      readonly reason: "sequence-gap" | "sequence-conflict" | "staging-overflow" | "invalid-event";
    };
export interface OpenCodeReconciler {
  ingest(events: readonly OpenCodeReconciliationEvent[]): OpenCodeReconciliationResult;
  checkpoints(): Readonly<Record<string, number>>;
  staging(): Readonly<{ events: number; bytes: number; observations: number; critical: number }>;
}
export interface OpenCodeReconcilerOptions {
  readonly now?: (() => number) | undefined;
  readonly maxEvents?: number | undefined;
  readonly maxBytes?: number | undefined;
}
const MAX_EVENTS = 256;
const MAX_BYTES = 1024 * 1024;

/** In-memory, content-free reconciliation gate. It never executes effects or recharges budgets. */
// eslint-disable-next-line max-lines-per-function -- bounded ordering and failure gates stay co-located for audit.
export function createOpenCodeReconciler(
  options: OpenCodeReconcilerOptions = {},
): OpenCodeReconciler {
  const now = options.now ?? Date.now;
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const checkpoint = new Map<string, number>();
  const identities = new Map<string, string>();
  const digests = new Set<string>();
  const staged: OpenCodeReconciliationEvent[] = [];
  let stagedBytes = 0;
  let lastObservationAt = Number.NEGATIVE_INFINITY;
  return {
    // eslint-disable-next-line complexity -- each ordering and retention gate fails closed independently.
    ingest(events): OpenCodeReconciliationResult {
      const projections: OpenCodeProjection[] = [];
      let applied = 0;
      for (const event of events) {
        if (!valid(event)) return { ok: false, reason: "invalid-event" };
        const identity = `${event.aggregateId}\u0000${String(event.sequence)}`;
        const known = identities.get(identity);
        if (known !== undefined) {
          if (known !== event.digest) return { ok: false, reason: "sequence-conflict" };
          continue;
        }
        if (digests.has(event.digest)) continue;
        const expected = checkpoint.get(event.aggregateId);
        if (expected !== undefined && event.sequence !== expected + 1)
          return {
            ok: false,
            reason: event.sequence <= expected ? "sequence-conflict" : "sequence-gap",
          };
        const size = new TextEncoder().encode(JSON.stringify(event)).length;
        if (!makeRoom(staged, maxEvents, maxBytes, stagedBytes, size))
          return { ok: false, reason: "staging-overflow" };
        stagedBytes = staged.reduce((total, item) => total + eventBytes(item), 0);
        staged.push(event);
        stagedBytes += size;
        identities.set(identity, event.digest);
        digests.add(event.digest);
        checkpoint.set(event.aggregateId, event.sequence);
        applied += 1;
        const observedAt = now();
        if (event.kind !== "observation" || observedAt - lastObservationAt >= 100) {
          projections.push(project(event));
          if (event.kind === "observation") lastObservationAt = observedAt;
        }
      }
      return { ok: true, applied, projections };
    },
    checkpoints(): Readonly<Record<string, number>> {
      return Object.freeze(Object.fromEntries(checkpoint));
    },
    staging(): Readonly<{ events: number; bytes: number; observations: number; critical: number }> {
      const observations = staged.filter((event) => event.kind === "observation").length;
      return Object.freeze({
        events: staged.length,
        bytes: stagedBytes,
        observations,
        critical: staged.length - observations,
      });
    },
  };
}
function makeRoom(
  staged: OpenCodeReconciliationEvent[],
  maxEvents: number,
  maxBytes: number,
  currentBytes: number,
  incomingBytes: number,
): boolean {
  let bytes = currentBytes;
  while (staged.length >= maxEvents || bytes + incomingBytes > maxBytes) {
    const index = staged.findIndex((event) => event.kind === "observation");
    if (index < 0) return false;
    const removed = staged.splice(index, 1)[0];
    if (removed === undefined) return false;
    bytes -= eventBytes(removed);
  }
  return true;
}
function eventBytes(event: OpenCodeReconciliationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).length;
}
function valid(event: OpenCodeReconciliationEvent): boolean {
  return (
    event.id.length > 0 &&
    event.aggregateId.length > 0 &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    /^[0-9a-f]{64}$/u.test(event.digest) &&
    ["observation", "permission", "question", "tool", "terminal"].includes(event.kind)
  );
}
function project(event: OpenCodeReconciliationEvent): OpenCodeProjection {
  return {
    id: event.id,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
    kind: event.kind,
    digest: event.digest,
  };
}
