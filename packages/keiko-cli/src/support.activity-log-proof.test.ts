// Production CLI proof for the retained install-layout refusal. Report lifecycle proofs live
// in support-report-cli.test.ts and exercise the real persisted Activity Log.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeFileServerLogSinks } from "@oscharko-dev/keiko-server";

import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

import {
  INSTALL_LAYOUT_CORRELATION_ID_ENV,
  INSTALL_LAYOUT_OVERRIDES_ENV,
} from "./install-layout.js";

import type { CliIo } from "./runner.js";

import { runSupportCli } from "./support.js";

const REAL_TMPDIR = realpathSync(tmpdir());

const tempRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(REAL_TMPDIR, prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  // The real file sink is a process-wide singleton per log directory (support.ts's publication and
  // analysis evidence build one directly, with no injection seam); a suite that leaves one
  // registered leaves its segment open past this test's own temp dir being removed below.
  closeFileServerLogSinks();
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

const AUDIT_ENV = { KEIKO_LOCAL_STATE_AUDITOR: "/opt/keiko/scripts/lib/local-state-audit.mjs" };

describe("support activity log proofs", () => {
  it("persists cli.support.export.failed when a pending install-layout correction meets a symlinked state root", async () => {
    const outDir = makeRoot("keiko-support-proof-out-");
    const stateRoot = makeRoot("keiko-support-proof-state-");
    const stateDir = join(stateRoot, "state");
    const realStateDir = join(stateRoot, "real-state");
    mkdirSync(realStateDir, { recursive: true });
    symlinkSync(realStateDir, stateDir, "dir");
    const controlStateDir = join(outDir, "control-state");
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const env = {
      ...AUDIT_ENV,
      [INSTALL_LAYOUT_OVERRIDES_ENV]: "local-state-auditor",
      [INSTALL_LAYOUT_CORRELATION_ID_ENV]: correlationId,
    };
    const events: SecurityLogEvent[] = [];
    const { io } = makeIo();

    const code = await runSupportCli(["export", "--state-dir", stateDir], io, env, {
      cwd: outDir,
      controlActivityStateDir: controlStateDir,
      activityLogSinkFactory: () => ({ write: (event): void => void events.push(event) }),
    });

    expect(code).toBe(1);
    expect(events).toHaveLength(1);
    const line = formatActivityLogProofLine(events[0] ?? {});
    const record = expectActivityLogProof("cli.support.export.failed.install-layout-refusal", line);
    expect(record).toMatchObject({
      correlationId,
      errorKind: "unsafe-target",
      reason: "unsafe-state-root",
      failureKind: "SupportStateRootSymlinkError",
    });
    expect(record.targetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(events)).not.toContain(stateDir);
  });
});
