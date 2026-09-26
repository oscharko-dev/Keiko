import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { compareStrings } from "../lib/compare-strings.mjs";
import { sha256 } from "../lib/digest.mjs";
import {
  CATALOG_GATE_IDS,
  LOCAL_CATALOG_GATE_IDS,
  qualifyLocalCatalogGate,
  qualifyRequiredCi,
} from "../qualify-tool-catalog-gates.mjs";

const roots = [];
const HEAD = "a".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "keiko-catalog-gates-"));
  const root = join(base, "source");
  const logsDir = join(base, "logs");
  const receiptsDir = join(base, "receipts");
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"version":"0.3.17"}\n');
  roots.push(base);
  return { base, logsDir, root, receiptsDir };
}

function initGit(root) {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
}

function dependencies(result = { status: 0, signal: null }) {
  return {
    cleanHead: vi.fn(() => HEAD),
    executable: (name) => name,
    now: () => new Date("2026-09-07T05:00:00.000Z"),
    run: vi.fn(() => result),
  };
}

function receiptFiles(directory) {
  return readdirSync(directory).sort(compareStrings);
}

function page(
  values,
  completeness = { complete: true, entries: values.length, pages: 1, bytes: 1 },
) {
  return { values, completeness };
}

function requiredCiFacts({ appId = 7, checkHead = HEAD, checkRuns, identity, requirements } = {}) {
  const baseSha = "b".repeat(40);
  const runs =
    checkRuns ??
    page([
      {
        id: 1,
        name: "ci",
        headSha: checkHead,
        appId,
        status: "completed",
        conclusion: "success",
        startedAt: "2026-09-07T04:00:00Z",
        completedAt: "2026-09-07T04:01:00Z",
        suiteId: 9,
        annotationCount: 0,
      },
    ]);
  return {
    status: "observed",
    identity: {
      number: 3394,
      externalId: "PR_3394",
      url: "https://github.com/oscharko-dev/Keiko/pull/3394",
      repository: "oscharko-dev/Keiko",
      headRepository: "oscharko-dev/Keiko",
      headRef: "feature/epic-3384",
      headSha: HEAD,
      baseRef: "dev",
      baseSha,
      state: "open",
      isDraft: false,
      ...identity,
    },
    repositoryId: 41,
    mergeable: true,
    mergeState: "clean",
    merged: false,
    protection: {
      outcome: "protected",
      value: {
        checks: { checks: [{ context: "ci", app_id: 7 }], contexts: ["ci"] },
        strict: true,
        reviewCount: 0,
      },
    },
    requirements: requirements ?? {
      status: "observed",
      requirements: [
        {
          kind: "status-context",
          context: "ci",
          appId: 7,
          sources: [{ kind: "branch-protection" }],
        },
      ],
      strict: true,
      digest: "c".repeat(64),
    },
    workflowDefinitions: { status: "observed", definitions: [] },
    lists: {
      "branch-rules": page([]),
      "check-runs": runs,
      "commit-statuses": page([]),
      "workflow-runs": page([]),
      reviews: page([]),
    },
  };
}

function requiredCiDependencies(facts = requiredCiFacts()) {
  return {
    cleanHead: vi.fn(() => HEAD),
    now: () => new Date("2026-09-07T05:00:00.000Z"),
    origin: () => "https://github.com/oscharko-dev/Keiko.git",
    reader: vi.fn(() => ({ readFacts: vi.fn(async () => facts) })),
  };
}

describe("tool catalog closeout gate receipt producer", () => {
  it("owns every non-consumer closeout check exactly once", () => {
    expect(CATALOG_GATE_IDS).toHaveLength(15);
    expect([...LOCAL_CATALOG_GATE_IDS, "required-ci"].sort(compareStrings)).toEqual(
      [...CATALOG_GATE_IDS].sort(compareStrings),
    );
  });

  it("executes a fixed gate and writes its exact-head body-free report only after success", async () => {
    const { logsDir, root, receiptsDir } = await fixture();
    const deps = dependencies();
    const report = qualifyLocalCatalogGate(
      { id: "catalog-conformance", logsDir, receiptsDir, root },
      deps,
    );

    expect(deps.run).toHaveBeenCalledWith(
      expect.any(String),
      ["scripts/check-tool-catalog-conformance.mjs", "--closeout"],
      expect.objectContaining({ cwd: root, shell: false, stdio: "pipe" }),
    );
    expect(deps.cleanHead).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      currentHead: HEAD,
      executionKind: "qualification-gate",
      status: "passed",
      passed: 1,
      failed: 0,
      skipped: 0,
      binding: null,
      components: null,
      packages: null,
    });
    expect(JSON.stringify(report)).not.toMatch(/stdout|stderr|command|token|endpoint/u);
    expect(receiptFiles(receiptsDir)).toEqual([
      "catalog-conformance.artifact",
      "catalog-conformance.receipt.json",
    ]);
    expect(receiptFiles(logsDir)).toEqual(["catalog-conformance-1.log"]);
    const artifact = readFileSync(join(receiptsDir, "catalog-conformance.artifact"), "utf8");
    const receipt = JSON.parse(
      readFileSync(join(receiptsDir, "catalog-conformance.receipt.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      scenarioId: "catalog-conformance",
      commitSha: HEAD,
      testStatus: "passed",
      provenance: "qualification-gate",
    });
    expect(receipt.digest).toBeUndefined();
    expect(sha256(artifact)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("qualifies clean-checkout from the two actual clean-head observations", async () => {
    const { logsDir, root, receiptsDir } = await fixture();
    const deps = dependencies();
    const report = qualifyLocalCatalogGate(
      { id: "clean-checkout", logsDir, receiptsDir, root },
      deps,
    );
    expect(deps.cleanHead).toHaveBeenCalledTimes(2);
    expect(deps.run).not.toHaveBeenCalled();
    expect(report.passed).toBe(1);
    expect(receiptFiles(logsDir)).toEqual(["clean-checkout-1.log"]);
  });

  it("refuses direct and symlink-aliased source output before touching a clean Git checkout", async () => {
    const { base, logsDir, receiptsDir, root } = await fixture();
    initGit(root);
    const alias = join(base, "source-alias");
    symlinkSync(root, alias, "dir");
    const cases = [
      { logsDir: join(root, "logs"), receiptsDir },
      { logsDir: join(alias, "logs"), receiptsDir },
      { logsDir, receiptsDir: join(root, "receipts") },
      { logsDir, receiptsDir: join(alias, "receipts") },
    ];
    for (const output of cases) {
      expect(() => qualifyLocalCatalogGate({ id: "clean-checkout", root, ...output })).toThrow(
        "outside the source checkout",
      );
      expect(existsSync(output.receiptsDir)).toBe(false);
      expect(existsSync(output.logsDir)).toBe(false);
    }
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" })).toBe(
      "",
    );
  });

  it.each([
    { result: { status: 1, signal: null }, label: "nonzero" },
    { result: { status: null, signal: "SIGTERM" }, label: "signal" },
    {
      result: { status: null, signal: null, error: new Error("private command body") },
      label: "error",
    },
  ])("writes no receipt for a $label command outcome", async ({ result }) => {
    const { logsDir, root, receiptsDir } = await fixture();
    expect(() =>
      qualifyLocalCatalogGate(
        { id: "catalog-performance", logsDir, receiptsDir, root },
        dependencies(result),
      ),
    ).toThrow("catalog-performance command 1 did not pass");
    expect(() => readdirSync(receiptsDir)).toThrow();
    expect(receiptFiles(logsDir)).toEqual(["catalog-performance-1.log"]);
  });

  it("rejects unknown caller-selected commands and source drift", async () => {
    const { logsDir, root, receiptsDir } = await fixture();
    expect(() =>
      qualifyLocalCatalogGate({ id: "custom-shell", logsDir, receiptsDir, root }, dependencies()),
    ).toThrow("unsupported local catalog gate");
    const deps = dependencies();
    deps.cleanHead.mockReturnValueOnce(HEAD).mockReturnValueOnce("b".repeat(40));
    expect(() =>
      qualifyLocalCatalogGate({ id: "format", logsDir, receiptsDir, root }, deps),
    ).toThrow("source changed during qualification");
    expect(LOCAL_CATALOG_GATE_IDS).not.toContain("required-ci");
  });

  it("writes required CI only after the configured GitHub checks pass on exact HEAD", async () => {
    const { logsDir, root, receiptsDir } = await fixture();
    const deps = requiredCiDependencies();
    const report = await qualifyRequiredCi({ logsDir, prNumber: 3394, receiptsDir, root }, deps);
    const [, stillAuthorized] = deps.reader.mock.calls[0];
    expect(stillAuthorized()).toBe(true);
    expect(deps.reader.mock.results[0].value.readFacts).toHaveBeenCalledWith({
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "3394",
      baseBranchName: "dev",
      headSha: HEAD,
    });
    expect(report).toMatchObject({
      currentHead: HEAD,
      platform: `${process.platform}-${process.arch}`,
      runtime: { node: process.versions.node },
      passed: 1,
      binding: {
        kind: "required-ci",
        repository: "oscharko-dev/Keiko",
        repositoryId: 41,
        pullRequestNumber: 3394,
        headRepository: "oscharko-dev/Keiko",
        headRef: "feature/epic-3384",
        headSha: HEAD,
        baseRef: "dev",
        baseSha: "b".repeat(40),
        requirementsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(receiptFiles(receiptsDir)).toEqual(["required-ci.artifact", "required-ci.receipt.json"]);
    expect(receiptFiles(logsDir)).toEqual(["required-ci-1.log"]);
    expect(JSON.parse(readFileSync(join(receiptsDir, "required-ci.artifact"), "utf8"))).toEqual(
      report,
    );
  });

  it.each([
    {
      facts: requiredCiFacts({ appId: 8 }),
      label: "same-name check from the wrong app",
    },
    {
      facts: requiredCiFacts({ checkHead: "d".repeat(40) }),
      label: "passing check from a stale head",
    },
    {
      facts: requiredCiFacts({ identity: { number: 3395 } }),
      label: "facts for a different pull request",
    },
    {
      facts: requiredCiFacts({ identity: { repository: "other/Keiko" } }),
      label: "facts for a different repository",
    },
    {
      facts: {
        status: "unavailable",
        failure: { reason: "revision-changed", state: "pending" },
      },
      label: "required set changed during observation",
    },
    {
      facts: requiredCiFacts({
        checkRuns: page([], {
          complete: false,
          entries: 0,
          pages: 3,
          bytes: 1,
          failure: { reason: "pagination-exhausted", state: "unknown" },
        }),
      }),
      label: "incomplete check pagination",
    },
    {
      facts: requiredCiFacts({
        requirements: {
          status: "unknown",
          failure: { reason: "pagination-exhausted", state: "unknown" },
        },
      }),
      label: "incomplete ruleset pagination",
    },
    {
      facts: requiredCiFacts({
        requirements: {
          status: "observed",
          requirements: [],
          strict: true,
          digest: "c".repeat(64),
        },
      }),
      label: "no configured checks",
    },
  ])("rejects required CI with $label", async ({ facts }) => {
    const { logsDir, root, receiptsDir } = await fixture();
    await expect(
      qualifyRequiredCi(
        { logsDir, prNumber: 3394, receiptsDir, root },
        requiredCiDependencies(facts),
      ),
    ).rejects.toThrow(/required CI/u);
    expect(() => readdirSync(receiptsDir)).toThrow();
  });

  it("rejects non-GitHub and malformed origins before required-CI lookup", async () => {
    const { logsDir, root, receiptsDir } = await fixture();
    for (const origin of ["https://example.com/owner/repo.git", "file:///private/repo"]) {
      await expect(
        qualifyRequiredCi(
          { logsDir, receiptsDir, root },
          {
            cleanHead: () => HEAD,
            now: () => new Date("2026-09-07T05:00:00.000Z"),
            origin: () => origin,
            reader: () => ({ readFacts: async () => requiredCiFacts() }),
          },
        ),
      ).rejects.toThrow("origin is not a GitHub repository");
    }
  });
});
