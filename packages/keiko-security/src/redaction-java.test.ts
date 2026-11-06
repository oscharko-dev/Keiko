import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { SecurityLogEvent } from "./log-port.js";
import { redact } from "./redaction.js";
import { isJavaSource } from "./redaction-java.js";
import {
  installJavaParserLogSink,
  parseJavaBounded,
  resetJavaParserWorker,
} from "./redaction-java-parser.js";

const options = { sourceLanguage: "java" as const, preserveSourceLineBreaks: true };

describe("Java redaction uses the initializer's syntax ownership", () => {
  it.each(["password", "pa\u200cssword"])(
    "keeps an invalid bare private assignment unavailable (%s)",
    (name) => {
      expect(redact(`${name} += 918273;`, [], options)).not.toContain("918273");
    },
  );

  it("retains a public malformed fragment without literal or sensitive-name ambiguity", () => {
    const input = "@Broken(!) class Example {}";
    expect(redact(input, [], options)).toBe(input);
  });

  it.each(["password", "pa\u200cssword"])(
    "keeps malformed private numeric assignments closed (%s)",
    (name) => {
      const input = `@Broken(!) class Example { int ${name} = 918273; }`;
      expect(redact(input, [], options)).not.toContain("918273");
    },
  );

  it("keeps a configured literal closed in an otherwise public malformed fragment", () => {
    const input = "@Broken(!) class Example { int quota = 918273; }";
    expect(redact(input, ["918273"], options)).not.toContain("918273");
  });

  it.each([
    [
      "annotation member",
      '@Config(password="private-data", label="public-data") class Example {}',
      'label="public-data"',
    ],
    [
      "declarator",
      'class Example { String password="private-data", label="public-data"; }',
      'label="public-data"',
    ],
    [
      "assignment in a call",
      'class Example { void run(){ accept(password="private-data", "public-data"); } }',
      '"public-data"',
    ],
  ])("protects a private %s without changing its public sibling", (_kind, input, publicData) => {
    const output = redact(input, [], options);
    expect(output).not.toContain("private-data");
    expect(output).toContain(publicData);
  });

  it("retains a public argument that computes a private result", () => {
    const input = 'class Example { String password = derive("public-data"); }';
    expect(redact(input, [], options)).toBe(input);
  });

  it("protects configured text-block values after incidental indentation is removed", () => {
    const input = [
      'class Example { String label = """',
      "    private-first",
      "    private-second",
      '    """; }',
    ].join("\n");
    const output = redact(input, ["private-first\nprivate-second"], options);
    expect(output).not.toContain("private-first");
    expect(output).not.toContain("private-second");
    expect(output.split("\n")).toHaveLength(input.split("\n").length);
  });
});

// java-parser predicts with ALL(*) lookahead, whose work grows superlinearly on some invalid
// expressions: 400 characters of "x x=y&x=y&…" once took 21 s and 1,600 exhausted a 4 GB heap.
describe("Java parsing on hostile text", () => {
  const hostile = (count: number): string => `x ${"x=y&".repeat(count)}`;

  it("refuses within its budget instead of blocking or exhausting memory", () => {
    const started = performance.now();
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it("keeps hostile text closed through the public redactor and recovers for valid Java", () => {
    const started = performance.now();
    const output = redact(`${hostile(100)} password=hunter2`, [], {
      preserveSourceLineBreaks: true,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(output).not.toContain("hunter2");
    const valid = 'class Example { String password = "private-data"; String label = "public"; }';
    expect(redact(valid, [], options)).toContain('"public"');
    expect(redact(valid, [], options)).not.toContain("private-data");
  }, 30_000);

  it("refuses two different hostile texts in a row, each within its deadline", () => {
    for (const count of [100, 101]) {
      const started = performance.now();
      expect(() => isJavaSource(hostile(count))).toThrow(RangeError);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  }, 30_000);

  it("still recognises ordinary Java after a refusal", () => {
    expect(() => isJavaSource(hostile(100))).toThrow(RangeError);
    expect(isJavaSource("class Example { int value = 1; }")).toBe(true);
    expect(isJavaSource("Ich nutze Excel für Berichte.")).toBe(false);
  }, 30_000);
});

describe("the bounded Java parser worker", () => {
  const hostile = `x ${"x=y&".repeat(100)}`;
  const valid = "class Example { int value = 1; }";
  let events: SecurityLogEvent[] = [];

  beforeEach(() => {
    resetJavaParserWorker();
    events = [];
    installJavaParserLogSink({ write: (event) => events.push(event) });
  });

  afterEach(() => {
    installJavaParserLogSink(undefined);
    resetJavaParserWorker();
  });

  const ops = (): string[] => events.map((event) => event.op);
  const eventAt = (index: number): SecurityLogEvent => {
    const event = events[index];
    if (event === undefined) throw new RangeError(`No Activity Log event at ${String(index)}.`);
    return event;
  };

  it("records its start and a retirement on a missed deadline, as counts only", () => {
    expect(parseJavaBounded(hostile)).toEqual({ kind: "budget" });
    expect(ops()).toEqual([
      "security.java-parser.worker-started",
      "security.java-parser.worker-retired",
    ]);
    const started = eventAt(0);
    const retired = eventAt(1);
    const workerOrdinal = started.extra?.workerOrdinal;
    expect(started.level).toBeUndefined();
    expect(typeof workerOrdinal).toBe("number");
    // One correlation joins the lifetime of one worker.
    expect(started.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(retired.correlationId).toBe(started.correlationId);
    expect(retired).toMatchObject({
      level: "warn",
      extra: { reason: "deadline", parseCount: 1, workerOrdinal },
    });
    expect(JSON.stringify(events)).not.toContain("x=y");
    expect(
      expectActivityLogProof(
        "security.java-parser.worker-started.line",
        formatActivityLogProofLine(started),
      ),
    ).toMatchObject({ workerOrdinal });
    expect(
      expectActivityLogProof(
        "security.java-parser.worker-retired.line",
        formatActivityLogProofLine(retired),
      ),
    ).toMatchObject({ reason: "deadline", parseCount: 1 });
  }, 30_000);

  const starts = (): number => ops().filter((op) => op.endsWith("worker-started")).length;

  it("refuses the same hostile text again at once, and parses it afresh once that lapses", () => {
    expect(parseJavaBounded(hostile)).toEqual({ kind: "budget" });
    const started = performance.now();
    expect(parseJavaBounded(hostile)).toEqual({ kind: "budget" });
    // The second caller of one hostile message does not wait out a second deadline.
    expect(performance.now() - started).toBeLessThan(250);
    expect(starts()).toBe(1);
    const now = performance.now.bind(performance);
    const later = vi.spyOn(performance, "now").mockImplementation(() => now() + 10_000);
    try {
      expect(parseJavaBounded(hostile)).toEqual({ kind: "budget" });
    } finally {
      later.mockRestore();
    }
    // That refusal was stamped in the shifted clock; it must not outlive the test's timeline.
    resetJavaParserWorker();
    // The refusal described a moment, not the text for good: the lapsed one got a fresh worker.
    expect(starts()).toBe(2);
    expect(parseJavaBounded(valid).kind).toBe("parsed");
    const before = events.length;
    expect(parseJavaBounded(valid).kind).toBe("parsed");
    expect(events).toHaveLength(before);
  }, 60_000);

  it("replaces a worker that keeps too much heap as routine, under its own correlation", () => {
    resetJavaParserWorker({ heapRecycleBytes: 0 });
    expect(parseJavaBounded(valid).kind).toBe("parsed");
    expect(ops()).toEqual([
      "security.java-parser.worker-started",
      "security.java-parser.worker-recycled",
    ]);
    const started = eventAt(0);
    const recycled = eventAt(1);
    expect(recycled.level).toBeUndefined();
    expect(recycled.correlationId).toBe(started.correlationId);
    expect(
      expectActivityLogProof(
        "security.java-parser.worker-recycled.line",
        formatActivityLogProofLine(recycled),
      ),
    ).toMatchObject({ workerOrdinal: started.extra?.workerOrdinal, parseCount: 1 });
    expect(typeof recycled.extra?.heapMiB).toBe("number");
    expect(parseJavaBounded("class F {}").kind).toBe("parsed");
    expect(starts()).toBe(2);
    expect(eventAt(2).correlationId).not.toBe(started.correlationId);
  }, 60_000);

  // An answer that is not the one asked for means the exchange lost step with the worker. It
  // says nothing about the text, so it is neither kept nor read as a depth refusal.
  it("refuses a lost exchange without keeping it, and retires that worker", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-java-desync-"));
    try {
      const parserPath = join(directory, "parser.cjs");
      writeFileSync(
        parserPath,
        [
          'const { workerData } = require("node:worker_threads");',
          "exports.parse = () => {",
          '  workerData.port.postMessage({ id: -1, kind: "syntax" });',
          '  return { name: "compilationUnit", children: {}, comments: [] };',
          "};",
        ].join("\n"),
      );
      resetJavaParserWorker({ parserPath });
      expect(parseJavaBounded(valid)).toEqual({ kind: "budget" });
      expect(parseJavaBounded(valid)).toEqual({ kind: "budget" });
      expect(starts()).toBe(2);
      const retired = events.filter((event) => event.op.endsWith("worker-retired"));
      expect(retired.map((event) => event.extra?.reason)).toEqual(["desync", "desync"]);
      // The second refusal was a parse of its own on a fresh worker, not a kept outcome.
      expect(retired.map((event) => event.extra?.parseCount)).toEqual([1, 1]);
    } finally {
      resetJavaParserWorker();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  // A tree the worker could build and pass but this thread could not read back once threw out of
  // the parse, left the shared signal set, and handed the next parse a stale or missing answer.
  it.each([200, 300, 2_000])(
    "refuses or parses %i nested parentheses without throwing, and parses on afterwards",
    (depth) => {
      const nested = `class A { int x = ${"(".repeat(depth)}1${")".repeat(depth)}; }`;
      expect(["parsed", "depth"]).toContain(parseJavaBounded(nested).kind);
      const after = parseJavaBounded("class B { int y = 2; }");
      expect(after.kind).toBe("parsed");
      expect(JSON.stringify(after)).toContain('"image":"B"');
    },
    30_000,
  );

  it("refuses every parse while its worker cannot start, and retries only after the cooldown", () => {
    resetJavaParserWorker({ parserPath: "/nonexistent/java-parser/index.js" });
    expect(parseJavaBounded(valid)).toEqual({ kind: "budget" });
    expect(events.map((event) => event.extra?.reason)).toEqual(["start-failed"]);
    expect(parseJavaBounded("class C {}")).toEqual({ kind: "budget" });
    expect(events).toHaveLength(1);
    expect(() => redact(`password = "${"s".repeat(12)}";`, [], options)).not.toThrow();
    resetJavaParserWorker();
    expect(parseJavaBounded(valid).kind).toBe("parsed");
  }, 30_000);

  it("parses 300 KiB of ordinary Java within its deadline", () => {
    const methods = Array.from(
      { length: 6_500 },
      (_, index) => `  int method${String(index)}(int a) { return a * ${String(index)} + 1; }\n`,
    ).join("");
    const source = `class Large {\n${methods}}\n`;
    expect(source.length).toBeGreaterThan(300 * 1024);
    expect(parseJavaBounded(source).kind).toBe("parsed");
    // A worker that grew past the heap it may keep is replaced, never reported as a failure.
    expect(ops()).not.toContain("security.java-parser.worker-retired");
  }, 60_000);
});
