import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeFileServerLogSinks } from "@oscharko-dev/keiko-activity-log";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import type { CliIo } from "./runner.js";
import { runSupportCli, parseSupportArgs } from "./support.js";
import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
} from "./install-layout.js";
const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };
function makeIo(): { io: CliIo; out: () => string; err: () => string } {
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
    out: (): string => output.join(""),
    err: (): string => errors.join(""),
  };
}
function writePrivateFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}
describe("support install-layout regression pins", () => {
  let stateDir: string;
  let outDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-state-"));
    outDir = mkdtempSync(join(tmpdir(), "keiko-support-out-"));
    mkdirSync(join(stateDir, "logs"), { mode: 0o700 });
  });
  afterEach(() => {
    closeFileServerLogSinks();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });
  it("persists install-layout normalization before report selection", async () => {
    const c = makeIo();
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const currentLog = join(stateDir, "logs", "server.log");
    writePrivateFile(currentLog, "");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir],
      c.io,
      {
        ...AUDIT_ENV,
        [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
        [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
      },
      {
        cwd: outDir,
        activityLogSinkFactory: (selectedStateDir) => {
          expect(selectedStateDir).toBe(stateDir);
          return {
            write: (event): void => {
              appendFileSync(currentLog, `${JSON.stringify(event)}\n`, "utf8");
            },
          };
        },
      },
    );

    expect(code).toBe(0);
    const persisted = readPersistedActivityLog(stateDir);
    expect(persisted).toContain('"op":"cli.install-layout.normalized"');
    expect(persisted).toContain(`"correlationId":"${correlationId}"`);
    expect(persisted.indexOf('"op":"cli.install-layout.normalized"')).toBeLessThan(
      persisted.indexOf('"op":"support.report.started"'),
    );
  });
  it("refuses a pending install-layout correction before reading a symlinked state root", async () => {
    const realStateDir = join(outDir, "real-state");
    mkdirSync(realStateDir);
    rmSync(stateDir, { recursive: true });
    symlinkSync(realStateDir, stateDir, "dir");
    let factoryCalls = 0;
    const controlStateDir = join(outDir, "control-state");
    const events: SecurityLogEvent[] = [];
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };
    const refusedOut = join(outDir, "refused");

    const code = await runSupportCli(
      ["export", "--state-dir", stateDir, "--out", refusedOut],
      makeIo().io,
      env,
      {
        cwd: outDir,
        controlActivityStateDir: controlStateDir,
        activityLogSinkFactory: (sinkRoot) => {
          expect(sinkRoot).toBe(controlStateDir);
          factoryCalls += 1;
          return { write: (event): void => void events.push(event) };
        },
      },
    );

    expect(code).toBe(1);
    expect(factoryCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "cli.support.export.failed",
      correlationId: env[INSTALL_LAYOUT_CORRELATION_ID_ENV],
      errorKind: "unsafe-target",
    });
    expect(events[0]?.extra?.reason).toBe("unsafe-state-root");
    expect(events[0]?.extra?.failureKind).toBe("SupportStateRootSymlinkError");
    expect(events[0]?.extra?.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(events)).not.toContain(stateDir);
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBe("local-state-auditor");
    expect(existsSync(refusedOut)).toBe(false);
  });
  it("refuses a pending install-layout correction when no durable sink is available", async () => {
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: "00000000-0000-4000-8000-000000000001",
    };

    const code = await runSupportCli(["export", "--state-dir", stateDir], makeIo().io, env, {
      cwd: outDir,
    });

    expect(code).toBe(1);
    expect(env[INSTALL_LAYOUT_OVERRIDES_ENV]).toBe("local-state-auditor");
  });
});

describe("support argv", () => {
  it.each(
    [[], ["--help"], ["-h"], ["export", "--help"], ["analyze", "--help"]].map((args) => [args]),
  )("recognizes help %j", (args) => {
    expect(parseSupportArgs(args).kind).toBe("help");
  });
  it.each(
    [
      ["unknown"],
      ["analyze"],
      ["export", "--out"],
      ["export", "--max-bytes", "0"],
      ["export", "--max-bytes", "-1"],
      ["export", "--max-bytes", "10485761"],
      ["export", "--max-bytes", "abc"],
      ["analyze", "file", "--correlation-id"],
      ["analyze", "file", "--emit-fixture"],
    ].map((args) => [args]),
  )("refuses invalid arguments %j", (args) => {
    expect(parseSupportArgs(args).kind).toBe("usage");
  });
  it("uses the incident correlation by default for seed preparation", () => {
    expect(parseSupportArgs(["analyze", "report.json", "--seed", "--json"])).toMatchObject({
      kind: "analyze",
      value: { file: "report.json", seed: true, json: true },
    });
  });
});
