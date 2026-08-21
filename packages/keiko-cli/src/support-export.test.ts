import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  discoverServerLogFiles,
  readVerbatimLogLines,
  selectLogFilesWithinBudget,
  serializeBundleLines,
  type LogFileInfo,
} from "./support-export.js";

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

    const files = discoverServerLogFiles(dir);

    expect(files.map((f) => f.name)).toEqual([
      "server-2026-08-19.log",
      "server-2026-08-20.log",
      CURRENT_LOG_FILE_NAME,
    ]);
    expect(files.every((f) => f.sizeBytes === 2)).toBe(true);
  });

  it("omits the current file from the ordering when it does not exist", () => {
    writeFileSync(join(dir, "server-2026-08-19.log"), "a\n");

    const files = discoverServerLogFiles(dir);

    expect(files.map((f) => f.name)).toEqual(["server-2026-08-19.log"]);
  });

  it("returns an empty list for a logs directory that does not exist, never throwing", () => {
    expect(discoverServerLogFiles(join(dir, "does-not-exist"))).toEqual([]);
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
  });

  it("never drops the last remaining file even if it alone exceeds the budget", () => {
    const files = [fileInfo("server.log", 1_000)];

    const selection = selectLogFilesWithinBudget(files, 10);

    expect(selection.kept).toEqual(files);
    expect(selection.truncatedLogFiles).toEqual([]);
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

describe("buildSupportBundleManifest", () => {
  it("produces the exact manifest shape for the minimal Wave 1 bundle", () => {
    const manifest = buildSupportBundleManifest(
      baseManifestInput({
        sourceLogFiles: ["server-2026-08-20.log", "server.log"],
        truncatedLogFiles: ["server-2026-08-18.log"],
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

    const lines = serializeBundleLines(manifest, files);

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
