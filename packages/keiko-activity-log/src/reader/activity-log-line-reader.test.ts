import { fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActivityLogReadError,
  consumeActivityLogFileLines,
  readActivityLogFileLines,
  type ActivityLogReadLine,
} from "./activity-log-line-reader.js";
import { analyzeLogLines, analyzeLogText } from "./support-analyze.js";
import { fixtureLine, fixtureProcess } from "../../../../tests/support/activity-log-segments.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-line-reader-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeText(text: string): string {
  const path = join(directory, "input.jsonl");
  writeFileSync(path, text);
  return path;
}

function readAll(path: string, chunkBytes: number, maxLineBytes?: number): ActivityLogReadLine[] {
  return [
    ...readActivityLogFileLines(() => openSync(path, "r"), {
      chunkBytes,
      ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
    }),
  ];
}

describe("readActivityLogFileLines (#3531)", () => {
  it("splits lines across every chunk boundary without changing a byte", () => {
    const text = 'alpha\n{"ü":"€ – 𝄞"}\n\nlast line\n';
    const path = writeText(text);
    const expected = ["alpha", '{"ü":"€ – 𝄞"}', "", "last line"];

    for (let chunkBytes = 1; chunkBytes <= text.length + 2; chunkBytes += 1) {
      const lines = readAll(path, chunkBytes);
      expect(lines.map((line) => line.text)).toEqual(expected);
      expect(lines.every((line) => line.terminated)).toBe(true);
      expect(lines.map((line) => line.byteLength)).toEqual(
        expected.map((line) => Buffer.byteLength(line)),
      );
    }
  });

  it("yields an unterminated torn tail as the one non-terminated line", () => {
    const lines = readAll(writeText('{"a":1}\n{"b":'), 3);

    expect(lines.map((line) => [line.text, line.terminated])).toEqual([
      ['{"a":1}', true],
      ['{"b":', false],
    ]);
  });

  it("never buffers a line beyond the bound and yields it as an empty oversized line", () => {
    const lines = readAll(writeText(`${"x".repeat(40)}\nshort\n${"y".repeat(33)}`), 8, 16);

    expect(lines).toEqual([
      { text: "", terminated: true, byteLength: 40, oversized: true },
      { text: "short", terminated: true, byteLength: 5, oversized: false },
      { text: "", terminated: false, byteLength: 33, oversized: true },
    ]);
  });

  it("yields nothing for an empty file and observes every raw byte in order", () => {
    expect(readAll(writeText(""), 4)).toEqual([]);
    const text = "one\ntwo\n";
    const path = writeText(text);
    const chunks: Buffer[] = [];
    const lines = [
      ...readActivityLogFileLines(() => openSync(path, "r"), {
        chunkBytes: 3,
        onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
      }),
    ];
    expect(lines).toHaveLength(2);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(text);
  });

  it("keeps concurrent default-sized readers isolated when one closes early", () => {
    const firstPath = writeText("first-a\nfirst-b\n");
    const secondPath = join(directory, "second.jsonl");
    writeFileSync(secondPath, "second-a\nsecond-b\n");
    const first = readActivityLogFileLines(() => openSync(firstPath, "r"));
    const second = readActivityLogFileLines(() => openSync(secondPath, "r"));

    expect(first.next()).toMatchObject({ done: false, value: { text: "first-a" } });
    expect(second.next()).toMatchObject({ done: false, value: { text: "second-a" } });
    expect(first.return(undefined).done).toBe(true);
    expect([...second].map((line) => line.text)).toEqual(["second-b"]);
    expect(
      [...readActivityLogFileLines(() => openSync(firstPath, "r"))].map((line) => line.text),
    ).toEqual(["first-a", "first-b"]);
  });

  it("consumes through the same split-line parser and closes when the callback throws", () => {
    const path = writeText('first\n{"ü":"€ – 𝄞"}\nlast');
    const observed: ActivityLogReadLine[] = [];
    let descriptor = -1;
    const failure = new Error("stop after the split line");

    expect(() => {
      consumeActivityLogFileLines(
        () => {
          descriptor = openSync(path, "r");
          return descriptor;
        },
        (line) => {
          observed.push({ ...line });
          if (line.text.includes("ü")) throw failure;
        },
        { chunkBytes: 5 },
      );
    }).toThrow(failure);
    expect(observed).toEqual([
      { text: "first", terminated: true, byteLength: 5, oversized: false },
      {
        text: '{"ü":"€ – 𝄞"}',
        terminated: true,
        byteLength: Buffer.byteLength('{"ü":"€ – 𝄞"}'),
        oversized: false,
      },
    ]);
    expect(() => {
      fstatSync(descriptor);
    }).toThrow();
  });

  it("wraps open and read failures in a content-free ActivityLogReadError", () => {
    const missing = join(directory, "missing.jsonl");
    const open = (): Generator<ActivityLogReadLine> =>
      readActivityLogFileLines(() => openSync(missing, "r"));
    let failure: unknown;
    try {
      expect([...open()]).toEqual([]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ActivityLogReadError);
    expect((failure as ActivityLogReadError).causeKind).toBe("ENOENT");
    expect((failure as Error).message).not.toContain(missing);
    expect(() => [...readActivityLogFileLines(() => openSync(directory, "r"))]).toThrow(
      ActivityLogReadError,
    );
  });
});

describe("streaming analysis (#3531)", () => {
  it("returns exactly the whole-text result, torn tail included", () => {
    const process = fixtureProcess(2101, "0a0b0c0d");
    const text =
      [
        fixtureLine(process, Date.UTC(2026, 8, 18), {
          op: "client.diagnostic",
          correlationId: "corr-stream-000001",
        }),
        "not json",
        fixtureLine(process, Date.UTC(2026, 8, 18, 0, 0, 1), {
          op: "cli.lifecycle.stop-requested",
        }),
      ].join("\n") + '\n{"ts":"2026';
    const path = writeText(text);

    const streamed = analyzeLogLines(
      readActivityLogFileLines(() => openSync(path, "r"), { chunkBytes: 5 }),
    );

    expect(streamed).toEqual(analyzeLogText(readFileSync(path, "utf8")));
    expect(streamed.evidence).toMatchObject({ corruptLineCount: 1, truncatedLineCount: 1 });
  });
});
