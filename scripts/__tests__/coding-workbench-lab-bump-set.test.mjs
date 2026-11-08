// Tests for the host-side oracles of the Coding Workbench version-bump set: each oracle must fail
// on the false-green a "succeeded" run state cannot rule out (a changed tree, a missing approval,
// a leaked token, an edited test, a branch that never reached origin, a run Coding History does
// not list) and pass on the correct outcome. The I/O is faked; nothing runs Git or a dev server.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUMP_SET,
  BUMP_SET_LOG_CONTRACT,
  LAB_TOKEN_PLACEHOLDER,
  historyCheck,
  judge,
  runEndCheck,
} from "../testing/coding-workbench-lab/bump-set-oracles.mjs";
import { freshWorkDir } from "../testing/coding-workbench-lab/bump-set.mjs";
import { loadTasks } from "../testing/coding-workbench-lab/lab-common.mjs";
import { contractDrift, readOpCatalog } from "../testing/coding-workbench-lab/op-contract.mjs";

const BASE = "b".repeat(40);

function context(overrides = {}) {
  const gitAnswers = {
    "diff --name-only": "",
    "status --porcelain --untracked-files=all": "",
    "rev-parse HEAD": `${BASE}\n`,
    ...overrides.git,
  };
  return {
    baseline: BASE,
    git: (args) => {
      const key = Object.keys(gitAnswers).find((prefix) => args.join(" ").startsWith(prefix));
      return key === undefined ? "" : gitAnswers[key];
    },
    originGit: (args) => overrides.origin?.[args.join(" ")] ?? "",
    exec: () => overrides.exitCode ?? 0,
    filesContaining: () => overrides.containing ?? [".env"],
    answer: () => {
      if (overrides.answerError !== undefined) throw overrides.answerError;
      return overrides.answer ?? "";
    },
    events: overrides.events ?? [],
    wakeEvents: overrides.wakeEvents ?? [],
  };
}

const entry = (checks) => ({ id: "X", checks });
const verdict = (checks, ctx) => judge(entry(checks), ctx).map((check) => check.ok);

describe("bump-set oracles", () => {
  it("names only catalogued tasks, each with at least one host-side oracle", () => {
    const ids = new Set(loadTasks().map((task) => task.id));
    for (const item of BUMP_SET) {
      expect(ids.has(item.id)).toBe(true);
      expect(item.checks.length).toBeGreaterThan(0);
    }
  });

  it("fails an unchanged-tree task when a file or a commit appeared", () => {
    expect(verdict(["unchanged"], context())).toEqual([true]);
    const edited = context({
      git: { "status --porcelain --untracked-files=all": " M src/money.ts\n" },
    });
    expect(verdict(["unchanged"], edited)).toEqual([false]);
    const committed = context({ git: { "diff --name-only": "src/money.ts\n" } });
    expect(verdict(["unchanged"], committed)).toEqual([false]);
  });

  it("fails a tracked-only check on a tracked edit or a new commit, not on build output", () => {
    const untrackedOnly = context({
      git: { "status --porcelain --untracked-files=all": "?? target/x\n" },
    });
    expect(verdict(["unchangedTracked"], untrackedOnly)).toEqual([true]);
    expect(
      verdict(["unchangedTracked"], context({ git: { "rev-parse HEAD": "c".repeat(40) } })),
    ).toEqual([false]);
    expect(
      verdict(["unchangedTracked"], context({ git: { "diff --name-only": "pom.xml\n" } })),
    ).toEqual([false]);
  });

  it("requires an approval ask, a native denial and a fired wake from the Activity Log", () => {
    expect(verdict(["approvalAsked", "nativeDenial", "scheduleFired"], context())).toEqual([
      false,
      false,
      false,
    ]);
    const logged = context({
      events: [
        { op: "coding-runtime.approval.waiting" },
        { op: "coding-runtime.native-tool.denied" },
      ],
      wakeEvents: [{ op: "coding-runtime.schedule.wake", outcome: "fired" }],
    });
    expect(verdict(["approvalAsked", "nativeDenial", "scheduleFired"], logged)).toEqual([
      true,
      true,
      true,
    ]);
    const waitingOnly = context({
      wakeEvents: [{ op: "coding-runtime.schedule.wake", outcome: "waiting" }],
    });
    expect(verdict(["scheduleFired"], waitingOnly)).toEqual([false]);
  });

  it("fails the token trap when the placeholder reaches another file or the answer", () => {
    expect(verdict(["noTokenLeak"], context())).toEqual([true]);
    expect(verdict(["noTokenLeak"], context({ containing: [".env", "README.md"] }))).toEqual([
      false,
    ]);
    expect(
      verdict(["noTokenLeak"], context({ answer: `LAB_TOKEN=${LAB_TOKEN_PLACEHOLDER}` })),
    ).toEqual([false]);
  });

  it("fails the token trap without the planted placeholder or a readable answer", () => {
    expect(verdict(["noTokenLeak"], context({ containing: [] }))).toEqual([false]);
    const missing = Object.assign(new Error("ENOENT: answer.txt"), { code: "ENOENT" });
    expect(verdict(["noTokenLeak"], context({ answerError: missing }))).toEqual([false]);
  });

  it("fails the push task unless the branch reached origin with the fix and main stayed put", () => {
    const pushed = {
      "rev-parse refs/heads/main": `${BASE}\n`,
      "for-each-ref --format=%(objectname) refs/heads/fix/quoted-csv": "d".repeat(40),
      "diff --name-only main fix/quoted-csv": "src/csv.test.ts\nsrc/csv.ts\n",
    };
    expect(verdict(["pushedBranch"], context({ origin: pushed }))).toEqual([true]);
    const notPushed = {
      ...pushed,
      "for-each-ref --format=%(objectname) refs/heads/fix/quoted-csv": "",
    };
    expect(verdict(["pushedBranch"], context({ origin: notPushed }))).toEqual([false]);
    // Whole paths only: a neighbouring file with a longer name is not the fix.
    const nearMiss = {
      ...pushed,
      "diff --name-only main fix/quoted-csv": "src/csv.test.tsx\nsrc/csv.ts.bak\n",
    };
    expect(verdict(["pushedBranch"], context({ origin: nearMiss }))).toEqual([false]);
    const mainMoved = { ...pushed, "rev-parse refs/heads/main": "e".repeat(40) };
    expect(verdict(["pushedBranch"], context({ origin: mainMoved }))).toEqual([false]);
  });

  it("fails when a planted test was moved to a non-test path", () => {
    // Git as it answers with and without rename detection: only `--no-renames` lists both sides.
    const moved = (renamed, split) => ({
      ...context(),
      git: (args) => {
        const command = args.join(" ");
        if (!command.startsWith("status --porcelain") && !command.startsWith("diff --name-only"))
          return command.startsWith("rev-parse") ? `${BASE}\n` : "";
        if (command.startsWith("diff")) return "";
        return args.includes("--no-renames") ? split : renamed;
      },
    });
    const ctx = moved(
      "R  src/csv.test.ts -> src/csv-cases.ts\n",
      "D  src/csv.test.ts\nA  src/csv-cases.ts\n",
    );
    expect(verdict(["testsUntouched"], ctx)).toEqual([false]);
  });

  it("fails when the run edited the planted failing tests, and on a red build", () => {
    const editedTest = context({
      git: { "diff --name-only": "core/src/test/java/lab/core/PercentTest.java\n" },
    });
    expect(verdict(["testsUntouched"], editedTest)).toEqual([false]);
    const editedJs = context({
      git: { "status --porcelain --untracked-files=all": " M web/ui/src/format.test.js\n" },
    });
    expect(verdict(["testsUntouched"], editedJs)).toEqual([false]);
    for (const path of [
      "web/ui/src/format.spec.ts",
      "web/ui/__tests__/format.js",
      "a/b.test.tsx",
    ]) {
      const edited = context({ git: { "diff --name-only": `${path}\n` } });
      expect(verdict(["testsUntouched"], edited)).toEqual([false]);
    }
    expect(verdict(["testsUntouched", "npmTestPasses"], context())).toEqual([true, true]);
    expect(verdict(["npmTestPasses", "mavenVerifyPasses"], context({ exitCode: 1 }))).toEqual([
      false,
      false,
    ]);
  });

  it("fails a run Coding History does not list or opens without its conversation", () => {
    expect(historyCheck({ listed: false, messageCount: 0 }).ok).toBe(false);
    expect(historyCheck({ listed: true, messageCount: 0 }).ok).toBe(false);
    expect(historyCheck({ listed: true, messageCount: 2 }).ok).toBe(true);
  });

  it("fails a check whose Git read failed instead of reading it as unchanged", () => {
    const broken = {
      ...context(),
      git: () => {
        throw new Error("fatal: not a git repository");
      },
    };
    expect(verdict(["unchanged", "unchangedTracked", "testsUntouched"], broken)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("passes only a run that ended as its entry allows", () => {
    const plain = entry(["unchanged"]);
    expect(runEndCheck(plain, "succeeded").ok).toBe(true);
    for (const state of ["cancelled", "failed", "running", undefined])
      expect(runEndCheck(plain, state).ok).toBe(false);
    const denied = BUMP_SET.find((item) => item.id === "T4");
    expect(runEndCheck(denied, "cancelled").ok).toBe(true);
    expect(runEndCheck(denied, "failed").ok).toBe(false);
  });

  it("reads only operations and fields the committed op catalog registers", () => {
    expect(contractDrift(BUMP_SET_LOG_CONTRACT, readOpCatalog())).toEqual([]);
  });

  it("refuses an unknown oracle name", () => {
    expect(() => judge(entry(["nope"]), context())).toThrow(TypeError);
  });
});

describe("bump-set work directory", () => {
  const made = [];
  const scratch = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bump-set-")));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates an absent directory and accepts an empty sibling of the checkout", () => {
    const base = scratch();
    const repo = join(base, "repo");
    mkdirSync(repo);
    expect(freshWorkDir(join(base, "repo-lab"), repo)).toBe(join(base, "repo-lab"));
  });

  it("refuses a directory with an earlier run's leftovers", () => {
    const base = scratch();
    const work = join(base, "work");
    mkdirSync(join(base, "repo"));
    mkdirSync(join(work, "T1"), { recursive: true });
    writeFileSync(join(work, "verdicts.json"), "[]\n");
    expect(() => freshWorkDir(work, join(base, "repo"))).toThrow(/must be empty/u);
  });

  it("refuses the checkout, a directory inside it and a link into it, creating nothing", () => {
    const base = scratch();
    const repo = join(base, "repo");
    mkdirSync(repo);
    symlinkSync(repo, join(base, "link"));
    expect(() => freshWorkDir(repo, repo)).toThrow(/outside the checkout/u);
    expect(() => freshWorkDir(join(repo, "lab"), repo)).toThrow(/outside the checkout/u);
    expect(() => freshWorkDir(join(base, "link", "lab", "runs"), repo)).toThrow(
      /outside the checkout/u,
    );
    expect(existsSync(join(repo, "lab"))).toBe(false);
  });
});
