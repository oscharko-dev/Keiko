import { fileURLToPath, URL } from "node:url";

import { describe, expect, it } from "vitest";

import { checkCodingIssueJourneyEvidence } from "../check-coding-issue-journey-evidence.mjs";
import { deriveGateVerdict, platformKeyFor } from "../lib/coding-issue-journey-evidence.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const HEAD_SHAS = { sourceCommitSha: COMMIT_SHA, sourceTreeSha: TREE_SHA };

const FIXTURES_ROOT = fileURLToPath(
  new URL("fixtures/coding-issue-journey-evidence/", import.meta.url),
);

function fixture(name) {
  return {
    manifestPath: `${FIXTURES_ROOT}${name}/manifest.json`,
    receiptsDir: `${FIXTURES_ROOT}${name}/receipts`,
  };
}

const BASE_BINDING = {
  epicIssue: 3384,
  childIssue: 3390,
  registeredScenarioIds: ["issue-to-pr-full-access"],
};

async function runFixture(name, { headShas = HEAD_SHAS, binding = BASE_BINDING } = {}) {
  const { manifestPath, receiptsDir } = fixture(name);
  return checkCodingIssueJourneyEvidence({ manifestPath, receiptsDir, binding, headShas });
}

describe("checkCodingIssueJourneyEvidence", () => {
  it("passes a fully valid manifest bound to the qualified head with a matching receipt", async () => {
    const { verdict, failures } = await runFixture("valid");
    expect(failures).toEqual([]);
    expect(verdict).toBe("qualified");
  });

  it("rejects a manifest bound to a stale/foreign commit SHA", async () => {
    const { verdict, failures } = await runFixture("stale-sha", {
      headShas: HEAD_SHAS,
      binding: BASE_BINDING,
    });
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("stale or foreign source SHA"))).toBe(true);
    // The stale fixture's own receipt is bound to STALE_COMMIT_SHA, so the receipt-binding check
    // independently reports it as foreign to the true head too (belt and braces).
    expect(failures.some((failure) => failure.includes(`expected ${COMMIT_SHA}`))).toBe(true);
  });

  it("rejects a passed scenario resting on scripted-model provenance", async () => {
    const { verdict, failures } = await runFixture("scripted-passed");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) =>
        failure.includes("scripted-model provenance cannot establish qualification"),
      ),
    ).toBe(true);
  });

  it("rejects a scenario whose evidenceClass is outside the shared registered vocabulary", async () => {
    const { verdict, failures } = await runFixture("missing-evidence-class");
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("not a registered evidence class"))).toBe(
      true,
    );
  });

  it("rejects a manifest that claims a receipt digest with no receipt on disk", async () => {
    const { verdict, failures } = await runFixture("missing-receipt");
    expect(verdict).toBe("blocked");
    expect(failures).toContain("issue-to-pr-full-access: missing receipt");
  });

  it("rejects a receipt whose artifact bytes do not hash to the manifest's claimed digest", async () => {
    const { verdict, failures } = await runFixture("wrong-digest");
    expect(verdict).toBe("blocked");
    expect(failures.some((failure) => failure.includes("wrong-SHA receipt"))).toBe(true);
  });

  it("rejects a receipt recorded on a different platform than the manifest claims", async () => {
    const { verdict, failures } = await runFixture("wrong-platform");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) => failure.includes("does not match the manifest's macos-arm64")),
    ).toBe(true);
  });

  it("rejects a skipped test receipt as insufficient release qualification evidence", async () => {
    const { verdict, failures } = await runFixture("skipped-test");
    expect(verdict).toBe("blocked");
    expect(
      failures.some((failure) => failure.includes("is not release qualification evidence")),
    ).toBe(true);
  });

  it("rejects a scenario that is not in the registered scenario set", async () => {
    const { verdict, failures } = await runFixture("unregistered-scenario", {
      headShas: HEAD_SHAS,
      binding: { ...BASE_BINDING, registeredScenarioIds: [] },
    });
    expect(verdict).toBe("blocked");
    expect(failures).toContain("manifest: unregistered scenario: issue-to-pr-full-access");
  });
});

describe("platformKeyFor", () => {
  it("maps every release-blocking desktop target plus the CI evidence host", () => {
    expect(platformKeyFor("darwin", "arm64")).toBe("macos-arm64");
    expect(platformKeyFor("darwin", "x64")).toBe("macos-x64");
    expect(platformKeyFor("win32", "x64")).toBe("windows-x64");
    expect(platformKeyFor("linux", "x64")).toBe("linux-x64");
  });

  it("returns undefined for an unsupported os/arch combination", () => {
    expect(platformKeyFor("linux", "arm64")).toBeUndefined();
    expect(platformKeyFor("sunos", "x64")).toBeUndefined();
  });
});

describe("deriveGateVerdict", () => {
  it("reports failed for a genuinely failed scenario even when the contract already blocked it", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "failed",
        failures: ["manifest: foreign epic issue binding"],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("failed");
  });

  it("never upgrades a contract verdict when an evidence-gate failure exists", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "qualified",
        failures: ["issue-to-pr-full-access: missing receipt"],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("blocked");
  });

  it("passes the contract verdict through when there are no evidence-gate failures", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "qualified",
        failures: [],
        manifestValidation: { ok: true, value: { scenarios: [] } },
      }),
    ).toBe("qualified");
  });

  it("is blocked when the manifest itself failed structural validation", () => {
    expect(
      deriveGateVerdict({
        contractVerdict: "blocked",
        failures: ["manifest: kind must be code-task-qualification-manifest"],
        manifestValidation: {
          ok: false,
          errors: ["kind must be code-task-qualification-manifest"],
        },
      }),
    ).toBe("blocked");
  });
});
