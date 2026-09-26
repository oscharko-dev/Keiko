import { describe, expect, it } from "vitest";

import {
  EDITOR_LANGUAGE_OPERATIONS,
  EMPTY_LANGUAGE_INTELLIGENCE_STATE,
  classifyLanguageFailure,
  classifyResultKind,
  controllerForToken,
  isCancellation,
  languageIntelligenceNotice,
  outcomeForError,
  reduceLanguageIntelligence,
  runLanguageBridgeCall,
  summarizeLanguageIntelligence,
  type EditorLanguageIntelligenceEvent,
  type LanguageBridgeCancellationToken,
  type LanguageBridgeDisposer,
} from "./language-intelligence.js";

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function named(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function sink(): {
  readonly events: EditorLanguageIntelligenceEvent[];
  report: (e: EditorLanguageIntelligenceEvent) => void;
} {
  const events: EditorLanguageIntelligenceEvent[] = [];
  return {
    events,
    report: (event): void => {
      events.push(event);
    },
  };
}

describe("isCancellation", () => {
  it("treats Monaco/host cancellation names as cancellation, not failure", () => {
    expect(isCancellation(abortError())).toBe(true);
    expect(isCancellation(named("CanceledError"))).toBe(true);
    expect(isCancellation(named("CancellationError"))).toBe(true);
  });

  it("recognizes an abort reported only through the message", () => {
    expect(isCancellation(new Error("request was aborted by the caller"))).toBe(true);
  });

  it("does not treat an ordinary fault as cancellation", () => {
    expect(isCancellation(new Error("language service crashed"))).toBe(false);
    expect(isCancellation("not an error")).toBe(false);
    expect(isCancellation(undefined)).toBe(false);
  });
});

describe("classifyLanguageFailure", () => {
  it("classifies a deadline as a timeout", () => {
    expect(classifyLanguageFailure(named("TimeoutError"))).toBe("timeout");
    expect(classifyLanguageFailure(named("DeadlineExceededError"))).toBe("timeout");
    expect(classifyLanguageFailure(new Error("Language request timed out"))).toBe("timeout");
    expect(classifyLanguageFailure(new Error("deadline exceeded"))).toBe("timeout");
  });

  it("classifies an unreachable responder as a transport failure", () => {
    expect(classifyLanguageFailure(new TypeError("Failed to fetch"))).toBe("transport");
    expect(classifyLanguageFailure(new Error("Load failed"))).toBe("transport");
    expect(classifyLanguageFailure(new Error("ECONNREFUSED 127.0.0.1:1983"))).toBe("transport");
    expect(classifyLanguageFailure(new Error("network error"))).toBe("transport");
    expect(classifyLanguageFailure(new Error("socket hang up"))).toBe("transport");
  });

  it("classifies anything else — including a non-Error rejection — as a provider failure", () => {
    expect(classifyLanguageFailure(new Error("language service crashed"))).toBe("provider");
    expect(classifyLanguageFailure("string rejection")).toBe("provider");
    expect(classifyLanguageFailure(null)).toBe("provider");
  });

  it("prefers the timeout class when a message mentions both a timeout and the network", () => {
    expect(classifyLanguageFailure(new Error("network request timed out"))).toBe("timeout");
  });
});

describe("outcomeForError", () => {
  it("maps cancellation to its own status so it is never surfaced as a failure", () => {
    expect(outcomeForError(abortError())).toEqual({ status: "cancelled" });
  });

  it("maps a fault to a classified failure", () => {
    expect(outcomeForError(named("TimeoutError"))).toEqual({
      status: "failed",
      failure: "timeout",
    });
  });
});

describe("classifyResultKind", () => {
  it("distinguishes an answer from an empty answer", () => {
    expect(classifyResultKind(3)).toBe("ok");
    expect(classifyResultKind(0)).toBe("empty");
  });

  it("labels a capped result even when the cap dropped everything", () => {
    expect(classifyResultKind(7, true)).toBe("capped");
    expect(classifyResultKind(0, true)).toBe("capped");
  });

  it("treats an explicit false cap as no cap", () => {
    expect(classifyResultKind(2, false)).toBe("ok");
  });
});

describe("runLanguageBridgeCall", () => {
  it("reports the result kind and presents the value on success", async () => {
    const { events, report } = sink();
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "hover",
      resolve: () => Promise.resolve({ items: [1, 2] }),
      discardedValue: "discarded",
      failedValue: "failed",
      classify: (response) => classifyResultKind(response.items.length),
      present: (response) => `items:${String(response.items.length)}`,
      report,
    });

    expect(value).toBe("items:2");
    expect(events).toEqual([{ operation: "hover", outcome: { status: "ok" } }]);
  });

  it("reports a genuinely empty result as empty, not as a failure", async () => {
    const { events, report } = sink();
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "references",
      resolve: () => Promise.resolve({ items: [] }),
      discardedValue: "discarded",
      failedValue: "failed",
      classify: (response) => classifyResultKind(response.items.length),
      present: () => "empty-presentation",
      report,
    });

    expect(value).toBe("empty-presentation");
    expect(events).toEqual([{ operation: "references", outcome: { status: "empty" } }]);
  });

  it("returns Monaco's empty value on rejection AND reports the classified failure", async () => {
    const { events, report } = sink();
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "definition",
      resolve: () => Promise.reject(named("TimeoutError")),
      discardedValue: "discarded",
      failedValue: "failed",
      classify: () => "ok",
      present: () => "presented",
      report,
    });

    // Monaco's contract is preserved: a value, never a throw.
    expect(value).toBe("failed");
    expect(events).toEqual([
      { operation: "definition", outcome: { status: "failed", failure: "timeout" } },
    ]);
  });

  it("neither presents nor reports a superseded response", async () => {
    const { events, report } = sink();
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "completion",
      resolve: () => Promise.resolve({ items: [] }),
      isDiscarded: () => true,
      discardedValue: "discarded",
      failedValue: "failed",
      classify: () => "empty",
      present: () => "presented",
      report,
    });

    expect(value).toBe("discarded");
    expect(events).toEqual([]);
  });

  it("reports cancellation as cancelled so a superseded keystroke is not an error", async () => {
    const { events, report } = sink();
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "hover",
      resolve: () => Promise.reject(abortError()),
      discardedValue: "discarded",
      failedValue: "failed",
      classify: () => "ok",
      present: () => "presented",
      report,
    });

    expect(value).toBe("failed");
    expect(events).toEqual([{ operation: "hover", outcome: { status: "cancelled" } }]);
  });

  it("still returns the empty value when the host wires no reporter", async () => {
    const value = await runLanguageBridgeCall<{ items: number[] }, string>({
      operation: "symbols",
      resolve: () => Promise.reject(new Error("crash")),
      discardedValue: "discarded",
      failedValue: "failed",
      classify: () => "ok",
      present: () => "presented",
    });

    expect(value).toBe("failed");
  });
});

describe("reduceLanguageIntelligence", () => {
  it("records the latest status per operation", () => {
    const state = reduceLanguageIntelligence(EMPTY_LANGUAGE_INTELLIGENCE_STATE, {
      operation: "hover",
      outcome: { status: "failed", failure: "provider" },
    });

    expect(state.statuses).toEqual({ hover: "failed" });
  });

  it("clears a failure once the same operation answers again", () => {
    const failed = reduceLanguageIntelligence(EMPTY_LANGUAGE_INTELLIGENCE_STATE, {
      operation: "hover",
      outcome: { status: "failed", failure: "provider" },
    });
    const recovered = reduceLanguageIntelligence(failed, {
      operation: "hover",
      outcome: { status: "empty" },
    });

    expect(recovered.statuses).toEqual({ hover: "empty" });
    expect(summarizeLanguageIntelligence(recovered).failed).toEqual([]);
  });

  it("returns the SAME state for cancellation, so a superseded keystroke cannot churn the host", () => {
    const state = reduceLanguageIntelligence(EMPTY_LANGUAGE_INTELLIGENCE_STATE, {
      operation: "hover",
      outcome: { status: "cancelled" },
    });

    expect(state).toBe(EMPTY_LANGUAGE_INTELLIGENCE_STATE);
  });

  it("returns the SAME state when the status did not change", () => {
    const first = reduceLanguageIntelligence(EMPTY_LANGUAGE_INTELLIGENCE_STATE, {
      operation: "diagnostics",
      outcome: { status: "ok" },
    });
    const second = reduceLanguageIntelligence(first, {
      operation: "diagnostics",
      outcome: { status: "ok" },
    });

    expect(second).toBe(first);
  });
});

describe("summarizeLanguageIntelligence", () => {
  it("splits failing from capped operations in canonical order", () => {
    let state = EMPTY_LANGUAGE_INTELLIGENCE_STATE;
    // Reported in reverse canonical order on purpose: the summary must not depend on arrival order.
    state = reduceLanguageIntelligence(state, {
      operation: "formatting",
      outcome: { status: "capped" },
    });
    state = reduceLanguageIntelligence(state, {
      operation: "hover",
      outcome: { status: "capped" },
    });
    state = reduceLanguageIntelligence(state, {
      operation: "references",
      outcome: { status: "failed", failure: "transport" },
    });
    state = reduceLanguageIntelligence(state, {
      operation: "diagnostics",
      outcome: { status: "failed", failure: "provider" },
    });

    expect(summarizeLanguageIntelligence(state)).toEqual({
      failed: ["diagnostics", "references"],
      capped: ["hover", "formatting"],
    });
  });

  it("reports nothing when every observed operation answered in full", () => {
    const state = reduceLanguageIntelligence(EMPTY_LANGUAGE_INTELLIGENCE_STATE, {
      operation: "hover",
      outcome: { status: "empty" },
    });

    expect(summarizeLanguageIntelligence(state)).toEqual({ failed: [], capped: [] });
  });
});

describe("languageIntelligenceNotice", () => {
  it("is null when nothing failed or was capped", () => {
    expect(languageIntelligenceNotice({ failed: [], capped: [] })).toBeNull();
  });

  it("prefers a failure over a cap", () => {
    expect(languageIntelligenceNotice({ failed: ["hover"], capped: ["references"] })).toEqual({
      status: "failed",
      operation: "hover",
      operationCount: 1,
    });
  });

  it("counts every affected operation so the host can say 'and N more'", () => {
    expect(
      languageIntelligenceNotice({ failed: ["diagnostics", "hover", "symbols"], capped: [] }),
    ).toEqual({ status: "failed", operation: "diagnostics", operationCount: 3 });
  });

  it("surfaces a cap when nothing failed", () => {
    expect(languageIntelligenceNotice({ failed: [], capped: ["references", "symbols"] })).toEqual({
      status: "capped",
      operation: "references",
      operationCount: 2,
    });
  });
});

describe("EDITOR_LANGUAGE_OPERATIONS", () => {
  it("lists every operation exactly once", () => {
    expect(new Set(EDITOR_LANGUAGE_OPERATIONS).size).toBe(EDITOR_LANGUAGE_OPERATIONS.length);
    expect(EDITOR_LANGUAGE_OPERATIONS).toHaveLength(14);
  });
});

// #2906 round-3 review: onCancellationRequested returns an IDisposable for the listener it
// registers. A fake token that behaves like Monaco's real one -- dispose() actually unregisters the
// listener, so a fired cancellation after dispose is a no-op -- proves both that the disposer is
// returned to the caller at all (the old signature made that a compile error) and that calling it
// really releases the subscription rather than merely existing on the return value.
function fakeCancellationToken(initiallyCancelled = false): {
  readonly token: LanguageBridgeCancellationToken;
  readonly fire: () => void;
  readonly listenerInvocations: { count: number };
  readonly disposeCalls: { count: number };
} {
  let listener: (() => void) | undefined;
  const listenerInvocations = { count: 0 };
  const disposeCalls = { count: 0 };
  const token: LanguageBridgeCancellationToken = {
    isCancellationRequested: initiallyCancelled,
    onCancellationRequested(next): LanguageBridgeDisposer {
      // Wraps (rather than assigns) `next` so `listenerInvocations` counts only actual deliveries
      // of the registered listener -- not every `fire()` call, which must be a no-op post-dispose.
      listener = (): void => {
        listenerInvocations.count += 1;
        next();
      };
      return {
        dispose(): void {
          disposeCalls.count += 1;
          listener = undefined;
        },
      };
    },
  };
  return {
    token,
    fire: (): void => listener?.(),
    listenerInvocations,
    disposeCalls,
  };
}

describe("controllerForToken", () => {
  it("aborts immediately when the token has already fired", () => {
    const { token } = fakeCancellationToken(true);
    const { controller } = controllerForToken(token);
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts when the token later fires cancellation", () => {
    const { token, fire } = fakeCancellationToken();
    const { controller } = controllerForToken(token);
    expect(controller.signal.aborted).toBe(false);
    fire();
    expect(controller.signal.aborted).toBe(true);
  });

  it("releases the underlying cancellation subscription when dispose() is called", () => {
    const { token, disposeCalls } = fakeCancellationToken();
    const { dispose } = controllerForToken(token);
    expect(disposeCalls.count).toBe(0);
    dispose();
    expect(disposeCalls.count).toBe(1);
  });

  // The regression: before this fix, the shared helper dropped onCancellationRequested's
  // IDisposable outright, so a bridge had no way to release the listener a successful,
  // never-cancelled call leaves registered -- it lived until Monaco destroyed the token source.
  it("stops the listener from firing again once disposed, matching a real Monaco IDisposable", () => {
    const { token, fire, listenerInvocations } = fakeCancellationToken();
    const { controller, dispose } = controllerForToken(token);
    dispose();
    fire();
    expect(listenerInvocations.count).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });
});
