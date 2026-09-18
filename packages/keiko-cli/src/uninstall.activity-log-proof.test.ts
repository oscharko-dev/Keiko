// Activity Log proofs for `cli.uninstall.started`, `cli.uninstall.completed` and
// `cli.uninstall.failed` (#3532 proof backlog, partition p4-cli). None of the emitters
// (`openUninstallActivity`, `executeUninstall`, `emitUninstallFailure`) are exported, so each proof
// drives the real CLI entry point `runUninstallCli` with a capturing `securityLogSinkFactory` —
// the same seam `uninstall.test.ts` (read, not edited here) already uses for its own non-proof
// assertions.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runUninstallCli, type UninstallCliDeps } from "./uninstall.js";
import { KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT } from "./init.js";
import type { CliIo } from "./runner.js";

const tempRoots: string[] = [];
// macOS's os.tmpdir() sits under /var/folders/... -> /private/var/..., and the portable-install
// attestation this CLI runs refuses a symlinked ancestor; resolve once so a seeded root is never
// mistaken for one (same guard `uninstall.test.ts` applies via its own REAL_TMPDIR constant).
const REAL_TMPDIR = realpathSync(tmpdir());

function makeRoot(): string {
  const root = mkdtempSync(join(REAL_TMPDIR, "keiko-uninstall-proof-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeIo(): { readonly io: CliIo; readonly err: () => string } {
  const errChunks: string[] = [];
  return {
    io: { out: (): void => undefined, err: (text): void => void errChunks.push(text) },
    err: (): string => errChunks.join(""),
  };
}

function seedState(root: string, pid: string): string {
  const stateDir = join(root, ".keiko");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ui.pid"), `${pid}\n${"ab".repeat(16)}\n`, "utf8");
  writeFileSync(join(stateDir, "ui.log"), "log line\n", "utf8");
  return stateDir;
}

function seedPackageJson(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "demo",
        scripts: { "keiko:start": KEIKO_START_SCRIPT, "keiko:stop": KEIKO_STOP_SCRIPT },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function capturingDeps(root: string): {
  readonly deps: UninstallCliDeps;
  readonly events: SecurityLogEvent[];
} {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    deps: {
      cwd: root,
      homedir: (): string => root,
      activityStateDir: join(root, "control-state"),
      securityLogSinkFactory: () => ({ write: (event): void => void events.push(event) }),
    },
  };
}

describe("uninstall activity log proofs", () => {
  it("persists cli.uninstall.started and cli.uninstall.completed for a governed dry run", async () => {
    const root = makeRoot();
    seedState(root, "2147483646");
    seedPackageJson(root);
    const { io } = makeIo();
    const { deps, events } = capturingDeps(root);

    const code = await runUninstallCli(["--dry-run"], io, {}, deps);

    expect(code).toBe(0);
    expect(events.map((event) => event.op)).toEqual(["cli.uninstall.started", "cli.uninstall.completed"]);

    const startedLine = formatActivityLogProofLine(events[0] ?? {});
    const startedRecord = expectActivityLogProof("cli.uninstall.started.persisted", startedLine);
    expect(startedRecord).toMatchObject({
      dryRun: true,
      removeState: true,
      removeLaunchers: true,
      removeScripts: true,
    });
    expect(startedRecord.targetSha256).toMatch(/^[0-9a-f]{64}$/u);

    const completedLine = formatActivityLogProofLine(events[1] ?? {});
    const completedRecord = expectActivityLogProof("cli.uninstall.completed.persisted", completedLine);
    expect(completedRecord).toMatchObject({ dryRun: true, stateDisposition: "would-remove" });
  });

  it("persists cli.uninstall.failed when a running UI refuses an unforced state removal", async () => {
    const root = makeRoot();
    const stateDir = seedState(root, "555");
    const { io, err } = makeIo();
    const { deps, events } = capturingDeps(root);

    const code = await runUninstallCli(
      ["--state"],
      io,
      {},
      { ...deps, isProcessAlive: (): boolean => true },
    );

    expect(code).toBe(1);
    expect(err()).toContain("is running");
    expect(events.map((event) => event.op)).toEqual(["cli.uninstall.started", "cli.uninstall.failed"]);

    const failedLine = formatActivityLogProofLine(events[1] ?? {});
    const failedRecord = expectActivityLogProof("cli.uninstall.failed.persisted", failedLine);
    expect(failedRecord).toMatchObject({
      reason: "server-stop-refused",
      failureKind: "UninstallStateInUseError",
    });
    expect(failedRecord.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    // The evidence carries a hash of the state directory, never the real path.
    expect(JSON.stringify(events)).not.toContain(stateDir);
  });
});
