import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInMemoryEvidenceStore,
  type EvidenceManifest,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { SERVER_LOG_SCHEMA_VERSION } from "@oscharko-dev/keiko-server";
import type { AuditResult } from "./audit.js";
import type { CliIo } from "./runner.js";
import { parseSupportArgs, runSupportCli, type SupportCliDeps } from "./support.js";

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

  it("parses export flags, defaulting absent ones to undefined", () => {
    expect(parseSupportArgs(["export"])).toEqual({
      kind: "export",
      value: { out: undefined, stateDir: undefined, maxBytes: undefined },
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
      ]),
    ).toEqual({
      kind: "export",
      value: { out: "/tmp/x.jsonl", stateDir: "/tmp/.keiko", maxBytes: 100 },
    });
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
      value: { file: "bundle.jsonl", correlationId: "req-1", json: true },
    });
    expect(parseSupportArgs(["analyze", "bundle.jsonl"])).toEqual({
      kind: "analyze",
      value: { file: "bundle.jsonl", correlationId: undefined, json: false },
    });
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
    expect(c.out()).toContain("Wrote 3 lines to");
    const outPath = join(outDir, "keiko-support-2026-08-21T12-00-00.000Z.jsonl");
    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, "utf8");
    const [manifestLine, ...logLines] = written.trimEnd().split("\n");
    expect(logLines).toEqual([rotatedLine, currentLine]);
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
    expect(manifest.sectionsExcluded).toEqual([]);
    expect(manifest.evidenceIndexCount).toBe(2);
    // The manifest's auditSummary must carry the audit result MINUS the raw stateDir path (which
    // embeds the operator's OS username on a real machine): stateDirSource above already says
    // "default vs. override" without the absolute path.
    expect(manifest.auditSummary).toEqual({ ok: HEALTHY_AUDIT.ok, classes: HEALTHY_AUDIT.classes });
    expect(written).not.toContain(HEALTHY_AUDIT.stateDir);
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

  it("exits 1 without leaking the underlying fs error message for an unreadable file", async () => {
    const c = makeIo();
    const code = await runSupportCli(["analyze", join(dir, "does-not-exist.jsonl")], c.io);

    expect(code).toBe(1);
    expect(c.err()).toContain("could not read");
    expect(c.err()).not.toContain("ENOENT:");
  });
});

describe("runSupportCli usage and help", () => {
  it("prints usage and exits 0 for --help", async () => {
    const c = makeIo();
    expect(await runSupportCli(["--help"], c.io)).toBe(0);
    expect(c.out()).toContain("keiko support export");
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
