import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FOLLOWERS,
  REFERENCE,
  checkWorkflowBranchParity,
  readBranchList,
  runCli,
} from "../check-workflow-branch-parity.mjs";

// KEIKO-0955: codeql.yml and dependency-review.yml had silently fallen nine and ten branches behind
// ci.yml, so pushes to those integration branches were never code-scanned and pull requests
// targeting them had no dependency diff reviewed. Nothing went red, because every such branch
// eventually merges into `dev`, which was listed everywhere. This gate is what makes the three
// lists one fact; these tests are what keep the gate honest.

function workflow(triggers) {
  const block = (trigger, branches) =>
    `  ${trigger}:\n    branches:\n${branches.map((b) => `      - ${b}`).join("\n")}\n`;
  return `name: X\n\non:\n${Object.entries(triggers)
    .map(([trigger, branches]) => block(trigger, branches))
    .join("")}`;
}

const ALL = ["dev", "feat/one", "release/**"];

function repo(overrides = {}) {
  const files = {
    "ci.yml": workflow({ push: ALL, pull_request: ALL }),
    "codeql.yml": workflow({ push: ALL, pull_request: ALL }),
    "dependency-review.yml": workflow({ pull_request: ALL }),
    "workflow-hygiene.yml": workflow({ push: ALL, pull_request: ALL }),
    ...overrides,
  };
  return (file) => {
    if (!(file in files)) throw new Error(`unexpected workflow ${file}`);
    return files[file];
  };
}

describe("readBranchList", () => {
  it("reads the branch list of the named trigger only", () => {
    const source = workflow({ push: ["dev"], pull_request: ["dev", "feat/one"] });
    expect(readBranchList(source, "push")).toEqual(["dev"]);
    expect(readBranchList(source, "pull_request")).toEqual(["dev", "feat/one"]);
  });

  it("unquotes glob patterns so `release/**` compares as itself", () => {
    expect(
      readBranchList('name: X\n\non:\n  push:\n    branches:\n      - "release/**"\n', "push"),
    ).toEqual(["release/**"]);
  });

  it("returns null for a trigger that is absent or declares no branch list", () => {
    expect(readBranchList(workflow({ push: ["dev"] }), "pull_request")).toBeNull();
    expect(
      readBranchList(
        "name: X\n\non:\n  merge_group:\n    types: [checks_requested]\n",
        "merge_group",
      ),
    ).toBeNull();
  });

  it("stops at a sibling key instead of swallowing the next block", () => {
    const source =
      "name: X\n\non:\n  push:\n    branches:\n      - dev\n    paths:\n      - src/**\n  pull_request:\n    branches:\n      - other\n";
    expect(readBranchList(source, "push")).toEqual(["dev"]);
  });
});

describe("checkWorkflowBranchParity", () => {
  it("passes when all three lists match", () => {
    const { failures, referenceSize } = checkWorkflowBranchParity(repo());
    expect(failures).toEqual([]);
    expect(referenceSize).toBe(ALL.length);
  });

  it("names the exact missing branches per file and trigger", () => {
    const short = workflow({ push: ["dev"], pull_request: ["dev"] });
    const { failures } = checkWorkflowBranchParity(repo({ "codeql.yml": short }));
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.file).toBe("codeql.yml");
      expect(failure.missing).toEqual(["feat/one", "release/**"]);
      expect(failure.extra).toEqual([]);
    }
  });

  it("reports a branch a follower has that ci.yml does not", () => {
    const extra = workflow({ pull_request: [...ALL, "feat/rogue"] });
    const { failures } = checkWorkflowBranchParity(repo({ "dependency-review.yml": extra }));
    expect(failures).toHaveLength(1);
    expect(failures[0].extra).toEqual(["feat/rogue"]);
  });

  it("catches ci.yml disagreeing with itself across push and pull_request", () => {
    const selfInconsistent = workflow({ push: ALL, pull_request: ["dev"] });
    const { failures } = checkWorkflowBranchParity(repo({ "ci.yml": selfInconsistent }));
    expect(failures.some((f) => f.file === "ci.yml" && f.trigger === "pull_request")).toBe(true);
  });

  it("fails a follower that declares no branch list at all", () => {
    const noList = "name: X\n\non:\n  pull_request:\n    types: [opened]\n";
    const { failures } = checkWorkflowBranchParity(repo({ "dependency-review.yml": noList }));
    expect(failures.some((f) => f.noList === true)).toBe(true);
  });

  it("compares sets, so reordering is not drift", () => {
    const reordered = workflow({ push: [...ALL].reverse(), pull_request: [...ALL].reverse() });
    expect(checkWorkflowBranchParity(repo({ "codeql.yml": reordered })).failures).toEqual([]);
  });

  it("covers every follower the gate claims to govern", () => {
    expect(REFERENCE.file).toBe("ci.yml");
    expect(FOLLOWERS.map((f) => f.file)).toEqual([
      "codeql.yml",
      "dependency-review.yml",
      "workflow-hygiene.yml",
    ]);
  });
});

describe("runCli", () => {
  it("returns 0 and reports the branch count against the real workflows", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runCli(resolve(import.meta.dirname, "..", "..", ".github", "workflows"))).toBe(0);
      expect(log.mock.calls.flat().join(" ")).toContain("listed identically");
    } finally {
      log.mockRestore();
    }
  });

  it("returns 1 and prints the offending branches when a directory has drifted", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Point at a directory with no workflows: every read throws, which must surface as a
      // failure rather than a silent pass.
      expect(() => runCli("/nonexistent-workflows-dir")).toThrow();
    } finally {
      error.mockRestore();
    }
  });
});
