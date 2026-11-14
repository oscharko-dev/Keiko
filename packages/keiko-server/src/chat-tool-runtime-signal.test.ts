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
function fakeTurn(settled: boolean, clockLagMs = 0): FakeTurn {
  const controller = new AbortController();
  // The turn's own timer fires at DEADLINE_MS; the wall clock reaches `deadlineAtMs` only `clockLagMs` later.
  const deadlineAtMs = Date.now() + DEADLINE_MS + clockLagMs;
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

/** The port with a recording hook; the readouts stay live getters, as a spread would freeze them. */
function recordingPort(
  port: FakeTurn["port"],
  recordEnding: (reason: string) => void,
): FakeTurn["port"] {
  return Object.defineProperties(
    { recordEnding },
    Object.getOwnPropertyDescriptors(port),
  ) as FakeTurn["port"];
}

function install(
  settled: boolean,
  clockLagMs = 0,
  endings: string[] = [],
): {
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
  const turn = fakeTurn(settled, clockLagMs);
  const human = new AbortController();
  return {
    turn,
    human,
    signal: chatToolTurnCancellationSignal(
      human.signal,
      recordingPort(turn.port, (reason): void => {
        endings.push(reason);
      }),
      "c-1",
    ),
  };
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

// #4355: the deadline is the signal that fired, not a comparison of the wall clock with the deadline
// inside the timer's own callback. CI run 43596154016 ended an accepted write as "CANCELLED".
describe("which signal fired decides, never the wall clock (#4355)", () => {
  it("answers at the deadline when the turn's signal fires before the wall clock reaches it", async () => {
    const { signal } = install(true, 1);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal.aborted).toBe(false);
  });

  it("still cancels at an early deadline when no exchange settled", async () => {
    const { signal } = install(false, 1);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(signal.aborted).toBe(true);
  });

  it("treats an authority revocation as a revocation even after the wall clock passed the deadline", async () => {
    const { signal, turn } = install(true, -5);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 5);
    expect(signal.aborted).toBe(false);
    turn.controller.abort(new DOMException("Authority revoked", "AbortError"));
    expect(signal.aborted).toBe(true);
  });

  it("the first cause wins: a stop that fired before the deadline in the same tick cancels with its own reason", () => {
    const { signal, turn, human } = install(true);
    const reasons: unknown[] = [];
    signal.addEventListener("abort", () => reasons.push(signal.reason), { once: true });
    human.abort(new Error("person stopped"));
    turn.controller.abort(new DOMException("Deadline reached", "TimeoutError"));
    expect(signal.aborted).toBe(true);
    expect(String(reasons[0])).toContain("person stopped");
  });

  it("the first cause wins: a deadline that fired before the stop in the same tick answers, and the stop then cancels only the delivery", () => {
    const { signal, turn, human } = install(true);
    turn.controller.abort(new DOMException("Deadline reached", "TimeoutError"));
    expect(signal.aborted).toBe(false);
    human.abort(new Error("person stopped"));
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason)).toContain("person stopped");
  });
});

describe("the turn records why it ended without an answer (#4355)", () => {
  it("records deadline-cancelled once when the deadline fires and nothing settled", async () => {
    const endings: string[] = [];
    install(false, 0, endings);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 2);
    expect(endings).toEqual(["deadline-cancelled"]);
  });
  it("records nothing when the deadline answers from the transcript", async () => {
    const endings: string[] = [];
    install(true, 0, endings);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 2);
    expect(endings).toEqual([]);
  });
  it("records request-aborted when the request signal aborts, a stop and a dropped connection alike", () => {
    const endings: string[] = [];
    const { human } = install(true, 0, endings);
    human.abort();
    expect(endings).toEqual(["request-aborted"]);
  });
  it("records request-aborted once for a stop that follows a deadline answer, and nothing for the deadline", async () => {
    const endings: string[] = [];
    const { human } = install(true, 0, endings);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    human.abort();
    expect(endings).toEqual(["request-aborted"]);
  });
  it("records request-aborted for a request that was already aborted", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const endings: string[] = [];
    const human = new AbortController();
    human.abort();
    chatToolTurnCancellationSignal(
      human.signal,
      recordingPort(fakeTurn(true).port, (reason): void => {
        endings.push(reason);
      }),
      "c-1",
    );
    expect(endings).toEqual(["request-aborted"]);
  });
  it("keeps a recording failure out of the abort listener", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const human = new AbortController();
    chatToolTurnCancellationSignal(
      human.signal,
      recordingPort(fakeTurn(true).port, (): void => {
        throw new Error("sink closed");
      }),
      "c-1",
    );
    expect(() => {
      human.abort();
    }).not.toThrow();
  });
});
