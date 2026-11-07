import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  prewarmJavaParserWorker,
  resetJavaParserWorker,
} from "./redaction-java-parser.js";

const options = { sourceLanguage: "java" as const, preserveSourceLineBreaks: true };

// A stand-in grammar module that loads the real `java-parser` around fixed statements. The module
// is constant text: the real parser's path and every marker file are data it reads from its own
// directory (`here(name)`), so no path is ever written into the code it runs.
function writeParserFixture(directory: string, before: string[], after: string[]): string {
  writeFileSync(join(directory, "target"), createRequire(import.meta.url).resolve("java-parser"));
  const parserPath = join(directory, "parser.cjs");
  writeFileSync(
    parserPath,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const here = (name) => path.join(__dirname, name);",
      ...before,
      'module.exports = require(fs.readFileSync(here("target"), "utf8"));',
      ...after,
    ].join("\n"),
  );
  return parserPath;
}

describe("Java redaction uses the initializer's syntax ownership", () => {
  it.each(["password", "pa\u200cssword"])(
    "keeps an invalid bare private assignment unavailable (%s)",
    (name) => {
      expect(redact(`${name} += 918273;`, [], options)).not.toContain("918273");
    },
  );

  // A fragment the parser refused may quote a value in any single quotes, so every apostrophe
  // keeps it closed; only text no parser was available for reads an apostrophe inside a word as
  // prose.
  it("keeps a single-quoted value in a malformed fragment closed", () => {
    const fragment = "@Broken(!) class A { String label = 'hunter2value'; }";
    expect(redact(fragment, [], options)).not.toContain("hunter2value");
  });

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

  it("answers unavailable while its worker cannot start, and retries only after the cooldown", () => {
    resetJavaParserWorker({ parserPath: "/nonexistent/java-parser/index.js" });
    expect(parseJavaBounded(valid)).toEqual({ kind: "unavailable" });
    expect(ops()).toEqual([
      "security.java-parser.worker-retired",
      "security.java-parser.unavailable",
    ]);
    const [retired, unavailable] = [eventAt(0), eventAt(1)];
    expect(retired.extra?.reason).toBe("start-failed");
    // The refused answers join the failed start's lifetime, once per cooldown.
    expect(unavailable).toMatchObject({
      level: "warn",
      correlationId: retired.correlationId,
      extra: { reason: "start-refused", workerOrdinal: retired.extra?.workerOrdinal },
    });
    expect(
      expectActivityLogProof(
        "security.java-parser.unavailable.line",
        formatActivityLogProofLine(unavailable),
      ),
    ).toMatchObject({ reason: "start-refused" });
    expect(parseJavaBounded("class C {}")).toEqual({ kind: "unavailable" });
    expect(() => redact(`password = "${"s".repeat(12)}";`, [], options)).not.toThrow();
    expect(events).toHaveLength(2);
    resetJavaParserWorker();
    expect(parseJavaBounded(valid).kind).toBe("parsed");
  }, 30_000);

  // A grammar that takes three seconds to load, then marks that it has loaded. The bounds below
  // leave a slow machine room; what they pin is the order: 2 s at most for one caller, no wait for
  // the next, and a start measured by the worker itself.
  const slowParser = (directory: string): { parserPath: string; loaded: string } => {
    const parserPath = writeParserFixture(
      directory,
      ["const loading = Date.now();", "while (Date.now() - loading < 3000) {}"],
      ['fs.writeFileSync(here("loaded"), "");'],
    );
    return { parserPath, loaded: join(directory, "loaded") };
  };

  it("waits for a starting worker once and briefly, then uses it when it is ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-java-slow-start-"));
    try {
      const { parserPath } = slowParser(directory);
      resetJavaParserWorker({ parserPath });
      let started = performance.now();
      expect(parseJavaBounded(valid)).toEqual({ kind: "unavailable" });
      expect(performance.now() - started).toBeLessThan(4_000);
      started = performance.now();
      expect(parseJavaBounded("class C {}")).toEqual({ kind: "unavailable" });
      expect(performance.now() - started).toBeLessThan(1_000);
      await vi.waitFor(
        () => {
          expect(parseJavaBounded(valid).kind).toBe("parsed");
        },
        { timeout: 15_000, interval: 100 },
      );
      // One unavailable line per start, however many parses found it loading.
      expect(ops()).toEqual([
        "security.java-parser.unavailable",
        "security.java-parser.worker-started",
      ]);
      const [unavailable, workerStarted] = [eventAt(0), eventAt(1)];
      expect(unavailable).toMatchObject({ level: "warn", extra: { reason: "starting" } });
      expect(unavailable.correlationId).toBe(workerStarted.correlationId);
      expect(workerStarted.extra?.startupMs).toBeGreaterThanOrEqual(2_500);
    } finally {
      resetJavaParserWorker();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("loads the grammar in the background when prewarmed, so the first parse needs no start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-java-prewarm-"));
    try {
      const { parserPath, loaded } = slowParser(directory);
      resetJavaParserWorker({ parserPath });
      prewarmJavaParserWorker();
      prewarmJavaParserWorker();
      // Nothing is recorded until a parse observes the start.
      expect(events).toEqual([]);
      await vi.waitFor(
        () => {
          expect(existsSync(loaded)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );
      const started = performance.now();
      expect(parseJavaBounded(valid).kind).toBe("parsed");
      expect(performance.now() - started).toBeLessThan(1_000);
      // One worker for both calls, which loaded before the parse asked for it.
      expect(ops()).toEqual(["security.java-parser.worker-started"]);
      expect(eventAt(0).extra?.workerOrdinal).toBeTypeOf("number");
      expect(eventAt(0).extra?.startupMs).toBeGreaterThanOrEqual(2_500);
    } finally {
      resetJavaParserWorker();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // A grammar that loads and then ends its worker 50 ms later. Each worker appends to `loaded` when
  // it has loaded and to `exited` as it ends, so the test waits for what happened, not for a time.
  it("replaces a worker that exited before any parse, and refuses starts once that repeats", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-java-exited-"));
    try {
      const loaded = join(directory, "loaded");
      const exited = join(directory, "exited");
      const parserPath = writeParserFixture(
        directory,
        [],
        [
          'fs.appendFileSync(here("loaded"), "x");',
          'process.on("exit", () => fs.appendFileSync(here("exited"), "x"));',
          "setTimeout(() => process.exit(0), 50);",
        ],
      );
      const count = (file: string): number =>
        existsSync(file) ? readFileSync(file, "utf8").length : 0;
      resetJavaParserWorker({ parserPath });
      prewarmJavaParserWorker();
      const reasons: unknown[] = [];
      for (let round = 1; round <= 3; round += 1) {
        await vi.waitFor(
          () => {
            expect(count(exited)).toBe(round);
          },
          { timeout: 15_000, interval: 50 },
        );
        // The worker's exit event reaches this thread just after its exit handler ran.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(parseJavaBounded(valid)).toEqual({ kind: "unavailable" });
        reasons.push(events.at(-1)?.extra?.reason);
      }
      const retired = events.filter((event) => event.op === "security.java-parser.worker-retired");
      // Each had started: its ready answer is read before it is retired, never a failed start.
      expect(retired.map((event) => event.extra?.reason)).toEqual(["exited", "exited", "exited"]);
      expect(ops().filter((op) => op.endsWith("worker-started"))).toHaveLength(3);
      // Twice replaced at once; the third in a row refuses starts for the cooldown.
      expect(reasons).toEqual(["starting", "starting", "start-refused"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(count(loaded)).toBe(3);
    } finally {
      resetJavaParserWorker();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

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

// A parser that could not answer says nothing about the text (#4212): prose that holds nothing Java
// projection would mask stays readable, and text that may be Java stays closed.
describe("Java inference while no parser is available", () => {
  const inferred = { preserveSourceLineBreaks: true };

  beforeEach(() => {
    resetJavaParserWorker({ parserPath: "/nonexistent/java-parser/index.js" });
  });

  afterEach(() => {
    resetJavaParserWorker();
  });

  it.each([
    "final prompt fitting; the function was fully read (it's done).",
    "public notes; the review ran twice (it's settled).",
  ])("keeps prose readable: %s", (text) => {
    expect(parseJavaBounded("class Probe {}")).toEqual({ kind: "unavailable" });
    expect(redact(text, [], inferred)).toBe(text);
  });

  it.each([
    ['final String label = "private-data";', "private-data"],
    ["final char mark = 'q'; int count = 1;", "'q'"],
    ["final String label = \\u0022private-data\\u0022;", "private-data"],
    ["final int password = 918273;", "918273"],
  ])("keeps text that may be Java closed: %s", (text, hidden) => {
    expect(redact(text, [], inferred)).not.toContain(hidden);
  });

  // Java-like text with a value in single quotes: without a parser it may be a literal.
  it("keeps a value quoted at a word's edge closed", () => {
    expect(redact("final String label = 'hunter2value';", [], inferred)).not.toContain(
      "hunter2value",
    );
  });

  it("keeps an explicitly Java fragment closed unless it holds nothing to mask", () => {
    const literalFree = "@Broken(!) class Example {}";
    expect(redact(literalFree, [], options)).toBe(literalFree);
    const withLiteral = 'class Example { String label = "public-data"; }';
    expect(redact(withLiteral, [], options)).not.toContain("public-data");
  });
  // A private value is masked wherever it appears in one projection, so a Java hunk that holds it
  // unquoted is not literal-free, whichever file of the diff comes first.
  const privateValue = ["Zq81", "value", "X"].join("");
  const tsFile = [
    "--- a/config.ts",
    "+++ b/config.ts",
    "@@ -1,1 +1,1 @@",
    '-export const password = "old";',
    `+export const password = "${privateValue}";`,
  ];
  const javaFile = [
    "--- a/Use.java",
    "+++ b/Use.java",
    "@@ -1,1 +1,1 @@",
    "-class Use { int a = 1; }",
    `+class Use { int ${privateValue} = 2; }`,
  ];
  it.each([
    ["after", [...tsFile, ...javaFile]],
    ["before", [...javaFile, ...tsFile]],
  ])("keeps a private value closed in a Java hunk %s its literal", (_order, lines) => {
    expect(redact(lines.join("\n"), [], inferred)).not.toContain(privateValue);
  });
});
