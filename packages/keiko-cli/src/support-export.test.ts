import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_LOG_SCHEMA_VERSION } from "@oscharko-dev/keiko-server";

import type { AuditResult } from "./audit.js";
import {
  bundleText,
  buildSupportBundleManifest,
  CURRENT_LOG_FILE_NAME,
  DEFAULT_MAX_BUNDLE_BYTES,
  describeErrorKind,
  discoverServerLogFiles,
  readKeptFiles,
  readVerbatimLogLines,
  selectLogFilesWithinBudget,
  serializeBundleLines,
  type LogFileInfo,
} from "./support-export.js";

// A fixed-width line so a chosen `--max-bytes` cuts it at a known, deterministic byte offset:
// `{"seq":000}` is exactly 11 bytes for every index in [0, 999], so a file of `count` such lines
// (each followed by "\n") is exactly `count * 12` bytes, and any byte offset within it can be
// reasoned about without measuring the file after the fact.
function fixedWidthLine(index: number): string {
  return `{"seq":${String(index).padStart(3, "0")}}`;
}

function fixedWidthLogText(count: number): string {
  return `${Array.from({ length: count }, (_, i) => fixedWidthLine(i)).join("\n")}\n`;
}

const HEALTHY_AUDIT: AuditResult = {
  ok: true,
  stateDir: "/tmp/example/.keiko",
  classes: [{ id: "creds", title: "Credential references", status: "pass", findings: [] }],
};

// What the manifest is allowed to keep from HEALTHY_AUDIT: everything except the raw stateDir
// path (which embeds an OS username on a real machine — see buildSupportBundleManifest's redaction
// comment in support-export.ts).
const REDACTED_HEALTHY_AUDIT = { ok: HEALTHY_AUDIT.ok, classes: HEALTHY_AUDIT.classes };

function baseManifestInput(
  overrides: Partial<Parameters<typeof buildSupportBundleManifest>[0]> = {},
): Parameters<typeof buildSupportBundleManifest>[0] {
  return {
    schemaVersion: SERVER_LOG_SCHEMA_VERSION,
    productVersion: "0.3.15",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v24.18.0",
    generatedAt: "2026-08-21T00:00:00.000Z",
    installMode: "unknown",
    stateDirSource: "default",
    sourceLogFiles: [],
    truncatedLogFiles: [],
    currentFileTailTruncated: undefined,
    budgetExceeded: false,
    skippedLogFiles: [],
    auditSummary: HEALTHY_AUDIT,
    evidenceIndexCount: 0,
    ...overrides,
  };
}

describe("discoverServerLogFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-export-discover-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("orders rotated files oldest-first with the current file last", () => {
    writeFileSync(join(dir, "server-2026-08-20.log"), "b\n");
    writeFileSync(join(dir, "server-2026-08-19.log"), "a\n");
    writeFileSync(join(dir, CURRENT_LOG_FILE_NAME), "c\n");
    writeFileSync(join(dir, "unrelated.txt"), "ignored\n");

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual([
      "server-2026-08-19.log",
      "server-2026-08-20.log",
      CURRENT_LOG_FILE_NAME,
    ]);
    expect(discovery.files.every((f) => f.sizeBytes === 2)).toBe(true);
    expect(discovery.skippedLogFiles).toEqual([]);
  });

  it("omits the current file from the ordering when it does not exist", () => {
    writeFileSync(join(dir, "server-2026-08-19.log"), "a\n");

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual(["server-2026-08-19.log"]);
  });

  it("returns an empty result for a logs directory that does not exist, never throwing", () => {
    expect(discoverServerLogFiles(join(dir, "does-not-exist"))).toEqual({
      files: [],
      skippedLogFiles: [],
    });
  });

  // Regression-shaped: a name `readdirSync` returns can vanish before `statSync` runs (the sink's
  // own rotation/retention pruning), one step earlier than the `readKeptFiles` race already pinned
  // above. Reproduced with a broken symlink — `readdirSync` lists its name, but `statSync` follows
  // it and throws ENOENT, a real race rather than a mock — so discovery must skip it (recording
  // its name and the real fs error code, never a path) instead of throwing out of the whole
  // export.
  it("skips a rotated file that vanishes between readdirSync and statSync, recording its name and error kind", () => {
    writeFileSync(join(dir, "server-2026-08-19.log"), "a\n");
    symlinkSync(join(dir, "does-not-exist-target.log"), join(dir, "server-2026-08-20.log"));

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual(["server-2026-08-19.log"]);
    expect(discovery.skippedLogFiles).toEqual([
      { name: "server-2026-08-20.log", errorKind: "ENOENT" },
    ]);
  });
});

function fileInfo(name: string, sizeBytes: number): LogFileInfo {
  return { name, path: `/fake/${name}`, sizeBytes };
}

describe("selectLogFilesWithinBudget", () => {
  it("keeps everything when the budget is not exceeded", () => {
    const files = [fileInfo("server-2026-08-19.log", 10), fileInfo("server.log", 10)];

    const selection = selectLogFilesWithinBudget(files, 100);

    expect(selection.kept).toEqual(files);
    expect(selection.truncatedLogFiles).toEqual([]);
    expect(selection.budgetExceeded).toBe(false);
  });

  it("drops the oldest files first, recording their names, never truncating the current file", () => {
    const files = [
      fileInfo("server-2026-08-18.log", 40),
      fileInfo("server-2026-08-19.log", 40),
      fileInfo("server-2026-08-20.log", 40),
      fileInfo("server.log", 10),
    ];

    const selection = selectLogFilesWithinBudget(files, 15);

    expect(selection.truncatedLogFiles).toEqual([
      "server-2026-08-18.log",
      "server-2026-08-19.log",
      "server-2026-08-20.log",
    ]);
    expect(selection.kept.map((f) => f.name)).toEqual(["server.log"]);
    // The residual `kept` total (server.log's 10 bytes) is back under the 15-byte budget once the
    // oldest files were dropped, so the budget WAS honoured in the end.
    expect(selection.budgetExceeded).toBe(false);
  });

  it("never drops the last remaining file even if it alone exceeds the budget", () => {
    const files = [fileInfo("server.log", 1_000)];

    const selection = selectLogFilesWithinBudget(files, 10);

    expect(selection.kept).toEqual(files);
    expect(selection.truncatedLogFiles).toEqual([]);
    // Nothing was left to drop, yet the surviving file alone (1000 bytes) is still over the
    // 10-byte budget: `truncatedLogFiles` alone would read identically to "everything fit"
    // without this flag. This is the SIZE-only, pre-tail signal — see `readKeptFiles`'s own
    // `budgetExceeded` below the current file's tail is what decides the manifest's final value.
    expect(selection.budgetExceeded).toBe(true);
    // Tells `readKeptFiles` to give this file's own tail reader the full 10-byte budget, since
    // nothing else in `kept` shares it.
    expect(selection.currentFileTailBudgetBytes).toBe(10);
  });

  it("leaves currentFileTailBudgetBytes undefined when every kept file fits in full", () => {
    const files = [fileInfo("server-2026-08-19.log", 10), fileInfo("server.log", 10)];

    const selection = selectLogFilesWithinBudget(files, 100);

    expect(selection.currentFileTailBudgetBytes).toBeUndefined();
  });

  it("the default budget is 50MB", () => {
    expect(DEFAULT_MAX_BUNDLE_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("readVerbatimLogLines", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-export-lines-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("splits on newline and drops only the trailing empty artifact", () => {
    const path = join(dir, "server.log");
    writeFileSync(path, '{"ts":"a"}\n{"ts":"b"}\n');

    expect(readVerbatimLogLines(path)).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
  });

  it("keeps a final line that has no trailing newline", () => {
    const path = join(dir, "server.log");
    writeFileSync(path, '{"ts":"a"}\n{"ts":"b"}');

    expect(readVerbatimLogLines(path)).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
  });

  it("returns an empty array for an empty file", () => {
    const path = join(dir, "server.log");
    writeFileSync(path, "");

    expect(readVerbatimLogLines(path)).toEqual([]);
  });
});

describe("readKeptFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-export-read-kept-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads every kept file's lines, in file order, into one contentLines array", () => {
    const pathA = join(dir, "server-2026-08-19.log");
    const pathB = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(pathA, '{"ts":"a"}\n');
    writeFileSync(pathB, '{"ts":"b"}\n');

    const result = readKeptFiles([
      { name: "server-2026-08-19.log", path: pathA, sizeBytes: 0 },
      { name: CURRENT_LOG_FILE_NAME, path: pathB, sizeBytes: 0 },
    ]);

    expect(result.contentLines).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
    expect(result.skippedLogFiles).toEqual([]);
  });

  // Regression: a file present in the list `selectLogFilesWithinBudget` kept can still vanish
  // (the sink's own rotation/retention pruning) before its bytes are actually read — a real race
  // reproduced here by deleting it between the discovery/selection step and the read step, not by
  // mocking. Before the fix, `readFileSync` threw straight out of `serializeBundleLines`, aborting
  // the whole export. After the fix, the vanished file is skipped (named, with the real fs error
  // code), and the surviving file's content still comes through.
  it("skips a kept file that vanishes between discovery and the read, recording its name and error kind", () => {
    const survivingPath = join(dir, "server-2026-08-19.log");
    const vanishingPath = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(survivingPath, '{"ts":"a"}\n');
    writeFileSync(vanishingPath, '{"ts":"b"}\n');

    const discovery = discoverServerLogFiles(dir);
    const selection = selectLogFilesWithinBudget(discovery.files, DEFAULT_MAX_BUNDLE_BYTES);
    expect(selection.kept.map((f) => f.name)).toEqual([
      "server-2026-08-19.log",
      CURRENT_LOG_FILE_NAME,
    ]);

    // The race: the current log file rotates out from under the export after it was selected.
    rmSync(vanishingPath);

    const result = readKeptFiles(selection.kept);

    expect(result.contentLines).toEqual(['{"ts":"a"}']);
    expect(result.skippedLogFiles).toEqual([{ name: CURRENT_LOG_FILE_NAME, errorKind: "ENOENT" }]);
  });

  // Regression for #2902 PR review: `contentLines.push(...fileLines)` spreads the entire file's
  // lines as call arguments. A 50MB rotated file with short lines produces hundreds of thousands
  // of them, and V8 throws `RangeError: Maximum call stack size exceeded` well before that —
  // reproduced here with 300,000 short lines built directly as a string (never touching the real
  // 50MB budget, so the test stays fast) rather than an element-wise push. Every line must survive
  // the round trip, in order, with the exact count.
  it("reads a very large kept file without throwing, returning every line in order", () => {
    const lineCount = 300_000;
    const path = join(dir, CURRENT_LOG_FILE_NAME);
    const text = `${Array.from({ length: lineCount }, (_, i) => `line-${String(i)}`).join("\n")}\n`;
    writeFileSync(path, text);

    const result = readKeptFiles([{ name: CURRENT_LOG_FILE_NAME, path, sizeBytes: 0 }]);

    expect(result.contentLines).toHaveLength(lineCount);
    expect(result.contentLines[0]).toBe("line-0");
    expect(result.contentLines.at(-1)).toBe(`line-${String(lineCount - 1)}`);
    expect(result.skippedLogFiles).toEqual([]);
  });
});

// Regression for #2902 PR review, follow-up finding: `selectLogFilesWithinBudget`'s "never drop
// the last file" rule kept a single oversized current `server.log` in full, exceeding
// `--max-bytes`, and `readVerbatimLogLines` read it with a whole-file `readFileSync`. These tests
// exercise the fix's contract directly on `readKeptFiles`: only the LAST kept file's tail is read
// (bounded, never the whole file), the kept content always starts on a complete line, and the
// manifest-facing `budgetExceeded` reflects whether that tail read actually rescued the export.
describe("readKeptFiles — current-file tail truncation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-export-tail-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads only the current file's tail when it alone exceeds the budget, starting on a complete line and staying within budget", () => {
    const lineCount = 20;
    const text = fixedWidthLogText(lineCount); // 12 bytes/line (11 + "\n") = 240 bytes total
    const path = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(path, text);
    const sizeBytes = Buffer.byteLength(text, "utf8");
    const tailBudgetBytes = 30; // < sizeBytes; cuts mid-line, so the boundary advance is exercised

    const result = readKeptFiles(
      [{ name: CURRENT_LOG_FILE_NAME, path, sizeBytes }],
      tailBudgetBytes,
    );

    // The first kept line is one of the file's own complete lines, never a partial JSON fragment.
    expect(result.contentLines.length).toBeGreaterThan(0);
    expect(result.contentLines[0]).toMatch(/^\{"seq":\d{3}\}$/);
    // Every kept line is the file's tail, in original (oldest-first) order.
    expect(result.contentLines).toEqual([fixedWidthLine(18), fixedWidthLine(19)]);
    const keptBytes = Buffer.byteLength(`${result.contentLines.join("\n")}\n`, "utf8");
    expect(keptBytes).toBeLessThanOrEqual(tailBudgetBytes);
    // (a) the manifest fact is set, name only, with the exact dropped-byte count.
    expect(result.currentFileTailTruncated).toEqual({
      name: CURRENT_LOG_FILE_NAME,
      droppedBytes: sizeBytes - keptBytes,
    });
    // (b) the tail strategy rescued the export, so the manifest must not claim the budget failed.
    expect(result.budgetExceeded).toBe(false);
    expect(result.skippedLogFiles).toEqual([]);
  });

  it("keeps every older file's read in full and only tail-reads the current (last) file", () => {
    const rotatedPath = join(dir, "server-2026-08-19.log");
    const currentPath = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(rotatedPath, '{"seq":"old"}\n');
    const currentText = fixedWidthLogText(20);
    writeFileSync(currentPath, currentText);
    const currentSizeBytes = Buffer.byteLength(currentText, "utf8");

    const result = readKeptFiles(
      [
        { name: "server-2026-08-19.log", path: rotatedPath, sizeBytes: 0 },
        { name: CURRENT_LOG_FILE_NAME, path: currentPath, sizeBytes: currentSizeBytes },
      ],
      30,
    );

    expect(result.contentLines[0]).toBe('{"seq":"old"}');
    expect(result.contentLines.slice(1)).toEqual([fixedWidthLine(18), fixedWidthLine(19)]);
    expect(result.currentFileTailTruncated?.name).toBe(CURRENT_LOG_FILE_NAME);
    expect(result.budgetExceeded).toBe(false);
  });

  // (c) A budget smaller than a single line — here, a file that is one giant line with no
  // newline anywhere at all, so no byte offset within it can ever start a complete line.
  it("keeps an empty tail and reports budgetExceeded when the budget is smaller than one line", () => {
    const path = join(dir, CURRENT_LOG_FILE_NAME);
    const text = `{"seq":"${"x".repeat(1_000)}"}`; // one line, no trailing newline anywhere
    writeFileSync(path, text);
    const sizeBytes = Buffer.byteLength(text, "utf8");

    const result = readKeptFiles([{ name: CURRENT_LOG_FILE_NAME, path, sizeBytes }], 5);

    expect(result.contentLines).toEqual([]);
    expect(result.currentFileTailTruncated).toEqual({
      name: CURRENT_LOG_FILE_NAME,
      droppedBytes: sizeBytes,
    });
    expect(result.budgetExceeded).toBe(true);
  });

  it("never attempts a tail read, and never sets budgetExceeded, when currentFileTailBudgetBytes is undefined", () => {
    const path = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(path, fixedWidthLogText(5));

    const result = readKeptFiles([{ name: CURRENT_LOG_FILE_NAME, path, sizeBytes: 0 }]);

    expect(result.contentLines).toHaveLength(5);
    expect(result.currentFileTailTruncated).toBeUndefined();
    expect(result.budgetExceeded).toBe(false);
  });

  // Same vanish-before-read race `readVerbatimLogLinesOrSkip` already guards against, exercised on
  // the bounded tail-reader path instead: the file selected for a tail read can still disappear
  // before `openSync` runs.
  it("skips the current file, recording its name and error kind, when it vanishes before the tail read", () => {
    const path = join(dir, CURRENT_LOG_FILE_NAME);
    writeFileSync(path, fixedWidthLogText(5));
    rmSync(path);

    const result = readKeptFiles([{ name: CURRENT_LOG_FILE_NAME, path, sizeBytes: 1_000 }], 30);

    expect(result.contentLines).toEqual([]);
    expect(result.currentFileTailTruncated).toBeUndefined();
    expect(result.skippedLogFiles).toEqual([{ name: CURRENT_LOG_FILE_NAME, errorKind: "ENOENT" }]);
  });
});

describe("describeErrorKind", () => {
  it("reports the fs error's code when it has one, never the message or a path", () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open '/secret'"), {
      code: "ENOENT",
    });

    expect(describeErrorKind(error)).toBe("ENOENT");
  });

  it("falls back to the error's constructor name when there is no code", () => {
    expect(describeErrorKind(new TypeError("boom"))).toBe("TypeError");
  });

  it("falls back to the error's constructor name when code is not a short identifier", () => {
    const error = Object.assign(new Error("boom"), { code: "/absolute/path/leak" });

    expect(describeErrorKind(error)).toBe("Error");
  });

  it("falls back to the generic Error kind for a thrown non-Error value", () => {
    expect(describeErrorKind("not an error")).toBe("Error");
  });
});

describe("buildSupportBundleManifest", () => {
  it("produces the exact manifest shape for the minimal Wave 1 bundle", () => {
    const manifest = buildSupportBundleManifest(
      baseManifestInput({
        sourceLogFiles: ["server-2026-08-20.log", "server.log"],
        truncatedLogFiles: ["server-2026-08-18.log"],
        skippedLogFiles: [{ name: "server-2026-08-17.log", errorKind: "ENOENT" }],
        evidenceIndexCount: 3,
      }),
    );

    expect(manifest).toEqual({
      $section: "manifest",
      schemaVersion: SERVER_LOG_SCHEMA_VERSION,
      bundleFormatVersion: 1,
      productVersion: "0.3.15",
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v24.18.0",
      generatedAt: "2026-08-21T00:00:00.000Z",
      installMode: "unknown",
      stateDirSource: "default",
      redactionAttested: true,
      sourceLogFiles: ["server-2026-08-20.log", "server.log"],
      truncatedLogFiles: ["server-2026-08-18.log"],
      budgetExceeded: false,
      skippedLogFiles: [{ name: "server-2026-08-17.log", errorKind: "ENOENT" }],
      sectionsExcluded: [],
      auditSummary: REDACTED_HEALTHY_AUDIT,
      evidenceIndexCount: 3,
    });
  });

  // Regression for the leak this manifest exists to prevent: `AuditResult.stateDir` is the
  // absolute directory the audit ran against — the same value `resolveStateDir` computes by
  // default and which embeds the operator's OS username on a real machine. The manifest's
  // `stateDirSource` closed-union label at the top level already says everything an agent needs
  // ("was this the default location or an override"), so the raw path must never round-trip
  // through `auditSummary` into the exported bundle.
  it("never embeds the raw stateDir the audit ran against", () => {
    const manifest = buildSupportBundleManifest(baseManifestInput());

    expect(manifest.auditSummary).not.toHaveProperty("stateDir");
    expect(JSON.stringify(manifest)).not.toContain(HEALTHY_AUDIT.stateDir);
  });

  // `buildSupportBundleManifest` forwards `schemaVersion` verbatim rather than deriving its own
  // copy (see `ManifestInput.schemaVersion`'s doc comment) — the real value comes from
  // `packages/keiko-server/src/observability/server-log.ts`'s own `SERVER_LOG_SCHEMA_VERSION`,
  // imported here (not hard-coded) so a future bump of that constant fails this assertion
  // automatically instead of relying on a hand-maintained copy staying in sync.
  it("tracks the server's log schema version", () => {
    expect(buildSupportBundleManifest(baseManifestInput()).schemaVersion).toBe(
      SERVER_LOG_SCHEMA_VERSION,
    );
  });

  // `budgetExceeded` propagates verbatim from `ManifestInput` — the caller (`support.ts`) is the
  // one place that resolves it from `readKeptFiles`'s post-tail result, so by the time it reaches
  // this function it is already the authoritative value: true only when even a tail read of the
  // current file could not keep a single complete line (see `ReadKeptFilesResult.budgetExceeded`).
  it("propagates budgetExceeded from ManifestInput", () => {
    expect(
      buildSupportBundleManifest(baseManifestInput({ budgetExceeded: true })).budgetExceeded,
    ).toBe(true);
    expect(
      buildSupportBundleManifest(baseManifestInput({ budgetExceeded: false })).budgetExceeded,
    ).toBe(false);
  });

  // `currentFileTailTruncated` propagates verbatim from `ManifestInput`, same as
  // `truncatedLogFiles` — the distinct, machine-readable fact that the current file's tail (not
  // its whole content) was exported, naming only the file and the byte count cut, never a path.
  it("propagates currentFileTailTruncated from ManifestInput", () => {
    const fact = { name: CURRENT_LOG_FILE_NAME, droppedBytes: 123 };
    expect(
      buildSupportBundleManifest(baseManifestInput({ currentFileTailTruncated: fact }))
        .currentFileTailTruncated,
    ).toEqual(fact);
    expect(
      buildSupportBundleManifest(baseManifestInput({ currentFileTailTruncated: undefined }))
        .currentFileTailTruncated,
    ).toBeUndefined();
  });

  it("always leaves sectionsExcluded empty in this minimal version", () => {
    expect(buildSupportBundleManifest(baseManifestInput()).sectionsExcluded).toEqual([]);
  });
});

describe("serializeBundleLines and bundleText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-export-serialize-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies every source line byte-for-byte, unchanged, after the manifest line", () => {
    const rotatedPath = join(dir, "server-2026-08-19.log");
    const currentPath = join(dir, CURRENT_LOG_FILE_NAME);
    const rotatedLine = '{"ts":"2026-08-19T00:00:00.000Z","category":"http","op":"a\\nb","seq":1}';
    const currentLine = '{"ts":"2026-08-20T00:00:00.000Z","category":"http","op":"c","seq":2}';
    writeFileSync(rotatedPath, `${rotatedLine}\n`);
    writeFileSync(currentPath, `${currentLine}\n`);
    const files: readonly LogFileInfo[] = [
      { name: "server-2026-08-19.log", path: rotatedPath, sizeBytes: 0 },
      { name: CURRENT_LOG_FILE_NAME, path: currentPath, sizeBytes: 0 },
    ];
    const manifest = buildSupportBundleManifest(baseManifestInput());
    const { contentLines } = readKeptFiles(files);

    const lines = serializeBundleLines(manifest, contentLines);

    expect(lines[0]).toBe(JSON.stringify(manifest));
    expect(lines.slice(1)).toEqual([rotatedLine, currentLine]);
    // The exact original bytes must survive re-parsing identically (the escaped \n inside the
    // "op" field must stay an escaped two-character sequence, never become a real newline byte
    // that would split the line).
    expect(JSON.parse(lines[1] ?? "")).toEqual(JSON.parse(rotatedLine));
  });

  it("bundleText joins with a single trailing newline, and is empty for zero lines", () => {
    expect(bundleText(["a", "b"])).toBe("a\nb\n");
    expect(bundleText([])).toBe("");
  });
});
