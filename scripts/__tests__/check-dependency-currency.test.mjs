import { describe, expect, it } from "vitest";

import {
  actionFailures,
  collectWorkflowPins,
  dependencyFailures,
  evaluate,
  main,
  parseActionRows,
  parseDependencyRows,
  resolveInstalledVersion,
} from "../check-dependency-currency.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const DOCUMENT = `# closeout

| Package | Scope | Version | Disposition | Rationale |
| ------- | ----- | ------- | ----------- | --------- |
| \`typescript\` | root | 6.0.3 | major-deferred | API lane |
| \`vitest\` | keiko-ui | 4.1.11 | current | ahead of root |
| \`prose\` | not | a | table-row | ignored |

| Action | Version | Commit | Disposition |
| ------ | ------- | ------ | ----------- |
| \`actions/checkout\` | v7.0.0 | ${SHA_A} | current |
`;

const LOCK = {
  "node_modules/typescript": { version: "6.0.3" },
  "node_modules/vitest": { version: "4.1.10" },
  "packages/keiko-ui/node_modules/vitest": { version: "4.1.11" },
};

const workflow = (name, ...lines) => ({ name, text: lines.join("\n") });

describe("check-dependency-currency parsing", () => {
  it("reads governed dependency rows and ignores headers, separators and prose rows", () => {
    expect(parseDependencyRows(DOCUMENT)).toEqual([
      { name: "typescript", scope: "root", version: "6.0.3", disposition: "major-deferred" },
      { name: "vitest", scope: "keiko-ui", version: "4.1.11", disposition: "current" },
    ]);
  });

  it("never reads an action row as a dependency row even though both carry a disposition", () => {
    // The two tables are kept disjoint by the commit-SHA shape of the action row's third cell. If
    // that guard regressed, `actions/checkout` would be looked up as an npm package and the gate
    // would fail on a document that is entirely correct.
    const names = parseDependencyRows(DOCUMENT).map((row) => row.name);
    expect(names).not.toContain("actions/checkout");
  });

  it("reads action rows by their commit-SHA column", () => {
    expect(parseActionRows(DOCUMENT)).toEqual([
      { action: "actions/checkout", version: "v7.0.0", sha: SHA_A },
    ]);
  });
});

describe("check-dependency-currency dependency resolution", () => {
  it("prefers a workspace-local resolution over the hoisted root copy", () => {
    expect(resolveInstalledVersion(LOCK, "vitest", "keiko-ui")).toBe("4.1.11");
    expect(resolveInstalledVersion(LOCK, "vitest", "root")).toBe("4.1.10");
  });

  it("falls back to the root copy when the workspace does not override the dependency", () => {
    expect(resolveInstalledVersion(LOCK, "typescript", "keiko-ui")).toBe("6.0.3");
  });

  it("passes when every documented version matches the resolved graph", () => {
    expect(dependencyFailures(parseDependencyRows(DOCUMENT), LOCK)).toEqual([]);
  });

  it("fails on the exact drift this gate exists for: a documented version the lockfile moved past", () => {
    // The #2291 closeout regression in miniature -- the matrix said 9.39.5 while the tree resolved
    // 10.9.1 and nothing read it back.
    const rows = [{ name: "eslint", scope: "root", version: "9.39.5", disposition: "current" }];
    expect(dependencyFailures(rows, { "node_modules/eslint": { version: "10.9.1" } })).toEqual([
      "eslint (root): documented 9.39.5, lockfile resolves 10.9.1",
    ]);
  });

  it("fails closed when a documented package is absent from the resolved graph", () => {
    const rows = [{ name: "gone", scope: "root", version: "1.0.0", disposition: "current" }];
    expect(dependencyFailures(rows, {})).toEqual([
      "gone (root): documented but absent from the resolved graph",
    ]);
  });
});

describe("check-dependency-currency action pins", () => {
  const documented = [{ action: "actions/checkout", version: "v7.0.0", sha: SHA_A }];

  it("collects one entry per action repository, folding sub-action paths together", () => {
    const pins = collectWorkflowPins([
      workflow(
        "ci.yml",
        `      - uses: github/codeql-action/init@${SHA_A} # v4.37.7`,
        `      - uses: github/codeql-action/analyze@${SHA_A} # v4.37.7`,
      ),
    ]);
    expect([...pins.keys()]).toEqual(["github/codeql-action"]);
    expect(pins.get("github/codeql-action").size).toBe(1);
  });

  it("passes when the document and the workflows agree", () => {
    const pins = collectWorkflowPins([
      workflow("ci.yml", `      - uses: actions/checkout@${SHA_A} # v7.0.0`),
    ]);
    expect(actionFailures(documented, pins)).toEqual([]);
  });

  it("rejects sub-actions of one repository that have drifted onto different refs", () => {
    // Dependabot does not group an action's sub-actions, so bumping `init` without `analyze`
    // produces a version-mismatch failure at CodeQL runtime that no other gate here catches.
    const pins = collectWorkflowPins([
      workflow(
        "codeql.yml",
        `      - uses: github/codeql-action/init@${SHA_A} # v4.37.7`,
        `      - uses: github/codeql-action/analyze@${SHA_B} # v4.37.9`,
      ),
    ]);
    const failures = actionFailures(
      [{ action: "github/codeql-action", version: "v4.37.7", sha: SHA_A }],
      pins,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("must move together");
  });

  it("rejects a workflow pin that no row dispositions", () => {
    const pins = collectWorkflowPins([
      workflow("ci.yml", `      - uses: some/action@${SHA_B} # v1.0.0`),
    ]);
    expect(actionFailures([], pins)).toEqual([
      "some/action: pinned in a workflow but absent from the closeout document",
    ]);
  });

  it("rejects a documented action that no workflow pins", () => {
    expect(actionFailures(documented, new Map())).toEqual([
      "actions/checkout: documented but no workflow pins it",
    ]);
  });

  it("rejects a pin whose commit or version comment disagrees with the document", () => {
    const pins = collectWorkflowPins([
      workflow("ci.yml", `      - uses: actions/checkout@${SHA_B} # v7.0.1`),
    ]);
    const failures = actionFailures(documented, pins);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("workflows pin v7.0.1@");
  });

  it("ignores a local composite action, which has no ref to pin", () => {
    const pins = collectWorkflowPins([
      workflow("ci.yml", "      - uses: ./.github/actions/setup-sandbox-isolation"),
    ]);
    expect(pins.size).toBe(0);
  });
});

describe("check-dependency-currency entry point", () => {
  const seams = (overrides) => ({
    readDocument: () => DOCUMENT,
    readLock: () => LOCK,
    readWorkflows: () => [workflow("ci.yml", `      - uses: actions/checkout@${SHA_A} # v7.0.0`)],
    ...overrides,
  });

  it("passes on a consistent document", () => {
    expect(evaluate(seams({})).failures).toEqual([]);
    expect(main(seams({}))).toBe(0);
  });

  it("fails a document that declares no rows, rather than passing vacuously", () => {
    const { failures } = evaluate(seams({ readDocument: () => "# empty\n" }));
    expect(failures).toContain("closeout document declares no governed dependency rows");
    expect(failures).toContain("closeout document declares no GitHub Action rows");
    // The emptied document also stops dispositioning the pin the workflow still carries, and the
    // completeness check reports that too -- an empty document must never read as "nothing to say".
    expect(failures).toContain(
      "actions/checkout: pinned in a workflow but absent from the closeout document",
    );
  });

  it("fails closed when a source cannot be read", () => {
    const throwing = seams({
      readDocument: () => {
        throw new Error("missing closeout document");
      },
    });
    expect(main(throwing)).toBe(1);
  });

  it("returns a non-zero exit code when any check fails", () => {
    expect(main(seams({ readLock: () => ({}) }))).toBe(1);
  });
});
