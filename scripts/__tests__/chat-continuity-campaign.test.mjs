import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driveContinuityCampaigns,
  continuityCampaignQualified,
  writeContinuityJson,
  installContinuityCancellation,
  continuityCaseId,
  continuityTrialResult,
} from "../testing/coding-workbench-lab/chat-continuity-campaign.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const BOUNDS = { requiredCycles: 2, requiredDuration: 100 };
it.each([undefined, -1, 0.5, NaN])("rejects invalid trial identity %s", (repetition) => {
  expect(() => continuityCaseId({ model: "gemma", kind: "plain", repetition }, "control")).toThrow(
    "invalid-continuity-trial",
  );
});
it("captures a trial result before later work can alter its timing or scores", () => {
  const current = { ...state(), model: "gemma", kind: "plain", repetition: 2 };
  const result = continuityTrialResult(current, BOUNDS, 101);
  current.probes[0].score.correct = 0;
  expect(result).toMatchObject({
    id: "gemma:plain:2:repetition-result",
    repetition: 2,
    elapsedMs: 101,
    status: "passed",
  });
  expect(result.probes[0].score.correct).toBe(9);
});
it("records unsuccessful repeats and requires restart only for long campaigns", () => {
  const current = { ...state(), model: "qwen", kind: "plain", repetition: 0 };
  current.probes = current.probes.filter((probe) => probe.phase !== "restart");
  expect(continuityTrialResult(current, BOUNDS, 101).status).toBe("incomplete");
  expect(continuityTrialResult(current, { ...BOUNDS, requireRestart: false }, 101).status).toBe(
    "passed",
  );
  current.failures = 1;
  expect(continuityTrialResult(current, { ...BOUNDS, requireRestart: false }, 101).status).toBe(
    "incomplete",
  );
});
it("keeps otherwise identical cycles from different repeated campaigns distinguishable", () => {
  const cases = ["gemma", "qwen"].flatMap((model) =>
    ["long", 0, 1, 2, 3, 4].flatMap((repetition) =>
      ["control", "cycle-1:pressure-0", "cycle-1:recall", "restart-recall"].map((phase) =>
        continuityCaseId({ model, kind: "plain", repetition }, phase),
      ),
    ),
  );
  expect(new Set(cases).size).toBe(48);
  expect(cases).toContain("qwen:plain:3:cycle-1:recall");
});
it("turns operator signals into one cancellation and removes its listeners", () => {
  const target = new EventEmitter(),
    cancellation = installContinuityCancellation(target);
  expect(cancellation.signal.aborted).toBe(false);
  target.emit("SIGTERM");
  target.emit("SIGINT");
  expect(cancellation.signal.aborted).toBe(true);
  expect(cancellation.reason).toBe("SIGTERM");
  cancellation.dispose();
  expect(target.eventNames()).toEqual([]);
});
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
  "invalid-json",
  "shrunken-oracle",
])("rejects an incomplete qualification: %s", (failure) => {
  const current = state();
  let now = 101;
  if (failure === "missing-restart") current.probes.pop();
  if (failure === "wrong-restart") current.probes.at(-1).score.correct = 8;
  if (failure === "missing-cycle") current.probes.splice(1, 1);
  if (failure === "request-error") current.failures = 1;
  if (failure === "too-few-cycles") current.cycles = 1;
  if (failure === "too-short") now = 99;
  if (failure === "invalid-json") current.probes[0].score.validJson = false;
  if (failure === "shrunken-oracle")
    current.probes[0].score = { validJson: true, correct: 0, total: 0 };
  expect(continuityCampaignQualified(current, BOUNDS, now)).toBe(false);
});
it("accepts the exact duration boundary and requires an explicit restart exemption", () => {
  const current = state();
  expect(continuityCampaignQualified(current, BOUNDS, 100)).toBe(true);
  current.probes.pop();
  expect(continuityCampaignQualified(current, BOUNDS, 100)).toBe(false);
  expect(continuityCampaignQualified(current, { ...BOUNDS, requireRestart: false }, 100)).toBe(
    true,
  );
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
