import { afterEach, describe, expect, it } from "vitest";
import { formatServerLogLine, type ServerLogEvent } from "./observability/server-log.js";
import {
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/server-logger.js";
import { evidenceRetentionObserver } from "./evidence-retention-log.js";

function capture(): {
  readonly lines: ServerLogEvent[];
  readonly sink: { readonly write: (event: ServerLogEvent) => void };
} {
  const lines: ServerLogEvent[] = [];
  return {
    lines,
    sink: {
      write: (event): void => {
        lines.push(event);
      },
    },
  };
}

afterEach(() => {
  resetServerLogger();
});

describe("evidence retention activity (F82)", () => {
  it("reports a designed deletion as a process line with its source and count, not as an error", () => {
    const { lines, sink } = capture();
    evidenceRetentionObserver("editor-verification-run", sink)(3);
    expect(lines).toEqual([
      {
        category: "process",
        op: "evidence.retention",
        correlationId: expect.any(String) as unknown,
        extra: { source: "editor-verification-run", deletedCount: 3 },
      },
    ]);
    expect(lines[0]).not.toHaveProperty("level");
    expect(lines[0]).not.toHaveProperty("errorKind");
  });

  // ADR-0173 D5 / g12, relocated from the diagnostic observer this replaces: one retention pass
  // reports each bucket it pruned separately, and those reports must stay joinable.
  it("shares one correlation id across every report of the same observer", () => {
    const { lines, sink } = capture();
    const observe = evidenceRetentionObserver("run-engine", sink);
    observe(2);
    observe(5);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.correlationId).toBeDefined();
    expect(lines[0]?.correlationId).toBe(lines[1]?.correlationId);
  });

  it("mints a distinct correlation id for each separate observer registration", () => {
    const { lines, sink } = capture();
    evidenceRetentionObserver("grounded-qa", sink)(1);
    evidenceRetentionObserver("grounded-qa-hybrid", sink)(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.correlationId).not.toBe(lines[1]?.correlationId);
  });

  it("writes through the process-wide activity log when no sink is given, at info", () => {
    const { lines, sink } = capture();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    evidenceRetentionObserver("command-runner")(1);
    expect(lines).toMatchObject([
      { op: "evidence.retention", extra: { source: "command-runner", deletedCount: 1 } },
    ]);
    expect(lines[0]?.level ?? "info").toBe("info");
  });

  it("formats to a line that carries the source and count and nothing else from the store", () => {
    const { lines, sink } = capture();
    evidenceRetentionObserver("browser-capture", sink)(4);
    const [line] = lines;
    if (line === undefined) throw new Error("no retention line");
    const formatted = formatServerLogLine(line);
    expect(formatted).toContain('"op":"evidence.retention"');
    expect(formatted).toContain('"source":"browser-capture"');
    expect(formatted).toContain('"deletedCount":4');
  });
});
