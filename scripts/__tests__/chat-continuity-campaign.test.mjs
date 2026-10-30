import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driveContinuityCampaigns,
  continuityCampaignQualified,
  writeContinuityJson,
} from "../testing/coding-workbench-lab/chat-continuity-campaign.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const BOUNDS = { requiredCycles: 2, requiredDuration: 100 };
function state() {
  return {
    cycles: 2,
    startedAt: 0,
    failures: 0,
    probes: ["control", "cycle", "cycle", "restart"].map((phase) => ({
      phase,
      score: { validJson: true, correct: 9, total: 9 },
    })),
  };
}

it("terminates when a failed campaign cannot advance and its peer is complete", async () => {
  const failed = { ...state(), failures: 3, cycles: 0 };
  let operations = 0;
  await expect(
    driveContinuityCampaigns(
      [failed, state()],
      BOUNDS,
      () => {
        if (++operations > 3) throw new Error("runaway-campaign");
      },
      () => 101,
    ),
  ).resolves.toBeUndefined();
  expect(operations).toBe(0);
});
it("runs only pending campaigns until both count and duration requirements are met", async () => {
  const pending = { ...state(), cycles: 0 },
    complete = { ...state(), startedAt: -100 };
  let now = 0;
  const seen = [];
  await driveContinuityCampaigns(
    [complete, pending],
    BOUNDS,
    (current) => {
      seen.push(current);
      current.cycles++;
      now += 50;
    },
    () => now,
  );
  expect(seen).toEqual([pending, pending]);
});
it("accepts a complete campaign with independently scored control, cycles and restart", () => {
  expect(continuityCampaignQualified(state(), BOUNDS, 101)).toBe(true);
});
it.each([
  "missing-restart",
  "wrong-restart",
  "missing-cycle",
  "request-error",
  "too-few-cycles",
  "too-short",
])("rejects an incomplete qualification: %s", (failure) => {
  const current = state();
  let now = 101;
  if (failure === "missing-restart") current.probes.pop();
  if (failure === "wrong-restart") current.probes.at(-1).score.correct = 8;
  if (failure === "missing-cycle") current.probes.splice(1, 1);
  if (failure === "request-error") current.failures = 1;
  if (failure === "too-few-cycles") current.cycles = 1;
  if (failure === "too-short") now = 99;
  expect(continuityCampaignQualified(current, BOUNDS, now)).toBe(false);
});
it("retains the previous parseable ledger when a replacement write fails partway", () => {
  const root = mkdtempSync(join(tmpdir(), "keiko-continuity-ledger-"));
  roots.push(root);
  const path = join(root, "ledger.json");
  writeContinuityJson(path, { status: "running", rows: [1] });
  const previous = readFileSync(path, "utf8");
  expect(() =>
    writeContinuityJson(
      path,
      { status: "running", rows: [1, 2] },
      {
        ...fs,
        writeFileSync: (target) => {
          writeFileSync(target, '{"truncated":');
          throw new Error("injected-write-failure");
        },
      },
    ),
  ).toThrow("injected-write-failure");
  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(readdirSync(root)).toEqual(["ledger.json"]);
  expect(statSync(path).mode & 0o077).toBe(0);
});
