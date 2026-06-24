// Unit tests for context-observations.ts + context-observations-validation.ts (ADR-0054, PR3-W1).
// Each validator test mutates exactly one field of a known-good fixture so a single-line
// implementation mutation is caught. Discriminated-union dispatch routes by kind. The forward-
// defined browser type validates. Backward compat pins the absent-optional shapes: a
// CommandResult without omittedByteCount and a ToolCallResult without shapedObservation still type.

import { describe, expect, it } from "vitest";
import { CONTEXT_ENGINEERING_SCHEMA_VERSION } from "./context-engineering.js";
import {
  MAX_FAILING_TEST_NAMES,
  MAX_OBSERVATION_EXCERPT_BYTES,
  MAX_OBSERVATION_QUERY_BYTES,
  MAX_STACK_FRAME_LINES,
  MAX_TOP_RANGES,
} from "./context-observations.js";
import type {
  ContextToolObservation,
  ContextToolRehydrationHandle,
  ShapedBrowserObservation,
  ShapedCommandObservation,
  ShapedSearchObservation,
  ShapedTestObservation,
} from "./context-observations.js";
import {
  isContextToolObservationKind,
  validateContextToolObservation,
  validateContextToolRehydrationHandle,
  validateShapedBrowserObservation,
  validateShapedCommandObservation,
  validateShapedSearchObservation,
  validateShapedTestObservation,
} from "./context-observations-validation.js";
import type { CommandResult, ToolCallResult } from "./tools.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
function happyHandle(): ContextToolRehydrationHandle {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "tool-observations",
    kind: "tool-result",
    artifactId: "a".repeat(64),
    itemCount: 1,
    approxTokens: 42,
  };
}

function happyCommand(): ShapedCommandObservation {
  return {
    kind: "command",
    observationId: "obs-cmd-1",
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    truncated: false,
    excerpts: [
      { stream: "stdout", bytes: 5, text: "hello" },
      { stream: "stderr", bytes: 0, text: "" },
    ],
    injectionSignalCount: 0,
    hasCriticalInjectionSignal: false,
    rehydration: happyHandle(),
  };
}

function happyTest(): ShapedTestObservation {
  return {
    kind: "test",
    observationId: "obs-test-1",
    verificationKind: "unit-test",
    status: "fail",
    exitCode: 1,
    durationMs: 200,
    truncated: false,
    counts: { passed: 3, failed: 2, skipped: 0 },
    failingTestNames: ["a fails", "b fails"],
    stackFrameExcerpts: ["at foo (x.ts:1)"],
    outputSummary: "2 failing",
    injectionSignalCount: 0,
  };
}

function happySearch(): ShapedSearchObservation {
  return {
    kind: "search",
    observationId: "obs-search-1",
    query: "where is the governor",
    searchKind: "text",
    candidateCount: 12,
    topRanges: [{ scopePath: "src/index.ts", startLine: 1, endLine: 5, score: 0.9 }],
    omittedCount: 11,
    truncated: true,
  };
}

function happyBrowser(): ShapedBrowserObservation {
  return {
    kind: "browser",
    observationId: "obs-browser-1",
    checkDescription: "/ route axe scan",
    passed: true,
    durationMs: 300,
    a11yViolationCount: 0,
  };
}

// ─── ContextToolRehydrationHandle ──────────────────────────────────────────────
describe("validateContextToolRehydrationHandle", () => {
  it("accepts a happy handle", () => {
    expect(validateContextToolRehydrationHandle(happyHandle())).toEqual({ ok: true });
  });

  it("rejects a non-record", () => {
    expect(validateContextToolRehydrationHandle(null).ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(validateContextToolRehydrationHandle({ ...happyHandle(), schemaVersion: "2" }).ok).toBe(
      false,
    );
  });

  it("rejects an invalid laneId", () => {
    expect(validateContextToolRehydrationHandle({ ...happyHandle(), laneId: "bogus" }).ok).toBe(
      false,
    );
  });

  it("rejects a wrong kind", () => {
    expect(validateContextToolRehydrationHandle({ ...happyHandle(), kind: "repo-file" }).ok).toBe(
      false,
    );
  });

  it("rejects an empty artifactId", () => {
    expect(validateContextToolRehydrationHandle({ ...happyHandle(), artifactId: "" }).ok).toBe(
      false,
    );
  });

  it("rejects a negative itemCount", () => {
    expect(validateContextToolRehydrationHandle({ ...happyHandle(), itemCount: -1 }).ok).toBe(
      false,
    );
  });

  it("rejects a non-finite approxTokens", () => {
    expect(
      validateContextToolRehydrationHandle({ ...happyHandle(), approxTokens: Infinity }).ok,
    ).toBe(false);
  });

  it("accepts a present notPersistedReason and rejects an empty one", () => {
    expect(
      validateContextToolRehydrationHandle({ ...happyHandle(), notPersistedReason: "truncated" })
        .ok,
    ).toBe(true);
    expect(
      validateContextToolRehydrationHandle({ ...happyHandle(), notPersistedReason: "" }).ok,
    ).toBe(false);
  });
});

// ─── ShapedCommandObservation ───────────────────────────────────────────────────
describe("validateShapedCommandObservation", () => {
  it("accepts a happy command", () => {
    expect(validateShapedCommandObservation(happyCommand())).toEqual({ ok: true });
  });

  it("rejects a non-record", () => {
    expect(validateShapedCommandObservation(42).ok).toBe(false);
  });

  it("rejects a wrong kind", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), kind: "test" }).ok).toBe(false);
  });

  it("rejects an empty observationId", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), observationId: "" }).ok).toBe(
      false,
    );
  });

  it("accepts a null exitCode and rejects a non-finite one", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), exitCode: null }).ok).toBe(true);
    expect(validateShapedCommandObservation({ ...happyCommand(), exitCode: NaN }).ok).toBe(false);
  });

  it("rejects a negative durationMs", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), durationMs: -1 }).ok).toBe(false);
  });

  it("rejects a non-boolean timedOut", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), timedOut: "no" }).ok).toBe(false);
  });

  it("rejects a non-boolean truncated", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), truncated: 1 }).ok).toBe(false);
  });

  it("rejects a negative omittedByteCount but accepts absence", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), omittedByteCount: -5 }).ok).toBe(
      false,
    );
    expect(validateShapedCommandObservation(happyCommand()).ok).toBe(true);
  });

  it("rejects a non-array excerpts", () => {
    expect(validateShapedCommandObservation({ ...happyCommand(), excerpts: "x" }).ok).toBe(false);
  });

  it("rejects an invalid stream label", () => {
    expect(
      validateShapedCommandObservation({
        ...happyCommand(),
        excerpts: [{ stream: "stdlog", bytes: 1, text: "x" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects excerpts that exceed the byte cap", () => {
    expect(
      validateShapedCommandObservation({
        ...happyCommand(),
        excerpts: [{ stream: "stdout", bytes: MAX_OBSERVATION_EXCERPT_BYTES + 1, text: "x" }],
      }).ok,
    ).toBe(false);
  });

  it("rejects an invalid injectionSignalCount", () => {
    expect(
      validateShapedCommandObservation({ ...happyCommand(), injectionSignalCount: -1 }).ok,
    ).toBe(false);
  });

  it("rejects a non-boolean hasCriticalInjectionSignal", () => {
    expect(
      validateShapedCommandObservation({ ...happyCommand(), hasCriticalInjectionSignal: "yes" }).ok,
    ).toBe(false);
  });

  it("rejects an invalid nested rehydration handle", () => {
    expect(
      validateShapedCommandObservation({
        ...happyCommand(),
        rehydration: { ...happyHandle(), kind: "bogus" },
      }).ok,
    ).toBe(false);
  });
});

// ─── ShapedTestObservation ──────────────────────────────────────────────────────
describe("validateShapedTestObservation", () => {
  it("accepts a happy test", () => {
    expect(validateShapedTestObservation(happyTest())).toEqual({ ok: true });
  });

  it("rejects a non-record", () => {
    expect(validateShapedTestObservation(undefined).ok).toBe(false);
  });

  it("rejects a wrong kind", () => {
    expect(validateShapedTestObservation({ ...happyTest(), kind: "command" }).ok).toBe(false);
  });

  it("rejects an empty verificationKind", () => {
    expect(validateShapedTestObservation({ ...happyTest(), verificationKind: "" }).ok).toBe(false);
  });

  it("rejects an empty status", () => {
    expect(validateShapedTestObservation({ ...happyTest(), status: "" }).ok).toBe(false);
  });

  it("rejects invalid counts", () => {
    expect(
      validateShapedTestObservation({
        ...happyTest(),
        counts: { passed: 1, failed: -1, skipped: 0 },
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-record counts", () => {
    expect(validateShapedTestObservation({ ...happyTest(), counts: 3 }).ok).toBe(false);
  });

  it("rejects failingTestNames over the cap", () => {
    const tooMany = Array.from({ length: MAX_FAILING_TEST_NAMES + 1 }, (_v, i) => `t${String(i)}`);
    expect(validateShapedTestObservation({ ...happyTest(), failingTestNames: tooMany }).ok).toBe(
      false,
    );
  });

  it("rejects stackFrameExcerpts over the cap", () => {
    const tooMany = Array.from({ length: MAX_STACK_FRAME_LINES + 1 }, () => "at x");
    expect(validateShapedTestObservation({ ...happyTest(), stackFrameExcerpts: tooMany }).ok).toBe(
      false,
    );
  });

  it("rejects a non-string outputSummary", () => {
    expect(validateShapedTestObservation({ ...happyTest(), outputSummary: 1 }).ok).toBe(false);
  });

  it("accepts an empty outputSummary string", () => {
    expect(validateShapedTestObservation({ ...happyTest(), outputSummary: "" }).ok).toBe(true);
  });
});

// ─── ShapedSearchObservation ────────────────────────────────────────────────────
describe("validateShapedSearchObservation", () => {
  it("accepts a happy search", () => {
    expect(validateShapedSearchObservation(happySearch())).toEqual({ ok: true });
  });

  it("rejects a non-record", () => {
    expect(validateShapedSearchObservation("nope").ok).toBe(false);
  });

  it("rejects a wrong kind", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), kind: "command" }).ok).toBe(false);
  });

  it("rejects a query over the byte cap", () => {
    expect(
      validateShapedSearchObservation({
        ...happySearch(),
        query: "x".repeat(MAX_OBSERVATION_QUERY_BYTES + 1),
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-string query", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), query: 1 }).ok).toBe(false);
  });

  it("rejects an empty searchKind", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), searchKind: "" }).ok).toBe(false);
  });

  it("rejects a negative candidateCount", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), candidateCount: -1 }).ok).toBe(
      false,
    );
  });

  it("rejects a negative omittedCount", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), omittedCount: -1 }).ok).toBe(false);
  });

  it("rejects a non-boolean truncated", () => {
    expect(validateShapedSearchObservation({ ...happySearch(), truncated: 0 }).ok).toBe(false);
  });

  it("rejects topRanges over the cap", () => {
    const tooMany = Array.from({ length: MAX_TOP_RANGES + 1 }, () => ({
      scopePath: "src/x.ts",
      startLine: 1,
      endLine: 2,
      score: 0.1,
    }));
    expect(validateShapedSearchObservation({ ...happySearch(), topRanges: tooMany }).ok).toBe(
      false,
    );
  });

  it("rejects a range with an empty scopePath", () => {
    expect(
      validateShapedSearchObservation({
        ...happySearch(),
        topRanges: [{ scopePath: "", startLine: 1, endLine: 2, score: 0.1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a range with a non-finite score", () => {
    expect(
      validateShapedSearchObservation({
        ...happySearch(),
        topRanges: [{ scopePath: "src/x.ts", startLine: 1, endLine: 2, score: NaN }],
      }).ok,
    ).toBe(false);
  });
});

// ─── ShapedBrowserObservation (forward-defined, still validated) ─────────────────
describe("validateShapedBrowserObservation", () => {
  it("accepts a happy browser observation", () => {
    expect(validateShapedBrowserObservation(happyBrowser())).toEqual({ ok: true });
  });

  it("rejects a wrong kind", () => {
    expect(validateShapedBrowserObservation({ ...happyBrowser(), kind: "search" }).ok).toBe(false);
  });

  it("rejects an empty checkDescription", () => {
    expect(validateShapedBrowserObservation({ ...happyBrowser(), checkDescription: "" }).ok).toBe(
      false,
    );
  });

  it("rejects a non-boolean passed", () => {
    expect(validateShapedBrowserObservation({ ...happyBrowser(), passed: 1 }).ok).toBe(false);
  });

  it("rejects a negative durationMs", () => {
    expect(validateShapedBrowserObservation({ ...happyBrowser(), durationMs: -1 }).ok).toBe(false);
  });

  it("rejects a negative a11yViolationCount", () => {
    expect(validateShapedBrowserObservation({ ...happyBrowser(), a11yViolationCount: -1 }).ok).toBe(
      false,
    );
  });

  it("rejects an empty screenshotScopePath but accepts absence", () => {
    expect(
      validateShapedBrowserObservation({ ...happyBrowser(), screenshotScopePath: "" }).ok,
    ).toBe(false);
    expect(validateShapedBrowserObservation(happyBrowser()).ok).toBe(true);
  });
});

// ─── Kind guard + discriminated dispatch ─────────────────────────────────────────
describe("isContextToolObservationKind", () => {
  it("accepts the four discriminants and rejects others", () => {
    for (const kind of ["command", "test", "search", "browser"]) {
      expect(isContextToolObservationKind(kind)).toBe(true);
    }
    expect(isContextToolObservationKind("tool-result")).toBe(false);
    expect(isContextToolObservationKind(7)).toBe(false);
  });
});

describe("validateContextToolObservation dispatch", () => {
  it("routes each kind to its happy fixture", () => {
    expect(validateContextToolObservation(happyCommand())).toEqual({ ok: true });
    expect(validateContextToolObservation(happyTest())).toEqual({ ok: true });
    expect(validateContextToolObservation(happySearch())).toEqual({ ok: true });
    expect(validateContextToolObservation(happyBrowser())).toEqual({ ok: true });
  });

  it("rejects a non-record and an unknown kind", () => {
    expect(validateContextToolObservation(null).ok).toBe(false);
    expect(validateContextToolObservation({ kind: "mystery" }).ok).toBe(false);
  });

  it("routes by kind, not by shape (a command shape under kind=test fails the test validator)", () => {
    const result = validateContextToolObservation({ ...happyCommand(), kind: "test" });
    expect(result.ok).toBe(false);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────────
describe("determinism", () => {
  it("returns an equal result across repeated calls", () => {
    const fixture = happyCommand();
    expect(validateContextToolObservation(fixture)).toEqual(
      validateContextToolObservation(fixture),
    );
    const bad = { ...happyTest(), status: "" };
    expect(validateContextToolObservation(bad)).toEqual(validateContextToolObservation(bad));
  });
});

// ─── Backward compatibility (additive tools.ts fields) ───────────────────────────
describe("tools.ts backward compatibility", () => {
  it("a CommandResult without omittedByteCount still types and round-trips", () => {
    const legacy: CommandResult = {
      command: "git",
      args: ["status"],
      exitCode: 0,
      signal: null,
      stdout: "clean",
      stderr: "",
      durationMs: 5,
      timedOut: false,
      truncated: false,
    };
    expect(legacy.omittedByteCount).toBeUndefined();
  });

  it("a ToolCallResult without shapedObservation still types and round-trips", () => {
    const legacy: ToolCallResult = {
      toolCallId: "call-1",
      output: "{}",
      durationMs: 5,
    };
    expect(legacy.shapedObservation).toBeUndefined();
  });

  it("a ToolCallResult MAY carry a shaped observation additively", () => {
    const observation: ContextToolObservation = happyCommand();
    const enriched: ToolCallResult = {
      toolCallId: "call-2",
      output: "{}",
      durationMs: 5,
      shapedObservation: observation,
    };
    expect(validateContextToolObservation(enriched.shapedObservation)).toEqual({ ok: true });
  });
});

// ─── Compile-time anti-regression (discriminated union exhaustiveness) ───────────
describe("discriminated union type-level", () => {
  it("narrows by kind", () => {
    function describeKind(obs: ContextToolObservation): string {
      switch (obs.kind) {
        case "command":
          return `command:${obs.excerpts.length.toString()}`;
        case "test":
          return `test:${obs.failingTestNames.length.toString()}`;
        case "search":
          return `search:${obs.topRanges.length.toString()}`;
        case "browser":
          return `browser:${obs.checkDescription}`;
        default: {
          const exhaustive: never = obs;
          return exhaustive;
        }
      }
    }
    expect(describeKind(happyCommand())).toBe("command:2");
    expect(describeKind(happyTest())).toBe("test:2");
    expect(describeKind(happySearch())).toBe("search:1");
    expect(describeKind(happyBrowser())).toBe("browser:/ route axe scan");
  });

  it("rejects a command shape where a test shape is required (compile-time)", () => {
    // @ts-expect-error a ShapedCommandObservation is not assignable to ShapedTestObservation
    const wrong: ShapedTestObservation = happyCommand();
    expect(wrong.kind).toBe("command");
  });
});
