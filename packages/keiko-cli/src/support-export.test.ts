import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_LOG_SCHEMA_VERSION } from "@oscharko-dev/keiko-server";
import type { StoreFingerprint } from "@oscharko-dev/keiko-contracts";
import {
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  activityLogPinFileName,
  activityLogSegmentFileName,
  orderActivityLogFileNames,
  type ActivityLogSegmentState,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { EvidenceManifest } from "@oscharko-dev/keiko-evidence";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";

import type { AuditResult } from "./audit.js";
import {
  bundleSha256Hex,
  bundleText,
  buildConfigSnapshotSection,
  buildEvidenceManifestSection,
  buildSupportBundleManifest,
  buildUiLogSection,
  DEFAULT_MAX_BUNDLE_BYTES,
  describeErrorKind,
  discoverServerLogFiles,
  readKeptFiles,
  readVerbatimLogLines,
  selectLogFilesWithinBudget,
  serializeBundleLines,
  sha256SidecarPath,
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

// The server's own writer always produces owner-private (0o600) log files, and the export only
// reads a log through a descriptor verified to be exactly that shape — fixtures mirror it.
function writePrivateLog(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

// Segment names come from the shared closed grammar (keiko-contracts `activity-log-files.ts`),
// never from a hand-written spelling that could drift from what the writer creates.
const SEGMENT_START_MS = Date.parse("2026-08-21T10:00:00.000Z");

function segmentName(index: number, state: ActivityLogSegmentState = "sealed", pid = 4242): string {
  return activityLogSegmentFileName(
    { startMs: SEGMENT_START_MS, pid, instanceId: "a1b2c3d4", index },
    state,
  );
}

// The newest file of a live Activity Log: the writer's active segment, after its sealed sibling.
const SEALED_SEGMENT = segmentName(1);
const CURRENT_SEGMENT = segmentName(2, "active");

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
    sourceLogFileLines: [],
    truncatedLogFiles: [],
    currentFileTailTruncated: undefined,
    budgetExceeded: false,
    skippedLogFiles: [],
    auditSummary: HEALTHY_AUDIT,
    evidenceIndexCount: 0,
    storeFingerprints: [],
    storesUnavailable: [],
    sectionsExcluded: [],
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

  // #3530: one logical log spread over legacy files and per-process segments. Discovery must use
  // the shared logical-log ordering, never the directory's name order: legacy files precede every
  // segment, and a numerically smaller pid precedes a larger one at the same start time even though
  // its name sorts later. Pin records and foreign files are not log content.
  it("orders legacy files and segments in logical-log order, never by name", () => {
    const logNames = [
      "server-2026-08-20.log",
      "server-2026-08-19.log",
      ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
      segmentName(1, "sealed", 10_000),
      segmentName(1, "sealed", 999),
      segmentName(2, "active", 999),
    ];
    for (const name of logNames) writePrivateLog(join(dir, name), "c\n");
    writePrivateLog(join(dir, activityLogPinFileName("0123456789abcdef01234567")), "{}\n");
    writeFileSync(join(dir, "unrelated.txt"), "ignored\n");
    const expected = orderActivityLogFileNames(logNames).map((file) => file.name);
    expect(expected).not.toEqual([...logNames].sort());

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual(expected);
    expect(discovery.files.every((f) => f.sizeBytes === 2)).toBe(true);
    expect(discovery.skippedLogFiles).toEqual([]);
  });

  it("omits the current file from the ordering when it does not exist", () => {
    writePrivateLog(join(dir, "server-2026-08-19.log"), "a\n");

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual(["server-2026-08-19.log"]);
  });

  it("returns an empty result for a logs directory that does not exist, never throwing", () => {
    expect(discoverServerLogFiles(join(dir, "does-not-exist"))).toEqual({
      files: [],
      skippedLogFiles: [],
    });
  });

  // Regression-shaped: a name `readdirSync` returns can vanish before it is opened (for example,
  // through concurrent operator cleanup), one step earlier than the `readKeptFiles` race pinned
  // below. Discovery must skip it (recording its name and the real fs error code, never a path)
  // instead of throwing out of the whole export. A dangling symlink used to stand in for this
  // race, but a symlink at a log name is now refused before it is followed (next test), so the
  // vanished name is reproduced by listing one that no longer exists.
  it("skips a rotated file that vanishes between readdirSync and the verified open, recording its name and error kind", async () => {
    writePrivateLog(join(dir, "server-2026-08-19.log"), "a\n");
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readdirSync: (path: string): string[] => [
          ...actual.readdirSync(path),
          "server-2026-08-20.log",
        ],
      };
    });
    try {
      const isolated = await import("./support-export.js");

      const discovery = isolated.discoverServerLogFiles(dir);

      expect(discovery.files.map((f) => f.name)).toEqual(["server-2026-08-19.log"]);
      expect(discovery.skippedLogFiles).toEqual([
        { name: "server-2026-08-20.log", errorKind: "ENOENT" },
      ]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  // #3528: the size probe used to `statSync` (and the read `readFileSync`) through a symlink, so a
  // link named like a log embedded any file this user can read into the exported bundle. Every
  // entry is now opened without following a link and verified as a private, single-link regular
  // file: live and dangling symlinks and hard links are refused as `unsafe-target`, a non-private
  // file as `permission-unsafe` — each skipped by name only, its target never sized or read.
  it("refuses symlinked, hard-linked, and non-private log entries without following them", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const victim = join(dir, "victim.txt");
    writePrivateLog(victim, "VICTIM-BYTES\n");
    writePrivateLog(join(dir, CURRENT_SEGMENT), "c\n");
    symlinkSync(victim, join(dir, "server-2026-08-17.log"));
    symlinkSync(join(dir, "missing-target.log"), join(dir, "server-2026-08-18.log"));
    linkSync(victim, join(dir, "server-2026-08-19.log"));
    writeFileSync(join(dir, "server-2026-08-20.log"), "shared\n", { mode: 0o644 });
    symlinkSync(victim, join(dir, SEALED_SEGMENT));

    const discovery = discoverServerLogFiles(dir);

    expect(discovery.files.map((f) => f.name)).toEqual([CURRENT_SEGMENT]);
    expect(discovery.skippedLogFiles).toEqual([
      { name: "server-2026-08-17.log", errorKind: "unsafe-target" },
      { name: "server-2026-08-18.log", errorKind: "unsafe-target" },
      { name: "server-2026-08-19.log", errorKind: "unsafe-target" },
      { name: "server-2026-08-20.log", errorKind: "permission-unsafe" },
      { name: SEALED_SEGMENT, errorKind: "unsafe-target" },
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
    writePrivateLog(path, '{"ts":"a"}\n{"ts":"b"}\n');

    expect(readVerbatimLogLines(path)).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
  });

  it("keeps a final line that has no trailing newline", () => {
    const path = join(dir, "server.log");
    writePrivateLog(path, '{"ts":"a"}\n{"ts":"b"}');

    expect(readVerbatimLogLines(path)).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
  });

  it("returns an empty array for an empty file", () => {
    const path = join(dir, "server.log");
    writePrivateLog(path, "");

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
    const pathB = join(dir, CURRENT_SEGMENT);
    writePrivateLog(pathA, '{"ts":"a"}\n');
    writePrivateLog(pathB, '{"ts":"b"}\n');

    const result = readKeptFiles([
      { name: "server-2026-08-19.log", path: pathA, sizeBytes: 0 },
      { name: CURRENT_SEGMENT, path: pathB, sizeBytes: 0 },
    ]);

    expect(result.contentLines).toEqual(['{"ts":"a"}', '{"ts":"b"}']);
    expect(result.terminalFragment).toBe(false);
    expect(result.skippedLogFiles).toEqual([]);
  });

  // #3530: a crashed writer leaves a torn last line in ITS segment, and the bundle joins newer files
  // after it. Each contributing file's line count and torn-tail flag travel in bundle order so the
  // analyzer can still classify that line as truncated; an empty file adds no lines and no entry.
  it("records each contributing file's line count and torn tail, in bundle order", () => {
    const emptySegment = segmentName(1, "sealed", 5_000);
    const tornPath = join(dir, SEALED_SEGMENT);
    const emptyPath = join(dir, emptySegment);
    const currentPath = join(dir, CURRENT_SEGMENT);
    writePrivateLog(tornPath, '{"ts":"a"}\n{"ts":');
    writePrivateLog(emptyPath, "");
    writePrivateLog(currentPath, '{"ts":"b"}\n');

    const result = readKeptFiles([
      { name: SEALED_SEGMENT, path: tornPath, sizeBytes: 0 },
      { name: emptySegment, path: emptyPath, sizeBytes: 0 },
      { name: CURRENT_SEGMENT, path: currentPath, sizeBytes: 0 },
    ]);

    expect(result.contentLines).toEqual(['{"ts":"a"}', '{"ts":', '{"ts":"b"}']);
    expect(result.terminalFragment).toBe(false);
    expect(result.sourceLogFileLines).toEqual([
      { name: SEALED_SEGMENT, lineCount: 2, terminalFragment: true },
      { name: CURRENT_SEGMENT, lineCount: 1, terminalFragment: false },
    ]);
  });

  // Regression: a file present in the list `selectLogFilesWithinBudget` kept can still vanish
  // through concurrent operator cleanup before its bytes are actually read — a real race
  // reproduced here by deleting it between the discovery/selection step and the read step, not by
  // mocking. Before the fix, `readFileSync` threw straight out of `serializeBundleLines`, aborting
  // the whole export. After the fix, the vanished file is skipped (named, with the real fs error
  // code), and the surviving file's content still comes through.
  it("skips a kept file that vanishes between discovery and the read, recording its name and error kind", () => {
    const survivingPath = join(dir, "server-2026-08-19.log");
    const vanishingPath = join(dir, CURRENT_SEGMENT);
    writePrivateLog(survivingPath, '{"ts":"a"}\n');
    writePrivateLog(vanishingPath, '{"ts":"b"}\n');

    const discovery = discoverServerLogFiles(dir);
    const selection = selectLogFilesWithinBudget(discovery.files, DEFAULT_MAX_BUNDLE_BYTES);
    expect(selection.kept.map((f) => f.name)).toEqual(["server-2026-08-19.log", CURRENT_SEGMENT]);

    // The race: the selected current log is removed by another actor before export reads it.
    rmSync(vanishingPath);

    const result = readKeptFiles(selection.kept);

    expect(result.contentLines).toEqual(['{"ts":"a"}']);
    expect(result.skippedLogFiles).toEqual([{ name: CURRENT_SEGMENT, errorKind: "ENOENT" }]);
  });

  // #3528: discovery's verified open does not protect the later read — a kept name swapped for a
  // symlink in between must be refused again at read time, whole-file and tail reader alike, so the
  // link target's bytes never reach the bundle.
  it("refuses a kept file replaced by a symlink before the read, never reading its target", (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const victim = join(dir, "victim.txt");
    writePrivateLog(victim, "VICTIM-BYTES\n");
    const rotatedPath = join(dir, "server-2026-08-19.log");
    const currentPath = join(dir, CURRENT_SEGMENT);
    writePrivateLog(rotatedPath, '{"ts":"a"}\n');
    writePrivateLog(currentPath, '{"ts":"b"}\n');
    const kept = discoverServerLogFiles(dir).files;
    for (const path of [rotatedPath, currentPath]) {
      rmSync(path);
      symlinkSync(victim, path);
    }

    const result = readKeptFiles(kept, 1_000);

    expect(result.contentLines).toEqual([]);
    expect(result.skippedLogFiles).toEqual([
      { name: "server-2026-08-19.log", errorKind: "unsafe-target" },
      { name: CURRENT_SEGMENT, errorKind: "unsafe-target" },
    ]);
  });

  // Regression for #2902 PR review: `contentLines.push(...fileLines)` spreads the entire file's
  // lines as call arguments. A 50MB rotated file with short lines produces hundreds of thousands
  // of them, and V8 throws `RangeError: Maximum call stack size exceeded` well before that —
  // reproduced here with 300,000 short lines built directly as a string (never touching the real
  // 50MB budget, so the test stays fast) rather than an element-wise push. Every line must survive
  // the round trip, in order, with the exact count.
  it("reads a very large kept file without throwing, returning every line in order", () => {
    const lineCount = 300_000;
    const path = join(dir, CURRENT_SEGMENT);
    const text = `${Array.from({ length: lineCount }, (_, i) => `line-${String(i)}`).join("\n")}\n`;
    writePrivateLog(path, text);

    const result = readKeptFiles([{ name: CURRENT_SEGMENT, path, sizeBytes: 0 }]);

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
    const path = join(dir, CURRENT_SEGMENT);
    writePrivateLog(path, text);
    const sizeBytes = Buffer.byteLength(text, "utf8");
    const tailBudgetBytes = 30; // < sizeBytes; cuts mid-line, so the boundary advance is exercised

    const result = readKeptFiles([{ name: CURRENT_SEGMENT, path, sizeBytes }], tailBudgetBytes);

    // The first kept line is one of the file's own complete lines, never a partial JSON fragment.
    expect(result.contentLines.length).toBeGreaterThan(0);
    expect(result.contentLines[0]).toMatch(/^\{"seq":\d{3}\}$/);
    // Every kept line is the file's tail, in original (oldest-first) order.
    expect(result.contentLines).toEqual([fixedWidthLine(18), fixedWidthLine(19)]);
    const keptBytes = Buffer.byteLength(`${result.contentLines.join("\n")}\n`, "utf8");
    expect(keptBytes).toBeLessThanOrEqual(tailBudgetBytes);
    // (a) the manifest fact is set, name only, with the exact dropped-byte count.
    expect(result.currentFileTailTruncated).toEqual({
      name: CURRENT_SEGMENT,
      droppedBytes: sizeBytes - keptBytes,
    });
    // (b) the tail strategy rescued the export, so the manifest must not claim the budget failed.
    expect(result.budgetExceeded).toBe(false);
    expect(result.skippedLogFiles).toEqual([]);
  });

  it("keeps every older file's read in full and only tail-reads the current (last) file", () => {
    const rotatedPath = join(dir, "server-2026-08-19.log");
    const currentPath = join(dir, CURRENT_SEGMENT);
    writePrivateLog(rotatedPath, '{"seq":"old"}\n');
    const currentText = fixedWidthLogText(20);
    writePrivateLog(currentPath, currentText);
    const currentSizeBytes = Buffer.byteLength(currentText, "utf8");

    const result = readKeptFiles(
      [
        { name: "server-2026-08-19.log", path: rotatedPath, sizeBytes: 0 },
        { name: CURRENT_SEGMENT, path: currentPath, sizeBytes: currentSizeBytes },
      ],
      30,
    );

    expect(result.contentLines[0]).toBe('{"seq":"old"}');
    expect(result.contentLines.slice(1)).toEqual([fixedWidthLine(18), fixedWidthLine(19)]);
    expect(result.currentFileTailTruncated?.name).toBe(CURRENT_SEGMENT);
    expect(result.budgetExceeded).toBe(false);
  });

  // (c) A budget smaller than a single line — here, a file that is one giant line with no
  // newline anywhere at all, so no byte offset within it can ever start a complete line.
  it("keeps an empty tail and reports budgetExceeded when the budget is smaller than one line", () => {
    const path = join(dir, CURRENT_SEGMENT);
    const text = `{"seq":"${"x".repeat(1_000)}"}`; // one line, no trailing newline anywhere
    writePrivateLog(path, text);
    const sizeBytes = Buffer.byteLength(text, "utf8");

    const result = readKeptFiles([{ name: CURRENT_SEGMENT, path, sizeBytes }], 5);

    expect(result.contentLines).toEqual([]);
    expect(result.currentFileTailTruncated).toEqual({
      name: CURRENT_SEGMENT,
      droppedBytes: sizeBytes,
    });
    expect(result.budgetExceeded).toBe(true);
  });

  it("never attempts a tail read, and never sets budgetExceeded, when currentFileTailBudgetBytes is undefined", () => {
    const path = join(dir, CURRENT_SEGMENT);
    writePrivateLog(path, fixedWidthLogText(5));

    const result = readKeptFiles([{ name: CURRENT_SEGMENT, path, sizeBytes: 0 }]);

    expect(result.contentLines).toHaveLength(5);
    expect(result.currentFileTailTruncated).toBeUndefined();
    expect(result.budgetExceeded).toBe(false);
  });

  // Same vanish-before-read race `readVerbatimLogLinesOrSkip` already guards against, exercised on
  // the bounded tail-reader path instead: the file selected for a tail read can still disappear
  // before `openSync` runs.
  it("skips the current file, recording its name and error kind, when it vanishes before the tail read", () => {
    const path = join(dir, CURRENT_SEGMENT);
    writePrivateLog(path, fixedWidthLogText(5));
    rmSync(path);

    const result = readKeptFiles([{ name: CURRENT_SEGMENT, path, sizeBytes: 1_000 }], 30);

    expect(result.contentLines).toEqual([]);
    expect(result.currentFileTailTruncated).toBeUndefined();
    expect(result.skippedLogFiles).toEqual([{ name: CURRENT_SEGMENT, errorKind: "ENOENT" }]);
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

  it("reports a hardened-primitive refusal by its closed kind, never its constructor name", () => {
    expect(describeErrorKind(new SafeArtifactFileError("activity-log", "unsafe-target"))).toBe(
      "unsafe-target",
    );
  });
});

describe("buildSupportBundleManifest", () => {
  it("names a fingerprint that fails the contract guard in storesUnavailable instead of dropping it", () => {
    // A store that vanished from both lists would read as "never used" — the one claim a support
    // bundle must not make about a store that exists (Wave 4a acceptance regression).
    const contradictory = {
      store: "memory-vault",
      schemaVersion: 0,
      migrationsApplied: [],
      tableRowCounts: {},
      quickCheckOk: false,
      encryptionMode: "plaintext",
      keySource: "env",
    } as unknown as StoreFingerprint;
    const manifest = buildSupportBundleManifest(
      baseManifestInput({ storeFingerprints: [contradictory], storesUnavailable: [] }),
    );
    expect(manifest.storeFingerprints).toEqual([]);
    expect(manifest.storesUnavailable).toEqual([
      { store: "memory-vault", reasonKind: "invalid-fingerprint" },
    ]);
  });

  it("produces the exact manifest shape for the minimal Wave 1 bundle", () => {
    const manifest = buildSupportBundleManifest(
      baseManifestInput({
        sourceLogFiles: ["server-2026-08-20.log", "server.log"],
        sourceLogFileLines: [
          { name: "server-2026-08-20.log", lineCount: 4, terminalFragment: false },
          { name: "server.log", lineCount: 1, terminalFragment: true },
        ],
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
      sourceLogFileLines: [
        { name: "server-2026-08-20.log", lineCount: 4, terminalFragment: false },
        { name: "server.log", lineCount: 1, terminalFragment: true },
      ],
      truncatedLogFiles: ["server-2026-08-18.log"],
      budgetExceeded: false,
      skippedLogFiles: [{ name: "server-2026-08-17.log", errorKind: "ENOENT" }],
      sectionsExcluded: [],
      auditSummary: REDACTED_HEALTHY_AUDIT,
      evidenceIndexCount: 3,
      storeFingerprints: [],
      storesUnavailable: [],
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

  // Wave 4a (epic #3233 §6.2/§8): a valid fingerprint and an unavailable-store entry both pass
  // through to the manifest unchanged.
  it("carries valid storeFingerprints and storesUnavailable entries through unchanged", () => {
    const validFingerprint: StoreFingerprint = {
      store: "ui",
      schemaVersion: 19,
      migrationsApplied: ["v1"],
      tableRowCounts: { projects: 2 },
      quickCheckOk: true,
      encryptionMode: "plaintext",
    };

    const manifest = buildSupportBundleManifest(
      baseManifestInput({
        storeFingerprints: [validFingerprint],
        storesUnavailable: [{ store: "memory-vault", reasonKind: "missing" }],
      }),
    );

    expect(manifest.storeFingerprints).toEqual([validFingerprint]);
    expect(manifest.storesUnavailable).toEqual([{ store: "memory-vault", reasonKind: "missing" }]);
  });

  // Defense-in-depth (this file's own header discipline, and the redaction doctrine every other
  // guard in this repo follows): a fingerprint that fails the shared `isStoreFingerprint` guard —
  // here, a negative row count nothing in this codebase could produce — must never reach the
  // exported bundle, even though `buildSupportBundleManifest`'s own caller is the only producer
  // today. Proves the filter is live, not merely a type-level assumption.
  it("drops a fingerprint that fails isStoreFingerprint rather than embedding it", () => {
    const malformed = {
      store: "local-knowledge",
      schemaVersion: 1,
      migrationsApplied: [],
      tableRowCounts: { capsules: -1 },
      quickCheckOk: true,
      encryptionMode: "plaintext",
    } as unknown as StoreFingerprint;

    const manifest = buildSupportBundleManifest(
      baseManifestInput({ storeFingerprints: [malformed] }),
    );

    expect(manifest.storeFingerprints).toEqual([]);
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
    const fact = { name: CURRENT_SEGMENT, droppedBytes: 123 };
    expect(
      buildSupportBundleManifest(baseManifestInput({ currentFileTailTruncated: fact }))
        .currentFileTailTruncated,
    ).toEqual(fact);
    expect(
      buildSupportBundleManifest(baseManifestInput({ currentFileTailTruncated: undefined }))
        .currentFileTailTruncated,
    ).toBeUndefined();
  });

  it("passes sectionsExcluded through from ManifestInput unchanged (Wave 6)", () => {
    expect(buildSupportBundleManifest(baseManifestInput()).sectionsExcluded).toEqual([]);
    expect(
      buildSupportBundleManifest(baseManifestInput({ sectionsExcluded: ["ui-log"] }))
        .sectionsExcluded,
    ).toEqual(["ui-log"]);
  });
});

describe("Wave 6 section builders", () => {
  it("buildUiLogSection wraps verbatim content with the ui-log $section tag", () => {
    expect(buildUiLogSection("TypeError: boom\n")).toEqual({
      $section: "ui-log",
      content: "TypeError: boom\n",
    });
  });

  it("buildConfigSnapshotSection wraps the caller-supplied (already-redacted) fields", () => {
    const fields = { KEIKO_STATE_DIR: "[redacted-path]" };
    expect(buildConfigSnapshotSection(fields)).toEqual({
      $section: "config-snapshot",
      fields,
    });
  });

  it("buildEvidenceManifestSection wraps one runId's full manifest", () => {
    const manifest = {
      evidenceSchemaVersion: "1",
      run: {
        runId: "run-a",
        fingerprint: "fp",
        harnessVersion: "0.1.5",
        taskType: "explain-plan",
        outcome: "completed",
        startedAt: 100,
        finishedAt: 150,
        durationMs: 50,
      },
      model: { modelId: "m1", costClass: "low" },
      usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
    } as unknown as EvidenceManifest;
    expect(buildEvidenceManifestSection("run-a", manifest)).toEqual({
      $section: "evidence-manifest",
      runId: "run-a",
      manifest,
    });
  });
});

describe("bundleSha256Hex", () => {
  it("matches an independently-computed SHA-256 digest of the same bytes", () => {
    const contents = "line-one\nline-two\n";
    const expected = createHash("sha256").update(contents, "utf8").digest("hex");
    expect(bundleSha256Hex(contents)).toBe(expected);
  });

  it("produces different digests for different content", () => {
    expect(bundleSha256Hex("a")).not.toBe(bundleSha256Hex("b"));
  });
});

describe("sha256SidecarPath", () => {
  it("appends .sha256 to the bundle output path", () => {
    expect(sha256SidecarPath("/tmp/out/bundle.jsonl")).toBe("/tmp/out/bundle.jsonl.sha256");
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
    const currentPath = join(dir, CURRENT_SEGMENT);
    const rotatedLine = '{"ts":"2026-08-19T00:00:00.000Z","category":"http","op":"a\\nb","seq":1}';
    const currentLine = '{"ts":"2026-08-20T00:00:00.000Z","category":"http","op":"c","seq":2}';
    writePrivateLog(rotatedPath, `${rotatedLine}\n`);
    writePrivateLog(currentPath, `${currentLine}\n`);
    const files: readonly LogFileInfo[] = [
      { name: "server-2026-08-19.log", path: rotatedPath, sizeBytes: 0 },
      { name: CURRENT_SEGMENT, path: currentPath, sizeBytes: 0 },
    ];
    const manifest = buildSupportBundleManifest(baseManifestInput());
    const { contentLines } = readKeptFiles(files);

    const lines = serializeBundleLines(manifest, [], contentLines);

    expect(lines[0]).toBe(JSON.stringify(manifest));
    expect(lines.slice(1)).toEqual([rotatedLine, currentLine]);
    // The exact original bytes must survive re-parsing identically (the escaped \n inside the
    // "op" field must stay an escaped two-character sequence, never become a real newline byte
    // that would split the line).
    expect(JSON.parse(lines[1] ?? "")).toEqual(JSON.parse(rotatedLine));
  });

  it("places every $section record between the manifest and the raw content lines, in order", () => {
    const manifest = buildSupportBundleManifest(baseManifestInput());
    const configSnapshot = buildConfigSnapshotSection({ KEIKO_STATE_DIR: "[redacted-path]" });
    const uiLog = buildUiLogSection("crash text\n");

    const lines = serializeBundleLines(manifest, [configSnapshot, uiLog], ["raw-log-line"]);

    expect(lines).toEqual([
      JSON.stringify(manifest),
      JSON.stringify(configSnapshot),
      JSON.stringify(uiLog),
      "raw-log-line",
    ]);
  });

  it("bundleText joins with a single trailing newline, and is empty for zero lines", () => {
    expect(bundleText(["a", "b"])).toBe("a\nb\n");
    expect(bundleText([])).toBe("");
  });

  it("preserves a copied terminal fragment without manufacturing a newline", () => {
    expect(bundleText(["manifest", '{"ts":'], true)).toBe('manifest\n{"ts":');
  });
});
