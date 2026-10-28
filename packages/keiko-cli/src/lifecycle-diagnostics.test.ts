import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const guardFailure = vi.hoisted(() => ({ error: new Error("initial fixture error") }));
vi.mock("./ui-lifecycle-guard.js", () => ({
  withUiLifecycleGuard: (): Promise<never> => Promise.reject(guardFailure.error),
}));

import { runLifecycleCli } from "./lifecycle.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["EACCES", "EIO"])(
  "classifies a lifecycle guard failure without its body: %s",
  async (code) => {
    const root = mkdtempSync(join(tmpdir(), "keiko-lifecycle-diagnostic-"));
    roots.push(root);
    const state = join(root, "state");
    mkdirSync(state);
    guardFailure.error = Object.assign(new Error("private fixture path and contents"), { code });
    const events: SecurityLogEvent[] = [];
    const stderr: string[] = [];
    const result = await runLifecycleCli(
      "status",
      ["--state-dir", state],
      { out: vi.fn(), err: (text): void => void stderr.push(text) },
      {},
      {
        cwd: root,
        homedir: (): string => root,
        securityLogSink: { write: (event): void => void events.push(event) },
      },
    );
    expect(result).toBe(1);
    expect(stderr.join("")).toContain(
      `UI lifecycle operation failed (${code}); tracking retained.`,
    );
    expect(stderr.join("")).not.toContain("ownership remains uncertain");
    expect(events).toEqual([
      expect.objectContaining({
        op: "cli.lifecycle.native-owner",
        errorKind: "unavailable",
        extra: {
          phase: "reservation",
          outcome: "held",
          failureKind: code,
          completeness: "complete",
          loss: "none",
        },
      }),
    ]);
    expect(JSON.stringify({ stderr, events })).not.toContain(guardFailure.error.message);
    const event = events[0];
    if (event === undefined) throw new Error("Missing classified lifecycle failure");
    expect(
      expectActivityLogProof(
        "cli.lifecycle.native-owner.outcome",
        formatActivityLogProofLine(event),
      ),
    ).toMatchObject({ phase: "reservation", outcome: "held", failureKind: code });
  },
);
