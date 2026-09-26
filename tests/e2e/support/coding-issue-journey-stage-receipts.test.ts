import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { recordSuccessfulJourneyStage } from "./coding-issue-journey-stage-receipts.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pageWithToolCount(count: () => Promise<number>): Page {
  return { locator: () => ({ count }) } as unknown as Page;
}

const FLOW_BINDING = {
  flowId: "issue-to-pr-flow-01",
  taskRunId: "run-1",
  repository: "oscharko/Wegwerf-Repo",
  issueNumber: 1,
  pullRequestNumber: 7,
  pullRequestHeadSha: "a".repeat(40),
} as const;

describe("coding issue journey stage receipt", () => {
  it("fails closed when visible tool activity is absent or cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stage-receipt-"));
    roots.push(root);
    vi.stubEnv("KEIKO_QUALIFICATION_RECEIPTS_DIR", root);
    await expect(
      recordSuccessfulJourneyStage(
        pageWithToolCount(() => Promise.resolve(0)),
        "mark-ready-intent",
        ["ready-for-review-proposed:true"],
        Date.now(),
        FLOW_BINDING,
        1,
      ),
    ).rejects.toThrow("no observed model tool activity");
    await expect(
      recordSuccessfulJourneyStage(
        pageWithToolCount(() => Promise.reject(new Error("transport failed"))),
        "mark-ready-intent",
        ["ready-for-review-proposed:true"],
        Date.now(),
        FLOW_BINDING,
        1,
      ),
    ).rejects.toThrow("transport failed");
    expect(existsSync(join(root, "mark-ready-intent.artifact"))).toBe(false);
  });

  it("retains the exact completed-flow binding with positive tool activity", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-stage-receipt-"));
    roots.push(root);
    vi.stubEnv("KEIKO_QUALIFICATION_RECEIPTS_DIR", root);
    const digest = await recordSuccessfulJourneyStage(
      pageWithToolCount(() => Promise.resolve(2)),
      "mark-ready-intent",
      ["ready-for-review-proposed:true"],
      Date.now(),
      FLOW_BINDING,
      3,
    );
    const artifact: unknown = JSON.parse(
      readFileSync(join(root, "mark-ready-intent.artifact"), "utf8"),
    );
    expect(artifact).toMatchObject({
      result: "passed",
      flowBinding: FLOW_BINDING,
      usage: { observedToolCallEvents: 3 },
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const flowArtifact: unknown = JSON.parse(
      readFileSync(join(root, "issue-to-pr-flow-01.mark-ready-intent.artifact"), "utf8"),
    );
    expect(flowArtifact).toEqual(artifact);
  });
});
