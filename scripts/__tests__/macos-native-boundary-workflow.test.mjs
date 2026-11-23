import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// #4521: the macOS native boundary lane proves the published sandbox statements from the shell of
// real runs. These pins keep it a lane that can fail: as the standard account, over the four suites,
// refusing a run that skipped anything, and in front of every npm publish.
const root = resolve(import.meta.dirname, "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const boundary = parse(read(".github/workflows/macos-native-boundary.yml"));
const release = parse(read(".github/workflows/release.yml"));
const account = parse(read(".github/actions/macos-standard-account/action.yml"));
const acceptance = parse(read(".github/workflows/coding-workbench-customer-shape.yml"));

const BOUNDARY_SUITES = [
  "packages/keiko-sandbox/src/runtime-gateway.test.ts",
  "packages/keiko-server/src/coding-runtime/opencodeNativeQualification.real.test.ts",
  "packages/keiko-server/src/coding-runtime/opencodeNativeDelivery.real.test.ts",
  "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts",
];

// The acceptance suite runs as the same account in the repository-relay job (A in the doc).
const ACCEPTANCE_SUITE =
  "packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts";

// The test and describe titles the published statements name as their proofs.
function documentedProofTitles() {
  const text = read("docs/coding-runtime/macos-native-boundary.md").replace(/\s+/gu, " ");
  return [...text.matchAll(/"([^"]{20,})"/gu)].map((match) => match[1] ?? "");
}

function proofStep() {
  const step = boundary.jobs["native-boundary"].steps.find(
    (entry) => entry.name === "Run the boundary proofs as the standard account",
  );
  if (step === undefined) throw new Error("the boundary lane has no proof step");
  return step;
}

describe("macOS native boundary lane (#4521)", () => {
  it("runs on a boundary pull request, every night, on demand and when the release calls it", () => {
    expect(Object.keys(boundary.on).sort()).toEqual(
      ["pull_request", "schedule", "workflow_call", "workflow_dispatch"].sort(),
    );
    expect(boundary.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        "packages/keiko-sandbox/**",
        "packages/keiko-server/src/coding-runtime/**",
        ".github/workflows/macos-native-boundary.yml",
      ]),
    );
    expect(boundary.jobs["native-boundary"]["runs-on"]).toBe("macos-15");
  });

  it("runs every boundary suite as the standard account and fails on a skipped test", () => {
    const run = proofStep().run;
    expect(run).toContain("sudo -u keikoqa -H /usr/bin/env -i");
    for (const suite of BOUNDARY_SUITES) expect(run).toContain(suite);
    expect(run).toContain("KEIKO_OPENCODE_REAL_BINARY=");
    expect(run).toContain("KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1");
    expect(run).toContain("KEIKO_NATIVE_ACCOUNT_CANARIES=1");
    // The name filter and the report check select the same tests, so a skip among them fails.
    expect(run).toContain('npx vitest run -t "$selected"');
    expect(run).toContain(
      'node scripts/check-vitest-report-ran.mjs "$HOME/boundary-report/boundary.json" --select "$selected"',
    );
    const selected = /^\s*selected='([^']+)'$/mu.exec(run)?.[1];
    expect(selected).toBeDefined();
    const pattern = new RegExp(selected ?? "", "u");
    expect(pattern.test("suite > drives the managed OpenCode composition end to end with x")).toBe(
      false,
    );
    expect(pattern.test("suite > [functional-only] drives the staged real OpenCode artifact")).toBe(
      false,
    );
    expect(pattern.test("suite > keeps the person's clipboard out of a shell's reach")).toBe(true);
    expect(run).toContain('[ "$tests" -eq 0 ] && [ "$ran" -eq 0 ]');
    const steps = boundary.jobs["native-boundary"].steps;
    const created = steps.findIndex(
      (step) => step.uses === "./.github/actions/macos-standard-account",
    );
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(steps.indexOf(proofStep()));
  });

  it("names, for every published statement, a proof that exists in a suite the lanes run", () => {
    const sources = [...BOUNDARY_SUITES, ACCEPTANCE_SUITE].map((suite) => read(suite));
    expect(proofStep().run).not.toContain(ACCEPTANCE_SUITE);
    expect(JSON.stringify(acceptance.jobs["repository-relay"])).toContain(
      "productionOpenCodeBackend.acceptance.test.ts",
    );
    const titles = documentedProofTitles();
    // A renamed or deleted proof leaves its statement without one; the lanes would not notice.
    expect(titles.length).toBeGreaterThanOrEqual(18);
    const missing = titles.filter((title) => !sources.some((source) => source.includes(title)));
    expect(missing).toEqual([]);
  });

  it("creates one standard account for both macOS lanes and refuses an administrator", () => {
    const script = account.runs.steps.map((step) => step.run).join("\n");
    expect(script).toContain("sudo sysadminctl -addUser keikoqa");
    expect(script).toContain("dseditgroup -o checkmember -m keikoqa admin");
    expect(script).toMatch(
      /admin[^\n]*\n\s*echo "::error::the standard account is an administrator"\n\s*exit 1/u,
    );
    const relay = acceptance.jobs["repository-relay"].steps.find(
      (step) => step.uses === "./.github/actions/macos-standard-account",
    );
    expect(relay?.with).toEqual({ jdk: "true" });
  });

  it("holds the npm publish until the boundary lane succeeded on the release commit", () => {
    const job = release.jobs["native-boundary"];
    expect(job.uses).toBe("./.github/workflows/macos-native-boundary.yml");
    expect(job.needs).toBe("authorize");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(release.jobs.publish.needs).toContain("native-boundary");
    expect(release.jobs.publish.if).toContain("needs.native-boundary.result == 'success'");
  });
});
