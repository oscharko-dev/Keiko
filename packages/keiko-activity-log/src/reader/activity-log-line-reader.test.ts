import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActivityLogReadError,
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
