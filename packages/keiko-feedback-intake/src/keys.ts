import type { IntakeSecretKey, IntakeSecretProvider, IntakeSecretSnapshot } from "./types.js";

export class InMemorySecretRing implements IntakeSecretProvider {
  private active: IntakeSecretKey;
  private retained: IntakeSecretKey[] = [];
  readonly destroyed: string[] = [];

  constructor(
    initial: IntakeSecretKey,
    private readonly maxPredecessors: number,
  ) {
    if (maxPredecessors < 0 || maxPredecessors > 2) throw new Error("Invalid predecessor bound");
    this.active = snapshot(initial);
  }

  rotate(next: IntakeSecretKey): void {
    if (next.activatedAt.getTime() <= this.active.activatedAt.getTime()) {
      throw new Error("Key activation must advance");
    }
    this.retained.unshift(this.active);
    this.active = snapshot(next);
    while (this.retained.length > this.maxPredecessors) {
      const removed = this.retained.pop();
      if (removed !== undefined) this.destroyed.push(removed.id);
    }
  }

  snapshot(now: Date): IntakeSecretSnapshot {
    if (this.active.activatedAt.getTime() > now.getTime()) {
      throw new Error("No active key for current time");
    }
    return {
      active: snapshot(this.active),
      predecessors: this.retained.map(snapshot),
    };
  }

  destroy(keyId: string): Promise<void> {
    this.retained = this.retained.filter((key) => key.id !== keyId);
    this.destroyed.push(keyId);
    return Promise.resolve();
  }
}

function snapshot(value: IntakeSecretKey): IntakeSecretKey {
  return Object.freeze({
    id: value.id,
    key: Uint8Array.from(value.key),
    activatedAt: new Date(value.activatedAt),
  });
}
