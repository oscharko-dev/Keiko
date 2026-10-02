import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import {
  analyzeSupportReport,
  parseSupportReport,
  serializeSupportReport,
  SupportReportError,
} from "@oscharko-dev/keiko-activity-log/reader";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../tests/support/activity-log-segments.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { expectActivityLogScenario } from "../../../tests/support/activity-log-scenario.js";
import { resealSupportReportWithParentFanOut } from "../../../tests/support/support-report-fixtures.js";
import type { CliIo } from "./runner.js";
import { runSupportCli } from "./support.js";
import { publishSupportReportFile, readSupportReportFile } from "./support-export.js";
import { SafeArtifactFileError } from "@oscharko-dev/keiko-security/fs-hardening";
import { emitSupportReportFailed } from "./support-report-evidence.js";

const CORRELATION = "support-report-cli-0001";
let root: string;
let stateDir: string;
let controlStateDir: string;
let path: string;

function capture(): { io: CliIo; output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text): void => {
        output.push(text);
      },
      err: (text): void => {
        errors.push(text);
      },
    },
    output,
    errors,
  };
}
function seed(): void {
  const process = fixtureProcess(4242, "aabbccdd");
  const now = Date.now();
  writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, { op: "client.diagnostic", correlationId: CORRELATION }),
  ]);
}
function seedGatewayFailure(): void {
  rmSync(join(stateDir, "logs"), { recursive: true });
  const process = fixtureProcess(4242, "aabbccdd");
  const now = Date.now();
  writeFixtureSegment(stateDir, segmentIdentity(process, now, 1), [
    fixtureLine(process, now, {
      op: "gateway.chat.started",
      correlationId: CORRELATION,
      fields: {
        modelId: "test-model",
        costClass: "low",
        timeoutMs: 100,
        maxRetries: 0,
        requestBudgetMs: 100,
        upstreamStreaming: false,
        streaming: false,
      },
    }),
    fixtureLine(process, now + 1, {
      op: "gateway.chat.failed",
      correlationId: CORRELATION,
      errorKind: "timeout",
      fields: {
        modelId: "test-model",
        streaming: false,
      },
    }),
    fixtureLine(process, now + 2, {
      op: "support.report.started",
      correlationId: CORRELATION,
      fields: { surface: "analyze", reportSchemaVersion: 1, maxBytes: 10485760 },
    }),
    fixtureLine(process, now + 3, {
      op: "support.report.failed",
      correlationId: CORRELATION,
      errorKind: "validation-failed",
      fields: {
        surface: "analyze",
        reportSchemaVersion: 1,
        frames: ["packages/keiko-model-gateway/src/gateway.ts:1209:3"],
        causeChain: ["Error"],
      },
    }),
  ]);
}
async function exportReport(out = root): Promise<ReturnType<typeof capture>> {
  const result = capture();
  const code = await runSupportCli(
    ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", out],
    result.io,
    {},
    { cwd: root, controlActivityStateDir: controlStateDir },
  );
  expect(code, result.errors.join("")).toBe(0);
  const filename = readdirSync(out).find((name) => name.startsWith("keiko-support-v1-"));
  if (filename === undefined) throw new TypeError("missing canonical report");
  path = join(out, filename);
  return result;
}
async function analyze(
  args: readonly string[] = [],
): Promise<{ code: number } & ReturnType<typeof capture>> {
  const result = capture();
  const code = await runSupportCli(
    ["analyze", path, ...args],
    result.io,
    {},
    { cwd: root, controlActivityStateDir: controlStateDir },
  );
  return { code, ...result };
}

function analyzeBuiltCli(): { code: number; output: string[]; errors: string[] } {
  const cliUrl = new URL("../dist/support.js", import.meta.url).href;
  const program = `
    import { runSupportCli } from ${JSON.stringify(cliUrl)};
    const output = [], errors = [];
    const code = await runSupportCli(["analyze", process.argv[1], "--json"], {
      out: (text) => output.push(text), err: (text) => errors.push(text),
    }, {}, { cwd: process.argv[2], controlActivityStateDir: process.argv[3] });
    process.stdout.write(JSON.stringify({ code, output, errors }));
  `;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--experimental-sqlite",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        program,
        path,
        root,
        controlStateDir,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ),
  ) as { code: number; output: string[]; errors: string[] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-support-report-cli-"));
  stateDir = join(root, "state");
  controlStateDir = join(root, "control");
  path = join(root, "report.json");
  mkdirSync(stateDir, { mode: 0o700 });
  seed();
});
afterEach(() => {
  closeFileServerLogSinks();
  rmSync(root, { recursive: true, force: true });
});

describe("support report CLI and private publication", () => {
  it("publishes exactly one private report and a versioned validated machine view", async () => {
    const result = await exportReport();
    expect(result.output.join("")).toContain("Nothing has been sent.");
    expect(readdirSync(root).sort()).toEqual([path.slice(root.length + 1), "state"].sort());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    expect(artifact.selection.status).toBe("complete");
    expect(artifact.seed?.correlationId).toBe(CORRELATION);
    const analyzed = await analyze(["--json"]);
    expect(analyzed.code, analyzed.errors.join("")).toBe(0);
    expect(JSON.parse(analyzed.output.join(""))).toEqual(artifact);
    expect(analyzed.output.join("")).not.toContain(root);
  });

  it("persists the started and completed proofs against the committed digest and byte count", async () => {
    await exportReport();
    const raw = readPersistedActivityLog(stateDir);
    const [started] = persistedActivityLogLines(raw, "support.report.started");
    const [completed] = persistedActivityLogLines(raw, "support.report.completed");
    const start = expectActivityLogProof("support.report.started.report-lifecycle", started ?? "");
    const end = expectActivityLogProof(
      "support.report.completed.report-lifecycle",
      completed ?? "",
    );
    const bytes = readFileSync(path);
    expect(end).toMatchObject({
      correlationId: start.correlationId,
      surface: "export",
      reportBytes: bytes.length,
      reportDigest: parseSupportReport(bytes.toString()).integrity.reportDigest,
      sufficiency: "complete",
      sufficiencyReasons: [],
      completeness: "complete",
      loss: "none",
    });
    expect(completed).not.toContain(path);
  });

  it("persists a fully evidenced validation failure before any hostile report is rendered", async () => {
    const startedAtMs = Date.now();
    writeFileSync(path, '{"$section":"config-snapshot","secret":"customer-private"}\n', {
      mode: 0o600,
    });
    const result = await analyze(["--json"]);
    expect(result.code).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("")).not.toContain("customer-private");
    const [line] = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.failed",
    );
    expect(
      expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
    ).toMatchObject({
      surface: "analyze",
      errorKind: "validation-failed",
      reason: "unsafe-report",
      completeness: "complete",
      loss: "none",
    });
    const trace = await expectActivityLogScenario("runtime-packages.dependency-failure", {
      stateDir: controlStateDir,
      startedAtMs,
      expectedOps: ["support.report.started", "support.report.failed"],
    });
    expect(trace.failureClasses).toContain("support-report");
  });

  it("emits only a body-free failure for amplified timelines in the built CLI under a 128 MiB heap", async () => {
    await exportReport();
    const report = parseSupportReport(readSupportReportFile(path));
    const hostile = resealSupportReportWithParentFanOut(report);
    writeFileSync(path, serializeSupportReport(hostile), { mode: 0o600 });
    const result = analyzeBuiltCli();
    expect(result.code).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("\n")).toContain("report-budget-exceeded");
    const raw = readPersistedActivityLog(controlStateDir);
    const [line] = persistedActivityLogLines(raw, "support.report.failed");
    expect(
      expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
    ).toMatchObject({
      errorKind: "validation-failed",
      completeness: "complete",
      loss: "none",
    });
    expect(persistedActivityLogLines(raw, "support.report.completed")).toEqual([]);
  });

  it("uses the closed default filename and owner-private output directory", async () => {
    const result = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION],
        result.io,
        {},
        { cwd: root },
      ),
    ).toBe(0);
    const directory = join(stateDir, "support-reports");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual([
      expect.stringMatching(/^keiko-support-v1-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}\.json$/u),
    ]);
  });

  it("never overwrites a destination or creates a sidecar", () => {
    writeFileSync(path, "existing-work", { mode: 0o600 });
    expect(() => {
      publishSupportReportFile(path, "new-report");
    }).toThrow();
    expect(readFileSync(path, "utf8")).toBe("existing-work");
    expect(existsSync(`${path}.sha256`)).toBe(false);
  });

  it.each(["live-symlink", "dangling-symlink", "hard-link"])(
    "refuses an unsafe %s output without changing a victim",
    (kind) => {
      const victim = join(root, "victim");
      writeFileSync(victim, "customer-private", { mode: 0o600 });
      if (kind === "hard-link") linkSync(victim, path);
      else symlinkSync(kind === "live-symlink" ? victim : join(root, "missing"), path);
      expect(() => {
        publishSupportReportFile(path, "report");
      }).toThrow();
      expect(readFileSync(victim, "utf8")).toBe("customer-private");
    },
  );

  it.each(["symlink", "hard-link", "public-permissions"])(
    "refuses a %s input before reading it",
    (kind) => {
      const victim = join(root, "victim");
      writeFileSync(victim, "customer-private", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(victim, path);
      else if (kind === "hard-link") linkSync(victim, path);
      else {
        writeFileSync(path, "customer-private");
        chmodSync(path, 0o644);
      }
      expect(() => readSupportReportFile(path)).toThrow();
    },
  );

  it("ignores private environment values, raw UI output and arbitrary files structurally", async () => {
    writeFileSync(join(stateDir, "ui.log"), "raw-customer-ui");
    writeFileSync(join(stateDir, "document.txt"), "private-document");
    const result = capture();
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--correlation-id", CORRELATION, "--out", root],
        result.io,
        { KEIKO_AZURE_APIKEY: "private-credential" },
        { cwd: root },
      ),
    ).toBe(0);
    const filename = readdirSync(root).find((name) => name.startsWith("keiko-support-v1-"));
    if (filename === undefined) throw new TypeError("missing canonical report");
    const report = JSON.stringify(
      analyzeSupportReport(readSupportReportFile(join(root, filename))),
    );
    for (const marker of ["raw-customer-ui", "private-document", "private-credential", root])
      expect(report).not.toContain(marker);
  });

  it("refuses every inclusion option before any output or diagnostic artifact", async () => {
    for (const flag of [
      "--include-evidence",
      "--include-ui-log",
      "--i-understand-this-is-unredacted",
    ]) {
      const result = capture();
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", path, flag, "private"],
          result.io,
        ),
      ).toBe(2);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("fails closed when the Activity Log destination is unavailable", async () => {
    rmSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs"), "not-a-directory");
    const result = capture();
    expect(await runSupportCli(["export", "--state-dir", stateDir, "--out", path], result.io)).toBe(
      1,
    );
    expect(existsSync(path)).toBe(false);
    expect(result.errors.join("")).not.toContain(stateDir);
  });

  it.each(["", "report.json", "nested/report"])(
    "refuses the Activity Log directory or descendant %s as a destination",
    async (tail) => {
      const result = capture();
      const forbidden = join(stateDir, "logs", tail);
      const before = readdirSync(join(stateDir, "logs"));
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", forbidden],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
      ).toBe(1);
      expect(readdirSync(join(stateDir, "logs"))).toEqual(before);
      const [line] = persistedActivityLogLines(
        readPersistedActivityLog(controlStateDir),
        "support.report.failed",
      );
      expect(
        expectActivityLogProof("support.report.failed.report-lifecycle", line ?? ""),
      ).toMatchObject({
        surface: "export",
        errorKind: "unsafe-target",
      });
      expect(result.errors.join("")).not.toContain(forbidden);
    },
  );

  it("refuses aliases and missing descendants of the Activity Log directory", async () => {
    const alias = join(root, "log-alias");
    symlinkSync(join(stateDir, "logs"), alias, "dir");
    const before = readdirSync(join(stateDir, "logs"));
    for (const target of [alias, join(alias, "nested", "report")]) {
      const result = capture();
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", target],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: controlStateDir },
        ),
      ).toBe(1);
      expect(readdirSync(join(stateDir, "logs"))).toEqual(before);
      expect(existsSync(join(alias, "nested"))).toBe(false);
    }
  });

  it.each(["equal", "parent", "child"])(
    "keeps overlapping control state %s out of a refused target",
    async (relation) => {
      const control =
        relation === "equal"
          ? stateDir
          : relation === "parent"
            ? root
            : join(stateDir, "nested-control");
      const result = capture();
      const forbidden = join(stateDir, "logs");
      const before = readdirSync(forbidden);
      expect(
        await runSupportCli(
          ["export", "--state-dir", stateDir, "--out", forbidden],
          result.io,
          {},
          { cwd: root, controlActivityStateDir: control },
        ),
      ).toBe(1);
      expect(result.output).toEqual([]);
      expect(readdirSync(forbidden)).toEqual(before);
      expect(existsSync(join(stateDir, "nested-control"))).toBe(false);
      expect(existsSync(join(root, "logs"))).toBe(false);
    },
  );

  it("fails closed without report output when rejection evidence cannot be persisted", async () => {
    writeFileSync(controlStateDir, "not-a-directory");
    const result = capture();
    const forbidden = join(stateDir, "logs");
    const before = readdirSync(forbidden);
    expect(
      await runSupportCli(
        ["export", "--state-dir", stateDir, "--out", forbidden],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      ),
    ).toBe(1);
    expect(result.output).toEqual([]);
    expect(result.errors.join("")).toBe("keiko support: unsafe-target\n");
    expect(readdirSync(forbidden)).toEqual(before);
  });

  it.each([
    [new SafeArtifactFileError("support-report", "target-exists"), "target-exists"],
    [new SafeArtifactFileError("support-report", "unsafe-target"), "unsafe-target"],
    [new SafeArtifactFileError("support-report", "open-failed"), "open-failed"],
    [new SafeArtifactFileError("support-report", "read-failed"), "read-failed"],
    [new SupportReportError("corrupt-report"), "validation-failed"],
    [new SupportReportError("unsupported-report", "9.0.0"), "validation-failed"],
    [new SupportReportError("selection-unavailable"), "invalid-request"],
    [new SupportReportError("seed-unavailable"), "unavailable"],
    [new Error("private message"), "internal"],
  ])("classifies report failures without exposing content (%s)", (error, errorKind) => {
    const events: unknown[] = [];
    emitSupportReportFailed(
      {
        write: (event): void => {
          events.push(event);
        },
      },
      CORRELATION,
      "analyze",
      error,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "support.report.failed", errorKind });
    expect((events[0] as { extra?: Record<string, unknown> }).extra?.reason).toBe(
      error instanceof SupportReportError ? error.reason : undefined,
    );
    expect(JSON.stringify(events)).not.toContain("private message");
  });

  it("reports missing requested correlation without emitting a machine view", async () => {
    await exportReport();
    for (const extra of [[], ["--seed"]]) {
      const result = await analyze(["--json", "--correlation-id", "missing-correlation", ...extra]);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toBe("keiko support: selection-unavailable\n");
    }
    const failed = persistedActivityLogLines(
      readPersistedActivityLog(controlStateDir),
      "support.report.failed",
    ).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(failed).toHaveLength(2);
    for (const line of failed)
      expect(line).toMatchObject({ errorKind: "invalid-request", reason: "selection-unavailable" });
  });

  it("names an unknown incident or fingerprint selection instead of calling it unsafe", async () => {
    for (const selector of [
      ["--incident", "0".repeat(32)],
      ["--defect-fingerprint", "0".repeat(64)],
    ]) {
      const result = capture();
      const code = await runSupportCli(
        ["export", "--state-dir", stateDir, ...selector, "--out", join(root, "out")],
        result.io,
        {},
        { cwd: root, controlActivityStateDir: controlStateDir },
      );
      expect(code).toBe(1);
      expect(result.errors.join("")).toContain("selection-unavailable");
      expect(existsSync(join(root, "out"))).toBe(false);
    }
  });
  it("prepares deterministic replay and failure localization solely from a complete report", async () => {
    seedGatewayFailure();
    await exportReport();
    const artifact = analyzeSupportReport(readSupportReportFile(path));
    expect(artifact.selection.status).toBe("complete");
    expect(artifact.seed?.gatewayScript?.attempts).toMatchObject([{ outcome: "timeout" }]);
    expect(artifact.seed?.stackFrames).toContain(
      "packages/keiko-model-gateway/src/gateway.ts:1209:3",
    );
    const result = await analyze(["--seed", "--json", "--emit-fixture", "replay.ts"]);
    expect(result.code, result.errors.join("")).toBe(0);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      seed: artifact.seed,
      fixtureWritten: true,
    });
    expect(readFileSync(join(root, "replay.ts"), "utf8")).toContain('"status": 504');
    expect(statSync(join(root, "replay.ts")).mode & 0o777).toBe(0o600);
  });

  it.each(["existing", "symlink", "hard-link"])(
    "settles replay publication failure for a %s destination without success evidence",
    async (kind) => {
      seedGatewayFailure();
      await exportReport();
      const target = join(root, "replay.ts");
      const victim = join(root, "victim.ts");
      writeFileSync(victim, "existing-private-work", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(victim, target);
      else if (kind === "hard-link") linkSync(victim, target);
      else writeFileSync(target, "existing-private-work", { mode: 0o600 });
      const result = await analyze(["--seed", "--json", "--emit-fixture", target]);
      expect(result.code).toBe(1);
      expect(result.output).toEqual([]);
      expect(result.errors.join("")).toContain("keiko support: target-exists\n");
      expect(readFileSync(victim, "utf8")).toBe("existing-private-work");
      const log = readPersistedActivityLog(controlStateDir);
      expect(persistedActivityLogLines(log, "support.report.completed")).toEqual([]);
      const failed = persistedActivityLogLines(log, "support.report.failed");
      expect(failed).toHaveLength(1);
      expect(JSON.parse(failed[0] ?? "{}")).toMatchObject({ errorKind: "target-exists" });
      expect(failed[0]).not.toContain('"reason"');
    },
  );

  it("provides thin human cluster, timeline and seed views after validation", async () => {
    seedGatewayFailure();
    await exportReport();
    for (const args of [[], ["--clusters"], ["--correlation-id", CORRELATION], ["--seed"]]) {
      const result = await analyze(args);
      expect(result.code, result.errors.join("")).toBe(0);
      expect(result.output.join("")).toContain("gateway");
    }
  });
  it("streams a large validated machine projection in bounded chunks", async () => {
    const process = fixtureProcess(5353, "aabbccdd");
    const now = Date.now();
    writeFixtureSegment(
      stateDir,
      segmentIdentity(process, now, 1),
      Array.from({ length: 2000 }, (_, index) =>
        fixtureLine(process, now + index, { op: "client.diagnostic", correlationId: CORRELATION }),
      ),
    );
    await exportReport();
    const result = await analyze(["--json"]);
    expect(result.code).toBe(0);
    expect(result.output.length).toBeGreaterThan(1);
    expect(result.output.every((chunk) => Buffer.byteLength(chunk) <= 32 * 1024 + 1)).toBe(true);
    expect(JSON.parse(result.output.join(""))).toEqual(
      analyzeSupportReport(readSupportReportFile(path)),
    );
  });
  it("uses the closed filename even for an explicitly selected private directory", async () => {
    const directory = join(root, "customer-secret-workspace-host");
    mkdirSync(directory, { mode: 0o700 });
    await exportReport(directory);
    expect(readdirSync(directory)).toEqual([
      expect.stringMatching(/^keiko-support-v1-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.json$/u),
    ]);
    expect(JSON.stringify(analyzeSupportReport(readSupportReportFile(path)))).not.toContain(
      "customer-secret-workspace-host",
    );
  });
});
