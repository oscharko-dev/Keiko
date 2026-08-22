import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInMemoryEvidenceStore,
  type EvidenceManifest,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import {
  createNodeUiStore,
  SERVER_LOG_SCHEMA_VERSION,
  UI_DB_FILENAME,
} from "@oscharko-dev/keiko-server";
import type { AuditResult } from "./audit.js";
import type { CliIo } from "./runner.js";
import { parseSupportArgs, runSupportCli, type SupportCliDeps } from "./support.js";
import { CURRENT_LOG_FILE_NAME } from "./support-export.js";

function makeIo(): { io: CliIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

const HEALTHY_AUDIT: AuditResult = {
  ok: true,
  stateDir: "/irrelevant/.keiko",
  classes: [{ id: "creds", title: "Credential references", status: "pass", findings: [] }],
};

const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

function healthyAuditDeps(): SupportCliDeps["auditDeps"] {
  return { loadAuditor: () => Promise.resolve({ auditLocalState: () => HEALTHY_AUDIT }) };
}

function minimalEvidenceManifest(runId: string): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
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
  };
}

function seededEvidenceStore(runIds: readonly string[]): EvidenceStore {
  const store = createInMemoryEvidenceStore();
  for (const runId of runIds) {
    store.put(runId, JSON.stringify(minimalEvidenceManifest(runId)));
  }
  return store;
}

describe("parseSupportArgs", () => {
  it("treats no args, --help, and -h as help", () => {
    expect(parseSupportArgs([])).toEqual({ kind: "help" });
    expect(parseSupportArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseSupportArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("rejects an unknown subcommand as usage", () => {
    const parsed = parseSupportArgs(["bogus"]);
    expect(parsed.kind).toBe("usage");
  });

  it("parses export flags, defaulting absent ones to undefined/false/empty", () => {
    expect(parseSupportArgs(["export"])).toEqual({
      kind: "export",
      value: {
        out: undefined,
        stateDir: undefined,
        maxBytes: undefined,
        includeUiLog: false,
        iUnderstandUnredacted: false,
        includeEvidenceRunIds: [],
      },
    });
    expect(
      parseSupportArgs([
        "export",
        "--out",
        "/tmp/x.jsonl",
        "--state-dir",
        "/tmp/.keiko",
        "--max-bytes",
        "100",
        "--include-ui-log",
        "--i-understand-this-is-unredacted",
        "--include-evidence",
        "run-a, run-b,,run-c",
      ]),
    ).toEqual({
      kind: "export",
      value: {
        out: "/tmp/x.jsonl",
        stateDir: "/tmp/.keiko",
        maxBytes: 100,
        includeUiLog: true,
        iUnderstandUnredacted: true,
        includeEvidenceRunIds: ["run-a", "run-b", "run-c"],
      },
    });
  });

  it("parses --include-ui-log alone as consent NOT given (the confirmation flag is separate)", () => {
    const parsed = parseSupportArgs(["export", "--include-ui-log"]);
    expect(parsed.kind).toBe("export");
    expect(parsed.kind === "export" && parsed.value.includeUiLog).toBe(true);
    expect(parsed.kind === "export" && parsed.value.iUnderstandUnredacted).toBe(false);
  });

  it("rejects a --max-bytes that is not a positive integer", () => {
    expect(parseSupportArgs(["export", "--max-bytes", "0"]).kind).toBe("usage");
    expect(parseSupportArgs(["export", "--max-bytes", "abc"]).kind).toBe("usage");
    expect(parseSupportArgs(["export", "--max-bytes", "-5"]).kind).toBe("usage");
  });

  it("rejects a flag missing its value", () => {
    expect(parseSupportArgs(["export", "--out"]).kind).toBe("usage");
  });

  it("requires a FILE for analyze", () => {
    expect(parseSupportArgs(["analyze"]).kind).toBe("usage");
    expect(parseSupportArgs(["analyze", "--json"]).kind).toBe("usage");
  });

  it("parses analyze flags", () => {
    expect(
      parseSupportArgs(["analyze", "bundle.jsonl", "--correlation-id", "req-1", "--json"]),
    ).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: "req-1",
        json: true,
        clusters: false,
        seed: false,
        emitFixture: undefined,
      },
    });
    expect(parseSupportArgs(["analyze", "bundle.jsonl"])).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: undefined,
        json: false,
        clusters: false,
        seed: false,
        emitFixture: undefined,
      },
    });
  });

  // Wave 6 (epic #3233 closeout, gap #1): --clusters/--seed/--emit-fixture now parse.
  it("parses --clusters, --seed, and --emit-fixture", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--clusters"])).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: undefined,
        json: false,
        clusters: true,
        seed: false,
        emitFixture: undefined,
      },
    });
    expect(
      parseSupportArgs([
        "analyze",
        "bundle.jsonl",
        "--correlation-id",
        "req-1",
        "--seed",
        "--emit-fixture",
        "out.ts",
      ]),
    ).toEqual({
      kind: "analyze",
      value: {
        file: "bundle.jsonl",
        correlationId: "req-1",
        json: false,
        clusters: false,
        seed: true,
        emitFixture: "out.ts",
      },
    });
  });

  it("rejects --seed without --correlation-id", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--seed"]).kind).toBe("usage");
  });

  it("rejects --emit-fixture without --correlation-id", () => {
    expect(parseSupportArgs(["analyze", "bundle.jsonl", "--emit-fixture", "out.ts"]).kind).toBe(
      "usage",
    );
  });

  it("rejects --emit-fixture missing its value", () => {
    expect(
      parseSupportArgs(["analyze", "bundle.jsonl", "--correlation-id", "req-1", "--emit-fixture"])
        .kind,
    ).toBe("usage");
  });
});

describe("runSupportCli export", () => {
  let stateDir: string;
  let outDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-cli-state-"));
    outDir = mkdtempSync(join(tmpdir(), "keiko-support-cli-out-"));
    mkdirSync(join(stateDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a bundle whose first line is the manifest and whose remaining lines are the log content, verbatim", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-19T00:00:00.000Z",
      category: "http",
      op: "req.a",
      correlationId: "req-1",
    });
    const currentLine = JSON.stringify({
      ts: "2026-08-20T00:00:00.000Z",
      category: "http",
      op: "req.b",
      correlationId: "req-1",
    });
    writeFileSync(join(stateDir, "logs", "server-2026-08-19.log"), `${rotatedLine}\n`);
    writeFileSync(join(stateDir, "logs", "server.log"), `${currentLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, AUDIT_ENV, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: seededEvidenceStore(["run-a", "run-b"]),
    });

    expect(code).toBe(0);
    // manifest + config-snapshot (always attached, Wave 6) + the two raw content lines.
    expect(c.out()).toContain("Wrote 4 lines to");
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, "utf8");
    const [manifestLine, configSnapshotLine, ...logLines] = written.trimEnd().split("\n");
    expect(logLines).toEqual([rotatedLine, currentLine]);
    const configSnapshot = JSON.parse(configSnapshotLine ?? "{}") as Record<string, unknown>;
    expect(configSnapshot.$section).toBe("config-snapshot");
    const manifest: Record<string, unknown> = JSON.parse(manifestLine ?? "{}") as Record<
      string,
      unknown
    >;
    expect(manifest.$section).toBe("manifest");
    expect(manifest.schemaVersion).toBe(SERVER_LOG_SCHEMA_VERSION);
    expect(manifest.bundleFormatVersion).toBe(1);
    expect(manifest.stateDirSource).toBe("env-override");
    expect(manifest.redactionAttested).toBe(true);
    expect(manifest.sourceLogFiles).toEqual(["server-2026-08-19.log", "server.log"]);
    expect(manifest.truncatedLogFiles).toEqual([]);
    expect(manifest.skippedLogFiles).toEqual([]);
    // Wave 6: "ui-log" is always named here unless BOTH --include-ui-log AND
    // --i-understand-this-is-unredacted were passed — neither was, here.
    expect(manifest.sectionsExcluded).toEqual(["ui-log"]);
    expect(manifest.evidenceIndexCount).toBe(2);
    // The manifest's auditSummary must carry the audit result MINUS the raw stateDir path (which
    // embeds the operator's OS username on a real machine): stateDirSource above already says
    // "default vs. override" without the absolute path.
    expect(manifest.auditSummary).toEqual({ ok: HEALTHY_AUDIT.ok, classes: HEALTHY_AUDIT.classes });
    expect(written).not.toContain(HEALTHY_AUDIT.stateDir);
  });

  // Regression pin: `redactLogFields`'s field-NAME denylist matches only an exact normalized
  // whole name (`log-redaction.ts`'s `DENIED_FIELD_NAMES`/`normalizeLogFieldName`). Every
  // config-snapshot field name is collected with the literal `KEIKO_` prefix still attached
  // (`keikoConfigEnvFields`), so normalization fuses the prefix into the rest of the name —
  // `KEIKO_LOCAL_KNOWLEDGE_KEY` normalizes to `keikolocalknowledgekey`, which can never equal the
  // denylist's `key` entry. Safety then falls entirely to the VALUE-shape heuristics, which do not
  // catch a hex-only secret (lowercase + digits only never sees the uppercase class the
  // high-entropy check requires) or any other operator-chosen credential shape those heuristics
  // were never designed to enumerate. `keikoConfigEnvFields` must refuse to even collect a
  // credential-shaped KEY/SECRET/TOKEN/CREDENTIAL(S) env name, independent of its value.
  it("never embeds a KEIKO_*_KEY/_SECRET/_TOKEN/_CREDENTIALS env value in config-snapshot, even one the value-shape redactor cannot catch", async () => {
    writeFileSync(join(stateDir, "logs", "server.log"), "");

    const hexOnlyEnvValue = "a1b2c3d4e5f6".repeat(5).slice(0, 64);
    const secretEnv = {
      ...AUDIT_ENV,
      KEIKO_LOCAL_KNOWLEDGE_KEY: hexOnlyEnvValue,
      KEIKO_PROVIDER_TOKEN_GITHUB: hexOnlyEnvValue,
      KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: hexOnlyEnvValue,
      KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: hexOnlyEnvValue,
    };

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, secretEnv, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: seededEvidenceStore([]),
    });

    expect(code).toBe(0);
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const written = readFileSync(outPath, "utf8");
    // The raw secret value must never reach the bundle, and none of the credential-shaped field
    // names may even be attached (excluded entirely, not merely redacted-to-a-marker).
    expect(written).not.toContain(hexOnlyEnvValue);
    const [, configSnapshotLine] = written.trimEnd().split("\n");
    const configSnapshot = JSON.parse(configSnapshotLine ?? "{}") as {
      fields: Record<string, unknown>;
    };
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_LOCAL_KNOWLEDGE_KEY");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_PROVIDER_TOKEN_GITHUB");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET");
    expect(configSnapshot.fields).not.toHaveProperty("KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY");
  });

  it("records a log file that vanishes between discovery and read as skipped, not aborted", async () => {
    // `discoverServerLogFiles` only `statSync`s each name (which succeeds on a directory too), so
    // a directory sitting where `server.log` belongs passes discovery — the read step afterward
    // (`readFileSync`) is what actually fails, with EISDIR. This is the same "vanished between two
    // fs calls" shape the sink's own rotation/retention pruning produces, exercised deterministically
    // instead of via a real race.
    mkdirSync(join(stateDir, "logs", "server.log"), { recursive: true });

    const c = makeIo();
    const code = await runSupportCli(["export", "--state-dir", stateDir], c.io, AUDIT_ENV, {
      cwd: outDir,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: createInMemoryEvidenceStore(),
    });

    expect(code).toBe(0);
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.sourceLogFiles).toEqual([]);
    expect(manifest.skippedLogFiles).toEqual([{ name: "server.log", errorKind: "EISDIR" }]);
  });

  it("defaults stateDirSource to 'default' when neither --state-dir nor KEIKO_STATE_DIR is set", async () => {
    const cwdWithDefaultState = mkdtempSync(join(tmpdir(), "keiko-support-cli-default-"));
    mkdirSync(join(cwdWithDefaultState, ".keiko", "logs"), { recursive: true });

    const c = makeIo();
    const code = await runSupportCli(["export"], c.io, AUDIT_ENV, {
      cwd: cwdWithDefaultState,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      auditDeps: healthyAuditDeps(),
      evidenceStore: createInMemoryEvidenceStore(),
    });

    expect(code).toBe(0);
    const outPath = join(cwdWithDefaultState, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.stateDirSource).toBe("default");
    expect(manifest.evidenceIndexCount).toBe(0);

    rmSync(cwdWithDefaultState, { recursive: true, force: true });
  });

  it("drops the oldest log files under a tiny --max-bytes and records them as truncated", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-18T00:00:00.000Z",
      category: "http",
      op: "old",
    });
    const currentLine = JSON.stringify({
      ts: "2026-08-20T00:00:00.000Z",
      category: "http",
      op: "new",
    });
    writeFileSync(join(stateDir, "logs", "server-2026-08-18.log"), `${rotatedLine}\n`.repeat(50));
    writeFileSync(join(stateDir, "logs", "server.log"), `${currentLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--out",
        join(outDir, "tiny.jsonl"),
        "--max-bytes",
        "100",
      ],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "tiny.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.truncatedLogFiles).toEqual(["server-2026-08-18.log"]);
    expect(manifest.sourceLogFiles).toEqual(["server.log"]);
  });

  // Regression for #2902 PR review, follow-up finding: a single oversized CURRENT server.log was
  // exported in full (never dropped, per the rule above), exceeding --max-bytes outright, and read
  // via a whole-file readFileSync. Combines both effects of a tiny budget in one export: an older
  // rotated file is dropped whole (still recorded in truncatedLogFiles, per (d) above) AND the
  // current file alone still exceeds what's left of the budget, so only its tail is exported.
  it("drops older files first and ALSO tail-truncates the current file when both are needed to fit --max-bytes", async () => {
    const rotatedLine = JSON.stringify({
      ts: "2026-08-18T00:00:00.000Z",
      category: "http",
      op: "old",
    });
    writeFileSync(join(stateDir, "logs", "server-2026-08-18.log"), `${rotatedLine}\n`.repeat(50));
    // 20 fixed-width lines (11 bytes + "\n" = 12 bytes each, 240 bytes total) so the tail cut lands
    // at a byte offset that can be reasoned about exactly, the same fixture shape
    // support-export.test.ts uses for the same scenario.
    const currentLine = (i: number): string => `{"seq":${String(i).padStart(3, "0")}}`;
    const currentText = `${Array.from({ length: 20 }, (_, i) => currentLine(i)).join("\n")}\n`;
    writeFileSync(join(stateDir, "logs", CURRENT_LOG_FILE_NAME), currentText);

    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "tail.jsonl"), "--max-bytes", "50"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const written = readFileSync(join(outDir, "tail.jsonl"), "utf8");
    // Skip the always-attached config-snapshot $section line (Wave 6) between the manifest and
    // the raw log content.
    const [manifestLine, , ...logLines] = written.trimEnd().split("\n");
    const manifest: Record<string, unknown> = JSON.parse(manifestLine ?? "{}") as Record<
      string,
      unknown
    >;

    expect(manifest.truncatedLogFiles).toEqual(["server-2026-08-18.log"]);
    expect(manifest.sourceLogFiles).toEqual([CURRENT_LOG_FILE_NAME]);
    expect(manifest.currentFileTailTruncated).toEqual({
      name: CURRENT_LOG_FILE_NAME,
      droppedBytes: 192,
    });
    // The tail strategy brought the export back within budget, so budgetExceeded must be false.
    expect(manifest.budgetExceeded).toBe(false);
    // Every surviving line is one of the file's own complete lines — the newest ones, in order.
    expect(logLines).toEqual([currentLine(16), currentLine(17), currentLine(18), currentLine(19)]);
  });

  it("fails closed with exit 1 when the local-state audit cannot run, and writes no bundle", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "should-not-exist.jsonl")],
      c.io,
      {},
      { evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("keiko support export");
    expect(existsSync(join(outDir, "should-not-exist.jsonl"))).toBe(false);
  });

  it("sets stateDirSource to 'env-override' from a non-empty KEIKO_STATE_DIR alone, without --state-dir", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--out", join(outDir, "env-override.jsonl")],
      c.io,
      { ...AUDIT_ENV, KEIKO_STATE_DIR: stateDir },
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "env-override.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.stateDirSource).toBe("env-override");
  });

  // AuditLoadError (thrown once the auditor was actually located and tried) is a distinct branch
  // from the plain Error thrown when KEIKO_LOCAL_STATE_AUDITOR is unset at all (tested above) —
  // both must fail closed with exit 1 and a clear message, never a raw stack.
  it("fails closed with exit 1 when the located auditor module is malformed (AuditLoadError)", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "audit-load-error.jsonl")],
      c.io,
      AUDIT_ENV,
      {
        auditDeps: { loadAuditor: () => Promise.resolve({} as never) },
        evidenceStore: createInMemoryEvidenceStore(),
      },
    );

    expect(code).toBe(1);
    expect(c.err()).toContain("local-state audit could not produce a result");
    expect(existsSync(join(outDir, "audit-load-error.jsonl"))).toBe(false);
  });

  it("reports evidenceIndexCount 0 (never throwing) when the evidence directory does not exist, using the real evidence package", async () => {
    const c = makeIo();
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", join(outDir, "real-evidence.jsonl")],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(join(outDir, "real-evidence.jsonl"), "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.evidenceIndexCount).toBe(0);
  });

  // Regression: `writeFileSync` was unguarded, so a bad `--out` path (here, one whose parent
  // directory does not exist) threw the raw fs error straight out of the CLI — no exit-1 message,
  // no handling, and (per AGENTS.md §7) an fs error's message quotes the absolute path it tried to
  // write. `readAnalyzeSource` already follows this discipline for the read side; the write side
  // must match it.
  it("exits 1 with a content-free message, never the raw fs error, when --out's parent directory does not exist", async () => {
    const c = makeIo();
    const badOutPath = join(outDir, "missing-parent", "bundle.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", badOutPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(1);
    // The fs error's `code` (ENOENT here — the parent directory does not exist), never its
    // `constructor.name` (always just "Error" for a Node fs error, so it told an operator nothing).
    expect(c.err()).toContain("keiko support export: could not write the bundle: ENOENT");
    expect(c.err()).not.toContain(badOutPath);
    expect(existsSync(badOutPath)).toBe(false);
  });

  // Wave 4a (epic #3233 §6.2/§8): none of the three stores has ever been created under this
  // state dir, so the export must still succeed — each store is named in storesUnavailable with
  // reasonKind "missing", and none of their (nonexistent) db files or directories are created as
  // a side effect of merely running an export.
  it("reports all three stores as missing, never creating them, when none exist under --state-dir", async () => {
    const c = makeIo();
    const outPath = join(outDir, "no-stores.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      {
        auditDeps: healthyAuditDeps(),
        evidenceStore: createInMemoryEvidenceStore(),
      },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storeFingerprints).toEqual([]);
    expect(manifest.storesUnavailable).toEqual(
      expect.arrayContaining([
        { store: "ui", reasonKind: "missing" },
        { store: "local-knowledge", reasonKind: "missing" },
        { store: "memory-vault", reasonKind: "missing" },
      ]),
    );
    expect(existsSync(join(stateDir, "ui"))).toBe(false);
    expect(existsSync(join(stateDir, "memory"))).toBe(false);
    expect(existsSync(join(stateDir, "local-knowledge"))).toBe(false);
  });

  // Wave 4a: a store whose db path exists but cannot be opened as a database (here, a directory
  // sitting where the db file is expected — not classified as SQLite corruption, so the store's
  // own quarantine-and-recover path never kicks in) reports reasonKind "open-failed", and the
  // export still succeeds for the other two stores.
  it("reports open-failed (never throwing) when a store's db path exists but cannot be opened", async () => {
    mkdirSync(join(stateDir, "ui", UI_DB_FILENAME), { recursive: true });

    const c = makeIo();
    const outPath = join(outDir, "open-failed.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storesUnavailable).toEqual(
      expect.arrayContaining([{ store: "ui", reasonKind: "open-failed" }]),
    );
    expect(manifest.storeFingerprints).toEqual([]);
  });

  // RED (before fix): computing the ui store's fingerprint called `openNodeUiDatabase`, the
  // mutating production open path — which unconditionally runs `sqlRecoverInterruptedClientTurns`,
  // flipping any `client_turn_state = 'pending'` row to `'failed'`. That is exactly the evidence an
  // operator running `keiko support export` to diagnose a stuck chat turn needs preserved. This
  // goes through the real, on-disk ui store (no mock of the open path) so a regression in which
  // fingerprint collection touches the production open path again cannot hide behind a fixture.
  it("does not flip a pending client turn to failed as a side effect of computing the ui store fingerprint", async () => {
    const uiDataDir = join(stateDir, "ui");
    mkdirSync(uiDataDir, { recursive: true });
    const dbPath = join(uiDataDir, UI_DB_FILENAME);
    const projectDir = mkdtempSync(join(stateDir, "pending-turn-project-"));
    const store = createNodeUiStore(dbPath);
    store.createProject(projectDir);
    const chat = store.createChat(projectDir, "Chat", "example-chat-model");
    const admission = store.admitChatTurn("turn-stuck-in-flight", {
      chatId: chat.id,
      role: "user",
      content: "message stuck in flight",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("expected canonical admission");
    store.close();

    const c = makeIo();
    const outPath = join(outDir, "pending-turn.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );
    expect(code).toBe(0);

    const inspector = new DatabaseSync(dbPath, { readOnly: true });
    const stored = inspector
      .prepare("SELECT client_turn_state FROM chat_messages WHERE id = ?")
      .get(admission.userMessage.id) as { client_turn_state: string };
    inspector.close();
    expect(stored.client_turn_state).toBe("pending");

    const manifest: Record<string, unknown> = JSON.parse(
      readFileSync(outPath, "utf8").split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.storesUnavailable).toEqual(
      expect.not.arrayContaining([{ store: "ui", reasonKind: "open-failed" }]),
    );
  });

  // Finding 1 (minor): store fingerprint collection runs a synchronous full-DB quick_check plus
  // per-table row counts with nothing printed while it runs, so a slow run against a large
  // local-knowledge index looks hung to the operator. A stderr progress line before the call
  // fixes that. RED (before fix): no such line was ever written to stderr.
  it("prints a stderr progress line before computing store fingerprints", async () => {
    const c = makeIo();
    const outPath = join(outDir, "progress-line.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    expect(c.err()).toContain(
      "keiko support export: computing store fingerprints (may take a while on a large local-knowledge index)...",
    );
  });

  // Wave 6, design doc §6.3: ui.log carries the UI/BFF process's raw, unredacted stdout+stderr, so
  // it is excluded by default — RED before this wave existed (there was no ui.log logic at all).
  function bundleLines(outPath: string): readonly Record<string, unknown>[] {
    return readFileSync(outPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("excludes ui.log by default: no ui-log section, and sectionsExcluded names it", async () => {
    writeFileSync(join(stateDir, "ui.log"), "TypeError: boom at /Users/jsmith/app\n");
    const c = makeIo();
    const outPath = join(outDir, "default-no-ui-log.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    expect(lines.some((line) => line.$section === "ui-log")).toBe(false);
    expect(lines[0]?.sectionsExcluded).toEqual(["ui-log"]);
  });

  // THE key regression-shaped assertion: one flag alone is NOT sufficient consent. Without this
  // gate, an operator (or a script) passing only --include-ui-log would leak unredacted free text.
  it("still excludes ui.log with ONLY --include-ui-log — the confirmation flag is not optional", async () => {
    writeFileSync(join(stateDir, "ui.log"), "TypeError: boom at /Users/jsmith/app\n");
    const c = makeIo();
    const outPath = join(outDir, "half-consent.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath, "--include-ui-log"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    expect(lines.some((line) => line.$section === "ui-log")).toBe(false);
    expect(lines[0]?.sectionsExcluded).toEqual(["ui-log"]);
  });

  it("attaches ui.log verbatim, and clears sectionsExcluded, when BOTH flags are passed", async () => {
    const uiLogContent = "TypeError: boom at /Users/jsmith/app\n";
    writeFileSync(join(stateDir, "ui.log"), uiLogContent);
    const c = makeIo();
    const outPath = join(outDir, "full-consent.jsonl");
    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--out",
        outPath,
        "--include-ui-log",
        "--i-understand-this-is-unredacted",
      ],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    expect(lines.find((line) => line.$section === "ui-log")).toEqual({
      $section: "ui-log",
      content: uiLogContent,
    });
    expect(lines[0]?.sectionsExcluded).toEqual([]);
  });

  it("attaches a full evidence manifest per --include-evidence runId, beyond the index count", async () => {
    const c = makeIo();
    const outPath = join(outDir, "with-evidence.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath, "--include-evidence", "run-a"],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: seededEvidenceStore(["run-a", "run-b"]) },
    );

    expect(code).toBe(0);
    const lines = bundleLines(outPath);
    const evidenceSection = lines.find((line) => line.$section === "evidence-manifest");
    expect(evidenceSection?.runId).toBe("run-a");
    expect(evidenceSection?.manifest).toEqual(minimalEvidenceManifest("run-a"));
  });

  // Wave 6, design doc §6.2 closing addendum: a cheap integrity story for an artifact crossing a
  // customer-machine-to-agent trust boundary. RED before this wave: no .sha256 sidecar existed.
  it("writes a <output>.sha256 sidecar matching an independently-computed digest of the bundle bytes", async () => {
    const c = makeIo();
    const outPath = join(outDir, "digest.jsonl");
    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", outPath],
      c.io,
      AUDIT_ENV,
      { auditDeps: healthyAuditDeps(), evidenceStore: createInMemoryEvidenceStore() },
    );

    expect(code).toBe(0);
    const sidecarPath = `${outPath}.sha256`;
    expect(existsSync(sidecarPath)).toBe(true);
    const expectedDigest = createHash("sha256").update(readFileSync(outPath)).digest("hex");
    expect(readFileSync(sidecarPath, "utf8").trim()).toBe(expectedDigest);
  });
});

describe("runSupportCli analyze", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-support-cli-analyze-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-detects a raw log and emits the minimal LogTimeline JSON for one correlation id", async () => {
    const filePath = join(dir, "server.log");
    const l1 = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
      pid: 1,
      instanceId: "aaaaaaaa",
      seq: 1,
    });
    writeFileSync(filePath, `${l1}\nnot-json\n`);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--json"],
      c.io,
    );

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    expect(parsed.correlationId).toBe("req-1");
    expect(parsed.malformedLineCount).toBe(1);
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.frames).toBeUndefined();
    expect(parsed.clusters).toBeUndefined();
    expect(parsed.warnings).toBeUndefined();
    expect(parsed.gatewayScript).toBeUndefined();
  });

  it("emits all timelines when --correlation-id is absent", async () => {
    const filePath = join(dir, "server.log");
    const l1 = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
    });
    const l2 = JSON.stringify({
      ts: "2026-08-21T00:00:01.000Z",
      category: "http",
      op: "b",
      correlationId: "req-2",
    });
    writeFileSync(filePath, `${l1}\n${l2}\n`);

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--json"], c.io);

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    expect((parsed.timelines as { correlationId: string }[]).map((t) => t.correlationId)).toEqual([
      "req-1",
      "req-2",
    ]);
    // The whole-file `processes`/`legacyLineCount`/`warnings` fields (ADR-0173 D9/D10) travel
    // through the CLI's --json output alongside `timelines` — none of these lines has full v2
    // identity, so both are legacy and the analyzer says so.
    expect(parsed.processes).toEqual([]);
    expect(parsed.legacyLineCount).toBe(2);
    expect(parsed.warnings).toEqual([
      "2 line(s) predate the v2 envelope and were ordered by file position",
    ]);
  });

  it("auto-detects a bundle (manifest first line) and analyzes only the log content", async () => {
    const filePath = join(dir, "bundle.jsonl");
    const manifestLine = JSON.stringify({ $section: "manifest", schemaVersion: 2 });
    const logLine = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "http",
      op: "a",
      correlationId: "req-1",
    });
    writeFileSync(filePath, `${manifestLine}\n${logLine}\n`);

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--json"], c.io);

    expect(code).toBe(0);
    const parsed: Record<string, unknown> = JSON.parse(c.out()) as Record<string, unknown>;
    expect(parsed.malformedLineCount).toBe(0);
  });

  it("exits 1 with a clear message for a correlation id that is not present", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id", "missing"], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("no lines found for correlation id: missing");
  });

  it("renders human-readable text by default", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath], c.io);

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
  });

  it("renders a single timeline as human-readable text when --correlation-id is given without --json", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id", "req-1"], c.io);

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
    expect(c.out()).not.toContain("{");
  });

  it("resolves a relative FILE argument against the launch cwd", async () => {
    writeFileSync(
      join(dir, "server.log"),
      `${JSON.stringify({ ts: "2026-08-21T00:00:00.000Z", category: "http", op: "a", correlationId: "req-1" })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(["analyze", "server.log"], c.io, {}, { cwd: dir });

    expect(code).toBe(0);
    expect(c.out()).toContain("correlationId=req-1");
  });

  it("exits 2 when --correlation-id is missing its value", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(filePath, "");

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--correlation-id"], c.io);

    expect(code).toBe(2);
    expect(c.err()).toContain("--correlation-id is missing its value");
  });

  it("exits 1 without leaking the underlying fs error message for an unreadable file", async () => {
    const c = makeIo();
    const code = await runSupportCli(["analyze", join(dir, "does-not-exist.jsonl")], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("could not read");
    expect(c.err()).not.toContain("ENOENT:");
  });

  // Wave 6 (epic #3233 closeout, disclosed gap #1): --clusters/--seed/--emit-fixture were
  // implemented and exported from support-analyze.ts but never wired into the CLI dispatch path —
  // these fail before that wiring and pass after.
  function writeGatewayLog(filePath: string): void {
    const line = JSON.stringify({
      ts: "2026-08-21T00:00:00.000Z",
      category: "gateway",
      op: "gateway.chat.completed",
      correlationId: "req-1",
      durationMs: 120,
      modelId: "gpt-x",
      finishReason: "stop",
    });
    const other = JSON.stringify({
      ts: "2026-08-21T00:00:01.000Z",
      category: "http",
      op: "request",
      correlationId: "req-2",
      errorKind: "HTTP_TIMEOUT",
    });
    writeFileSync(filePath, `${line}\n${other}\n`);
  }

  it("prints whole-file clusters via --clusters, independent of --correlation-id", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const jsonRun = makeIo();
    const jsonCode = await runSupportCli(["analyze", filePath, "--clusters", "--json"], jsonRun.io);
    expect(jsonCode).toBe(0);
    const clusters = JSON.parse(jsonRun.out()) as { readonly op: string }[];
    expect(clusters.map((cluster) => cluster.op).sort()).toEqual([
      "gateway.chat.completed",
      "request",
    ]);

    const humanRun = makeIo();
    const humanCode = await runSupportCli(["analyze", filePath, "--clusters"], humanRun.io);
    expect(humanCode).toBe(0);
    expect(humanRun.out()).toContain("Clusters: 2");
    expect(humanRun.out()).toContain("gateway.chat.completed");
  });

  it("prints a ReproductionSeed via --seed", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const jsonRun = makeIo();
    const jsonCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed", "--json"],
      jsonRun.io,
    );
    expect(jsonCode).toBe(0);
    const seed = JSON.parse(jsonRun.out()) as {
      readonly correlationId: string;
      readonly gatewayScript?: { readonly attempts: readonly unknown[] };
      readonly warnings: readonly string[];
    };
    expect(seed.correlationId).toBe("req-1");
    expect(seed.gatewayScript?.attempts).toHaveLength(1);
    expect(seed.warnings.length).toBeGreaterThan(0);

    const humanRun = makeIo();
    const humanCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--seed"],
      humanRun.io,
    );
    expect(humanCode).toBe(0);
    expect(humanRun.out()).toContain("correlationId=req-1");
    expect(humanRun.out()).toContain("gatewayScript:");
  });

  it("exits 1 for --seed when the correlation id has no timeline", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "missing", "--seed"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("no lines found for correlation id: missing");
  });

  it("writes a fixture via --emit-fixture, fail-closed against an existing file", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "fixtures", "gateway.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toContain(`Wrote fixture to ${fixturePath}`);
    const contents = readFileSync(fixturePath, "utf8");
    expect(contents).toContain("GatewayReplayScriptEntry");
    expect(contents).toContain("gatewayReplayScript");

    // Fail-closed: a second run against the same path must refuse to overwrite it.
    const rerun = makeIo();
    const rerunCode = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", fixturePath],
      rerun.io,
    );
    expect(rerunCode).toBe(1);
    expect(rerun.err()).toContain("refusing to overwrite existing file");
    // The original fixture content must survive the refused overwrite attempt.
    expect(readFileSync(fixturePath, "utf8")).toBe(contents);
  });

  it("combines --seed and --emit-fixture into one JSON object under --json", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);
    const fixturePath = join(dir, "gateway.fixture.ts");

    const c = makeIo();
    const code = await runSupportCli(
      [
        "analyze",
        filePath,
        "--correlation-id",
        "req-1",
        "--seed",
        "--emit-fixture",
        fixturePath,
        "--json",
      ],
      c.io,
    );
    expect(code).toBe(0);
    // Exactly one JSON document on stdout (the seed with `fixturePath` folded in), never a
    // separate plain-text "wrote fixture" line alongside it — --json stays a single JSON object.
    const seed = JSON.parse(c.out()) as {
      readonly fixturePath: string;
      readonly correlationId: string;
    };
    expect(seed.fixturePath).toBe(fixturePath);
    expect(seed.correlationId).toBe("req-1");
  });

  it("exits 1 with a clear message when --emit-fixture has no gateway script to write", async () => {
    const filePath = join(dir, "server.log");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        ts: "2026-08-21T00:00:00.000Z",
        category: "http",
        op: "request",
        correlationId: "req-1",
      })}\n`,
    );

    const c = makeIo();
    const code = await runSupportCli(
      ["analyze", filePath, "--correlation-id", "req-1", "--emit-fixture", join(dir, "out.ts")],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("no gateway replay script to write for correlationId=req-1");
  });

  it("exits 2 when --seed is given without --correlation-id", async () => {
    const filePath = join(dir, "server.log");
    writeGatewayLog(filePath);

    const c = makeIo();
    const code = await runSupportCli(["analyze", filePath, "--seed"], c.io);
    expect(code).toBe(2);
  });
});

describe("runSupportCli usage and help", () => {
  it("prints usage and exits 0 for --help", async () => {
    const c = makeIo();
    expect(await runSupportCli(["--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support export");
  });

  // Regression: the help text claimed timelines are "ordered by (pid, instanceId, seq)", but
  // support-analyze.ts ranks process lifetimes by file position (never by pid value) and orders
  // each lifetime's own lines by seq — an operator reading the old text would draw the wrong
  // conclusion about a reconstructed timeline.
  it("describes the analyzer's real ordering: seq within a lifetime, file position across lifetimes", async () => {
    const c = makeIo();
    await runSupportCli(["--help"], c.io);
    expect(c.out()).toContain("Each process lifetime is ordered by");
    expect(c.out()).toContain("seq");
    expect(c.out()).not.toContain("(pid, instanceId, seq)");
  });

  it("prints usage and exits 0 for 'export --help', without requiring any export flags", async () => {
    const c = makeIo();
    expect(await runSupportCli(["export", "--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support export");
  });

  it("prints usage and exits 0 for 'analyze --help', without requiring a FILE argument", async () => {
    const c = makeIo();
    expect(await runSupportCli(["analyze", "--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support analyze");
  });

  it("exits 2 for an unknown subcommand", async () => {
    const c = makeIo();
    expect(await runSupportCli(["bogus"], c.io)).toBe(2);
    expect(c.err()).toContain("unknown subcommand");
  });

  it("exits 2 when analyze is missing its FILE argument", async () => {
    const c = makeIo();
    expect(await runSupportCli(["analyze"], c.io)).toBe(2);
  });
});
