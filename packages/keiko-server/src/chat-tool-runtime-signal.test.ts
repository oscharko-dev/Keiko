import { afterEach, describe, expect, it, vi } from "vitest";
import { chatToolTurnCancellationSignal } from "./chat-tool-runtime.js";

const DEADLINE_MS = 10_000;

afterEach(() => {
  vi.useRealTimers();
});

interface FakeTurn {
  readonly controller: AbortController;
  settled: boolean;
  scopeChangeEnded: boolean;
  readonly port: Parameters<typeof chatToolTurnCancellationSignal>[1];
}

/** A turn whose own signal fires at its deadline, as the authority factories compose it. */
function fakeTurn(settled: boolean): FakeTurn {
  const controller = new AbortController();
  const deadlineAtMs = Date.now() + DEADLINE_MS;
  setTimeout(() => {
    controller.abort(new DOMException("Deadline reached", "TimeoutError"));
  }, DEADLINE_MS);
  const turn: FakeTurn = {
    controller,
    settled,
    scopeChangeEnded: false,
    port: {
      signal: controller.signal,
      deadlineAtMs,
      get answersAtDeadline(): boolean {
        return turn.settled;
      },
      get answersAfterScopeChange(): boolean {
        return turn.scopeChangeEnded;
      },
    },
  };
  return turn;
}

function install(settled: boolean): {
  readonly turn: FakeTurn;
  readonly human: AbortController;
  readonly signal: AbortSignal;
} {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new DOMException("Deadline reached", "TimeoutError"));
    }, milliseconds);
    return controller.signal;
  });
  const turn = fakeTurn(settled);
  const human = new AbortController();
  return { turn, human, signal: chatToolTurnCancellationSignal(human.signal, turn.port, "c-1") };
}

describe("chatToolTurnCancellationSignal", () => {
  it("does not cancel at the deadline when the turn settled an exchange", async () => {
    const { signal } = install(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    expect(signal.aborted).toBe(false);
  });

  it("cancels at the deadline when no exchange settled", async () => {
    const { signal } = install(false);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal.aborted).toBe(true);
  });

  it("cancels a human stop before the deadline although an exchange settled", async () => {
    const { signal, human } = install(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 2);
    human.abort();
    expect(signal.aborted).toBe(true);
  });

  it("cancels a human stop after the deadline passed with a settled exchange", async () => {
    const { signal, human } = install(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    expect(signal.aborted).toBe(false);
    human.abort();
    expect(signal.aborted).toBe(true);
  });

  it("cancels an authority revocation before the deadline although an exchange settled", async () => {
    const { signal, turn } = install(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 2);
    turn.controller.abort(new DOMException("Authority revoked", "AbortError"));
    expect(signal.aborted).toBe(true);
  });

  it("does not cancel the answer of a turn that a change of the Chat's scope ended", async () => {
    const { signal, turn, human } = install(true);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS / 2);
    turn.scopeChangeEnded = true;
    turn.controller.abort();
    expect(signal.aborted).toBe(false);
    human.abort();
    expect(signal.aborted).toBe(true);
  });

  it("cancels instead of ending the process when the turn's state cannot be read", async () => {
    // The lab lost a whole run this way: a deadline fired after the store had closed.
    const { turn, human } = install(true);
    const signal = chatToolTurnCancellationSignal(
      human.signal,
      {
        ...turn.port,
        get answersAfterScopeChange(): boolean {
          return false;
        },
        get answersAtDeadline(): boolean {
          throw new Error("database is not open");
        },
      },
      "c-1",
    );
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    expect(signal.aborted).toBe(true);
  });

  it("starts cancelled when the human signal is already aborted", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const turn = fakeTurn(true);
    const human = new AbortController();
    human.abort();
    expect(chatToolTurnCancellationSignal(human.signal, turn.port, "c-1").aborted).toBe(true);
  });
});
