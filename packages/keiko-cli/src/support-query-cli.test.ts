import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { closeFileServerLogSinks, recordUserReportedIncident } from "@oscharko-dev/keiko-server";
import type { AuditResult } from "./audit.js";
import type { CliIo } from "./runner.js";
import { loadServer } from "./lazy-modules.js";
import { parseSupportArgs, runSupportCli, type SupportCliDeps } from "./support.js";
import { analyzeLogText } from "./support-analyze.js";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "./test-support/activity-log-segments.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const roots: string[] = [];
const T0 = Date.UTC(2026, 8, 18, 7, 0, 0);
const ROOT_ID = "corr-cli-root-000001";
const CHILD_ID = "corr-cli-child-00001";
const OTHER_ID = "corr-cli-other-00001";

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(REAL_TMPDIR, prefix));
  roots.push(root);
  return root;
}

function makeIo(): { readonly io: CliIo; readonly out: () => string; readonly err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (text): void => void out.push(text), err: (text): void => void err.push(text) },
    out: (): string => out.join(""),
    err: (): string => err.join(""),
  };
}

// Returns the persisted source lines, in order, so export assertions compare bytes, not shapes.
function stateWithHistory(): { readonly stateDir: string; readonly lines: readonly string[] } {
  const stateDir = makeRoot("keiko-query-cli-state-");
  const a = fixtureProcess(7101, "0badc0de");
  const lines = [
    fixtureLine(a, T0, { op: "client.diagnostic", correlationId: ROOT_ID }),
    fixtureLine(a, T0 + 5, {
      op: "client.diagnostic",
      correlationId: CHILD_ID,
      parentCorrelationId: ROOT_ID,
    }),
    fixtureLine(a, T0 + 7, { op: "client.diagnostic", correlationId: OTHER_ID }),
  ];
  writeFixtureSegment(stateDir, segmentIdentity(a, T0, 1), lines);
  return { stateDir, lines };
}

const HEALTHY_AUDIT: AuditResult = {
  ok: true,
  stateDir: "/irrelevant/.keiko",
  classes: [{ id: "creds", title: "Credential references", status: "pass", findings: [] }],
};

function exportDeps(cwd: string): SupportCliDeps {
  return {
    cwd,
    now: () => new Date("2026-09-18T12:00:00.000Z"),
    auditDeps: {
      loadAuditor: () => Promise.resolve({ auditLocalState: () => HEALTHY_AUDIT }),
    },
    evidenceStore: createInMemoryEvidenceStore(),
  };
}

const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

// The support commands reach keiko-server through `loadServer()`, the whole server module graph
// imported lazily. That first import is the slowest step of this suite and, under coverage or on a
// slow filesystem, can alone exceed the per-test budget of whichever test runs first. Pay it once
// here, bounded on the hook as in portable-macos-activation.test.ts, so a real hang still fails.
beforeAll(async () => {
  await loadServer();
}, 60_000);
describe("keiko support query/manifest argument parsing (#3531)", () => {
  it.each([
    [["query"], "needs a selector"],
    [["query", "--correlation-id", "x"], "--correlation-id is not valid"],
    [["query", "--correlation-id"], "--correlation-id is missing its value"],
    [["query", "--correlation-id", ROOT_ID, "--op", "client.diagnostic"], "cannot be combined"],
    [["query", "--correlation-id", ROOT_ID, "--incident", "0".repeat(32)], "are exclusive"],
    [["query", "--error-kind", "not-a-kind"], "--error-kind is not valid"],
    [["query", "--op", "not.registered"], "--op is not valid"],
    [["query", "--failure-class", "not-a-class"], "--failure-class is not valid"],
    [["query", "--from", "yesterday"], "--from must be an ISO 8601 timestamp"],
    [
      ["query", "--from", "2026-09-18T10:00:00Z", "--to", "2026-09-18T09:00:00Z"],
      "--from must not be after --to",
    ],
    [["query", "--correlation-id", ROOT_ID, "--max-bytes", "0"], "--max-bytes must be an integer"],
    [["manifest", "compact"], "unknown manifest action"],
    [["export", "--op", "client.diagnostic"], "export selects by"],
  ])("rejects %j with a usage error", (args, message) => {
    const parsed = parseSupportArgs(args);
    expect(parsed.kind).toBe("usage");
    expect(parsed.kind === "usage" ? parsed.message : "").toContain(message);
  });

  it("prints the query usage for query --help and manifest without an action", async () => {
    for (const args of [["query", "--help"], ["manifest"]]) {
      const { io, out } = makeIo();
      await expect(runSupportCli(args, io, {})).resolves.toBe(0);
      expect(out()).toContain("keiko support query");
    }
  });
});

describe("keiko support query (#3531)", () => {
  it("prints the versioned machine result with each event's persisted record", async () => {
    const { stateDir, lines } = stateWithHistory();
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly kind: string;
      readonly schemaVersion: number;
      readonly diagnosticSufficiency: { readonly status: string };
      readonly events: readonly { readonly role: string; readonly record: unknown }[];
    };
    expect(result).toMatchObject({ kind: "keiko.support.query", schemaVersion: 1 });
    expect(result.events.map((event) => event.record)).toEqual(
      lines.slice(0, 2).map((line) => JSON.parse(line) as unknown),
    );
    expect(result.events.every((event) => event.role === "closure")).toBe(true);
    expect(out()).not.toContain(stateDir);
  });

  it("derives the human report from the same result", async () => {
    const { stateDir } = stateWithHistory();
    const { io, out } = makeIo();

    await expect(
      runSupportCli(["query", "--state-dir", stateDir, "--correlation-id", ROOT_ID], io, {}),
    ).resolves.toBe(0);
    expect(out()).toContain("Query: correlation (keiko.support.query v1)");
    expect(out()).toContain("Closure: 2 correlation(s), 0 without retained events");
  });

  it("resolves a user-reported incident through its descriptor window and correlation", async () => {
    const stateDir = makeRoot("keiko-query-cli-incident-");
    const reportCorrelation = "corr-cli-report-0001";
    const created = recordUserReportedIncident(stateDir, { correlationId: reportCorrelation });
    if (created.status === "rejected") throw new Error(`incident rejected: ${created.reason}`);
    const { io, out } = makeIo();

    const code = await runSupportCli(
      ["query", "--state-dir", stateDir, "--incident", created.record.incidentId, "--json"],
      io,
      {},
    );

    expect(code).toBe(0);
    const result = JSON.parse(out()) as {
      readonly query: { readonly class: string };
      readonly diagnosticSufficiency: { readonly reasons: readonly string[] };
      readonly events: readonly { readonly record: { readonly op: string } }[];
    };
    expect(result.query.class).toBe("incident");
    expect(result.diagnosticSufficiency.reasons).not.toContain("evidence-not-retained");
    expect(result.events.map((event) => event.record.op)).toContain("support.incident.created");
  });

  it("answers an unknown incident with insufficient evidence-not-retained", async () => {
    const { stateDir } = stateWithHistory();
    const { io, out } = makeIo();

    await expect(
      runSupportCli(
        ["query", "--state-dir", stateDir, "--incident", "f".repeat(32), "--json"],
        io,
        {},
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      diagnosticSufficiency: { status: "insufficient", reasons: ["evidence-not-retained"] },
      events: [],
    });
  });
});

describe("keiko support manifest (#3531)", () => {
  it("rebuilds every manifest and verifies them, reporting a missing one", async () => {
    const { stateDir } = stateWithHistory();
    const rebuild = makeIo();
    await expect(
      runSupportCli(["manifest", "rebuild", "--state-dir", stateDir, "--json"], rebuild.io, {}),
    ).resolves.toBe(0);
    expect(JSON.parse(rebuild.out())).toMatchObject({
      kind: "keiko.support.manifest",
      schemaVersion: 1,
      trigger: "rebuild",
      segmentCount: 1,
      builtCount: 1,
    });

    const verified = makeIo();
    await expect(
      runSupportCli(["manifest", "verify", "--state-dir", stateDir], verified.io, {}),
    ).resolves.toBe(0);
    expect(verified.out()).toContain("1 verified, 0 different");

    // A segment sealed after the rebuild (the command's own evidence) is "not yet built", never an
    // error; a stored manifest that no longer matches its segment is.
    const directory = join(stateDir, "activity-log-manifests");
    const [stored = ""] = readdirSync(directory);
    chmodSync(join(directory, stored), 0o600);
    writeFileSync(join(directory, stored), "{}\n");
    const corrupt = makeIo();
    await expect(
      runSupportCli(["manifest", "verify", "--state-dir", stateDir, "--json"], corrupt.io, {}),
    ).resolves.toBe(1);
    expect(JSON.parse(corrupt.out())).toMatchObject({ verifiedCount: 0, mismatchCount: 1 });
  });
});

describe("keiko support export with a selector (#3531)", () => {
  it("exports only the causal closure, byte for byte, with a versioned selection verdict", async () => {
    const { stateDir, lines } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const outPath = join(outDir, "selective.jsonl");
    const { io } = makeIo();

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--correlation-id", ROOT_ID, "--out", outPath],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(0);
    const bundle = readFileSync(outPath, "utf8");
    const bundleLines = bundle.trimEnd().split("\n");
    const manifest = JSON.parse(bundleLines[0] ?? "{}") as {
      readonly sourceLogFileLines: readonly { readonly lineCount: number }[];
      readonly selection: {
        readonly kind: string;
        readonly schemaVersion: number;
        readonly query: {
          readonly diagnosticSufficiency: { readonly status: string };
          readonly events?: unknown;
        };
      };
    };
    const content = bundleLines.filter((line) => !line.startsWith('{"$section"'));
    expect(content).toEqual(lines.slice(0, 2));
    expect(bundle).not.toContain(OTHER_ID);
    expect(manifest.sourceLogFileLines).toEqual([
      expect.objectContaining({ lineCount: 2, terminalFragment: false }),
    ]);
    expect(manifest.selection).toMatchObject({
      kind: "keiko.support.export-selection",
      schemaVersion: 1,
    });
    expect(manifest.selection.query.events).toBeUndefined();
    const analysis = analyzeLogText(bundle);
    expect(analysis.sourceKind).toBe("bundle");
    expect(analysis.evidence).toMatchObject({
      classification: "supported",
      supportedLineCount: 2,
      corruptLineCount: 0,
    });
  });

  it("writes nothing and exits 1 when the closure does not fit the budget", async () => {
    const { stateDir } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const outPath = join(outDir, "too-small.jsonl");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--correlation-id",
        ROOT_ID,
        "--out",
        outPath,
        "--max-bytes",
        "100",
      ],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(err()).toContain("insufficient (report-budget-exceeded)");
  });

  it("writes nothing and exits 1 when the selection is not retained", async () => {
    const { stateDir } = stateWithHistory();
    const outDir = makeRoot("keiko-query-cli-out-");
    const outPath = join(outDir, "missing.jsonl");
    const { io, err } = makeIo();

    const code = await runSupportCli(
      [
        "export",
        "--state-dir",
        stateDir,
        "--correlation-id",
        "corr-cli-absent-0001",
        "--out",
        outPath,
      ],
      io,
      AUDIT_ENV,
      exportDeps(outDir),
    );

    expect(code).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(err()).toContain("insufficient (evidence-not-retained)");
  });
});
