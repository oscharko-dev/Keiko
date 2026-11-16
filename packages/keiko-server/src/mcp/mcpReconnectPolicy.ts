import { ManagedMcpError } from "@oscharko-dev/keiko-mcp";

/** A connection that timed out this many calls in a row, without one success between, is recycled. */
export const HUNG_TIMEOUTS_BEFORE_RECYCLE = 3;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

interface ServerState {
  failures: number;
  notBefore: number;
}

/**
 * Exponential reconnect backoff (5 s doubling to 60 s) per server name. A crashing server was
 * re-spawned on every call; during backoff a call now fails at once with the closed `backoff` code
 * instead of spawning a process or waiting out a 30 s deadline. The first failure reconnects at
 * once (one restart of a healthy server costs nothing); the second consecutive one waits 5 s, the
 * third 10 s, and so on up to 60 s. A success resets the server.
 */
export class McpReconnectPolicy {
  readonly #state = new Map<string, ServerState>();

  public constructor(private readonly now: () => number = Date.now) {}

  public static delayAfter(failures: number): number {
    if (failures < 2) return 0;
    return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 2));
  }

  /** Throws the closed `backoff` error while a new connection is not allowed yet. */
  public admit(name: string): void {
    const state = this.#state.get(name);
    if (state !== undefined && this.now() < state.notBefore) throw new ManagedMcpError("backoff");
  }

  /** Remaining wait for the closed log field; zero when a connection is allowed. */
  public remainingMs(name: string): number {
    const state = this.#state.get(name);
    return state === undefined ? 0 : Math.max(0, state.notBefore - this.now());
  }

  public failures(name: string): number {
    return this.#state.get(name)?.failures ?? 0;
  }

  public failed(name: string): number {
    const failures = (this.#state.get(name)?.failures ?? 0) + 1;
    this.#state.set(name, {
      failures,
      notBefore: this.now() + McpReconnectPolicy.delayAfter(failures),
    });
    return failures;
  }

  public succeeded(name: string): void {
    this.#state.delete(name);
  }
}
