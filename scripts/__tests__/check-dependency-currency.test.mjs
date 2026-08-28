import { describe, expect, it } from "vitest";

import {
  actionFailures,
  defaultSeams,
  malformedActionRows,
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
  "packages/keiko-ui": {
    dependencies: { typescript: "6.0.3" },
    devDependencies: { vitest: "4.1.11" },
  },
  "node_modules/typescript": { version: "6.0.3" },
  "node_modules/vitest": { version: "4.1.10" },
  "packages/keiko-ui/node_modules/vitest": { version: "4.1.11" },
};

// Fixtures are real workflow documents now that the gate parses YAML rather than scanning lines:
// a fixture that fed the parser something it could never see in `.github/workflows` would stop
// exercising the code under test.
const workflow = (name, ...stepLines) => ({
  name,
  text: ["jobs:", "  a:", "    steps:", ...stepLines.map((line) => `      ${line.trim()}`)].join(
    "\n",
  ),
});

const rawWorkflow = (name, text) => ({ name, text });

describe("check-dependency-currency parsing", () => {
  it("reads governed dependency rows and ignores headers, separators and prose rows", () => {
    expect(parseDependencyRows(DOCUMENT)).toEqual([
      { name: "typescript", scope: "root", version: "6.0.3", disposition: "major-deferred" },
      { name: "vitest", scope: "keiko-ui", version: "4.1.11", disposition: "current" },
    ]);
  });

  it("reads a row that omits its optional trailing pipe, which GFM permits", () => {
    // The obvious `split("|").slice(1, -1)` discards the LAST cell of such a row rather than an
    // empty segment. A four-column row then reads as three, drops below the schema check, and
    // leaves enforcement silent — indistinguishable from agreement.
    const row = "| `eslint` | root | 9.39.5 | current | no trailing pipe";
    expect(parseDependencyRows(row)).toEqual([
      { name: "eslint", scope: "root", version: "9.39.5", disposition: "current" },
    ]);
  });

  it("ignores a row inside a fenced code block, which is an illustration and not a decision", () => {
    // This document shows example rows. In a record whose purpose is holding decisions, an example
    // must never become one.
    const fenced = ["```markdown", "| `ghost` | root | 1.0.0 | current | example |", "```"].join(
      "\n",
    );
    expect(parseDependencyRows(fenced)).toEqual([]);
    expect(
      parseActionRows(["```", `| \`a/b\` | v1 | ${SHA_A} | current |`, "```"].join("\n")),
    ).toEqual([]);
  });

  it("never reads an action row as a dependency row even though both carry a disposition", () => {
    // The two tables are kept disjoint by the commit-SHA shape of the action row's third cell. If
    // that guard regressed, `actions/checkout` would be looked up as an npm package and the gate
    // would fail on a document that is entirely correct.
    const names = parseDependencyRows(DOCUMENT).map((row) => row.name);
    expect(names).not.toContain("actions/checkout");
  });

  it("reads action rows by their commit-SHA column, disposition included", () => {
    expect(parseActionRows(DOCUMENT)).toEqual([
      { action: "actions/checkout", version: "v7.0.0", sha: SHA_A, disposition: "current" },
    ]);
  });

  it("rejects an action row whose reviewed disposition was deleted or mistyped", () => {
    // The decision record is the artifact being enforced, not just the pin. Accepting a row on its
    // SHA alone let the disposition be replaced with prose while the gate stayed green.
    const typo = DOCUMENT.replace(`${SHA_A} | current |`, `${SHA_A} | currrent |`);
    expect(parseActionRows(typo)).toEqual([]);
    expect(malformedActionRows(typo)).toEqual(["actions/checkout"]);
    expect(malformedActionRows(DOCUMENT)).toEqual([]);
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

  it("refuses the hoisted copy for a workspace that no longer declares the dependency", () => {
    // Otherwise a row outlives its own subject: drop the dependency from this workspace while
    // another keeps the same hoisted version, and the stale disposition passes forever.
    const dropped = { ...LOCK, "packages/keiko-ui": { dependencies: {}, devDependencies: {} } };
    expect(resolveInstalledVersion(dropped, "typescript", "keiko-ui")).toBeUndefined();
  });

  it("refuses a scope that is not a workspace at all, so a typo fails closed", () => {
    expect(resolveInstalledVersion(LOCK, "typescript", "keiko-uii")).toBeUndefined();
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
    const { pins } = collectWorkflowPins([
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
    const { pins } = collectWorkflowPins([
      workflow("ci.yml", `      - uses: actions/checkout@${SHA_A} # v7.0.0`),
    ]);
    expect(actionFailures(documented, pins)).toEqual([]);
  });

  it("rejects sub-actions of one repository that have drifted onto different refs", () => {
    // Dependabot does not group an action's sub-actions, so bumping `init` without `analyze`
    // produces a version-mismatch failure at CodeQL runtime that no other gate here catches.
    const { pins } = collectWorkflowPins([
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
    const { pins } = collectWorkflowPins([
      workflow("ci.yml", `      - uses: some/action@${SHA_B} # v1.0.0`),
    ]);
    expect(actionFailures([], pins)).toEqual([
      "some/action: pinned in a workflow but absent from the closeout document",
    ]);
  });

  it("rejects an action documented twice, instead of silently keeping the last row", () => {
    // A second row appended anywhere later would otherwise override the reviewed one and bless
    // whatever the workflows currently pin — last-write-wins over a decision record.
    const rows = [
      { action: "actions/checkout", version: "v7.0.0", sha: SHA_A, disposition: "current" },
      { action: "actions/checkout", version: "vEVIL", sha: SHA_B, disposition: "current" },
    ];
    const pins = collectWorkflowPins([
      workflow("ci.yml", `- uses: actions/checkout@${SHA_B} # vEVIL`),
    ]).pins;
    const failures = actionFailures(rows, pins);
    expect(failures.some((failure) => failure.includes("documented 2 times"))).toBe(true);
  });

  it("keeps each step's own version comment instead of the first textual match in the file", () => {
    // Two steps pinning the same action with different comments must not collapse to whichever
    // appears earlier: that reports agreement over a file that literally disagrees.
    const { pins } = collectWorkflowPins([
      workflow(
        "ci.yml",
        `- uses: actions/checkout@${SHA_A} # v7.0.0`,
        `- uses: actions/checkout@${SHA_A} # v9.9.9`,
      ),
    ]);
    expect(pins.get("actions/checkout").size).toBe(2);
  });

  it("rejects a documented action that no workflow pins", () => {
    expect(actionFailures(documented, new Map())).toEqual([
      "actions/checkout: documented but no workflow pins it",
    ]);
  });

  it("rejects a pin whose commit or version comment disagrees with the document", () => {
    const { pins } = collectWorkflowPins([
      workflow("ci.yml", `      - uses: actions/checkout@${SHA_B} # v7.0.1`),
    ]);
    const failures = actionFailures(documented, pins);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("workflows pin v7.0.1@");
  });

  it("ignores a pinned reference that is not an executed step", () => {
    // Raw-text scanning counted a pin inside a comment or a run script. A documented row could then
    // stay green on an action no workflow executes — the completeness check inverted.
    const { pins } = collectWorkflowPins([
      rawWorkflow(
        "ci.yml",
        [
          "jobs:",
          "  a:",
          "    steps:",
          `      # historical: uses: some/action@${SHA_B} # v1.0.0`,
          "      - run: |",
          `          echo "uses: other/action@${SHA_B} # v2.0.0"`,
        ].join("\n"),
      ),
    ]);
    expect(pins.size).toBe(0);
  });

  it("reports an external action that is not pinned to a commit SHA", () => {
    // Skipping what it cannot classify would make the gate easiest to pass by writing something it
    // does not recognise — and a `@v4` or `@main` reference is exactly the mutable third-party code
    // the pinning policy forbids.
    const { pins, mutableReferences } = collectWorkflowPins([
      workflow("ci.yml", "- uses: some/action@v4", "- uses: other/action@main"),
    ]);
    expect(pins.size).toBe(0);
    expect(mutableReferences).toHaveLength(2);
    expect(mutableReferences[0]).toContain("not pinned to a 40-character commit SHA");
  });

  it("ignores a local composite action, which has no ref to pin", () => {
    const { pins } = collectWorkflowPins([
      workflow("ci.yml", "      - uses: ./.github/actions/setup-sandbox-isolation"),
    ]);
    expect(pins.size).toBe(0);
  });
});

describe("check-dependency-currency default seams", () => {
  it("walks the real workflow directories and finds the pins this repository actually uses", () => {
    // The seam is where a wrong path constant hides: parsing and comparison can all be correct
    // while the gate silently reads nothing. A zero-pin result must never look like agreement.
    const { pins } = collectWorkflowPins(defaultSeams().readWorkflows());
    expect(pins.size).toBeGreaterThanOrEqual(10);
    expect([...pins.keys()]).toContain("actions/checkout");
  });

  it("reads the committed closeout document and lockfile", () => {
    const seams = defaultSeams();
    expect(parseDependencyRows(seams.readDocument()).length).toBeGreaterThan(0);
    expect(seams.readLock()["node_modules/typescript"]?.version).toBeDefined();
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
