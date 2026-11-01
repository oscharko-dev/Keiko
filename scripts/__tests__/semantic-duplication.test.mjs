import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  introducedGroupLocations,
  main,
  SEMANTIC_DUPLICATION_CONFIG,
  semanticDuplicationEnvironment,
  validateSemanticDuplicationReport,
} from "../check-semantic-duplication.mjs";
import { resolveHostExecutable } from "../lib/host-executable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function report(introduced = 0, inherited = 0) {
  const group = (isNew) => ({
    introduced: isNew,
    token_count: 100,
    line_count: 10,
    instances: [{}, {}],
  });
  return {
    kind: "audit",
    command: "audit",
    schema_version: 13,
    version: "3.35.0",
    verdict: "warn",
    base_ref: BASE,
    head_sha: HEAD.slice(0, 7),
    changed_files_count: 1,
    summary: {
      dead_code_skipped: true,
      complexity_skipped: true,
      duplication_clone_groups: introduced + inherited,
    },
    attribution: {
      gate: "new-only",
      duplication_introduced: introduced,
      duplication_inherited: inherited,
    },
    duplication: {
      clone_groups: [
        ...Array.from({ length: introduced }, () => group(true)),
        ...Array.from({ length: inherited }, () => group(false)),
      ],
    },
  };
}

function temporary(action) {
  const root = mkdtempSync(join(tmpdir(), "keiko-semantic-duplication-"));
  try {
    writeFileSync(join(root, ".fallowrc.json"), JSON.stringify(SEMANTIC_DUPLICATION_CONFIG));
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mockedRun(root, value = report(), fail = false) {
  const execute = vi.fn((_command, args) => {
    if (fail) throw new Error("private child diagnostic");
    if (args[0] === "rev-parse") return args.includes("--end-of-options") ? BASE : HEAD;
    if (args[0] === "merge-base") return args.includes("--is-ancestor") ? "" : BASE;
    if (args[0] === "cat-file") return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  const log = vi.fn();
  const error = vi.fn();
  const exit = main(["--changed-since", BASE], { repoRoot: root, execute, log, error });
  return { exit, execute, log, error };
}

describe("introduced semantic duplication gate", () => {
  it("permits inherited groups and independently rejects introduced WARN groups", () => {
    temporary((root) => {
      expect(mockedRun(root, report(0, 2)).exit).toBe(0);
      expect(mockedRun(root, report(1, 2)).exit).toBe(1);
      const run = mockedRun(root);
      expect(run.execute.mock.calls.find((call) => call[1][0].endsWith("/fallow"))[1]).toEqual([
        join(root, "node_modules/fallow/bin/fallow"),
        "audit",
        "--only",
        "dupes",
        "--gate",
        "new-only",
        "--format",
        "json",
        "--config",
        join(root, ".fallowrc.json"),
        "--base",
        BASE,
      ]);
    });
  });

  it.each([
    (value) => {
      value.schema_version = 7;
    },
    (value) => {
      value.version = "3.9.1";
    },
    (value) => {
      value.kind = "dupes";
    },
    (value) => {
      value.command = "dupes";
    },
    (value) => {
      value.base_ref = "origin/dev";
    },
    (value) => {
      value.head_sha = "c".repeat(7);
    },
    (value) => {
      value.verdict = "fail";
    },
    (value) => {
      value.changed_files_count = -1;
    },
    (value) => {
      value.base_snapshot_skipped = "false";
    },
    (value) => {
      value.summary.duplication_skipped = true;
    },
    (value) => {
      delete value.summary.dead_code_skipped;
    },
    (value) => {
      value.attribution.gate = "all";
    },
    (value) => {
      value.attribution.duplication_introduced = -1;
    },
    (value) => {
      value.attribution.duplication_introduced = 0.5;
    },
    (value) => {
      value.attribution.duplication_inherited = Number.MAX_SAFE_INTEGER + 1;
    },
    (value) => {
      delete value.attribution;
    },
    (value) => {
      delete value.duplication;
    },
    (value) => {
      value.summary.duplication_clone_groups = 1;
    },
  ])("fails closed on malformed, incomplete, or mismatched evidence %s", (mutate) => {
    const value = report();
    mutate(value);
    expect(() => validateSemanticDuplicationReport(value, BASE, HEAD)).toThrow();
  });

  it("allows repeated native attribution keys while checking every reported group", () => {
    const value = report(0, 2);
    value.attribution.duplication_inherited = 1;
    expect(validateSemanticDuplicationReport(value, BASE, HEAD)).toBe(0);
  });

  it("removes ambient repository, index, configuration, and Fallow overrides", () => {
    const env = semanticDuplicationEnvironment({
      PATH: "kept",
      GIT_DIR: "foreign",
      GIT_WORK_TREE: "foreign",
      GIT_INDEX_FILE: "foreign",
      GIT_COMMON_DIR: "foreign",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "foreign",
      FALLOW_AUDIT_BASE: "foreign",
      git_dir: "foreign",
    });
    expect(env).toMatchObject({
      PATH: "kept",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "FALLOW_AUDIT_BASE",
      "git_dir",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("resolves a supported ref once and passes only the immutable range to native analysis", () => {
    temporary((root) => {
      const run = mockedRun(root);
      expect(run.exit).toBe(0);
      const execute = run.execute;
      execute.mockClear();
      expect(
        main(["--changed-since", "origin/dev"], {
          repoRoot: root,
          execute,
          log: vi.fn(),
          error: vi.fn(),
        }),
      ).toBe(0);
      expect(
        execute.mock.calls.filter((call) => call[1].includes("--end-of-options")),
      ).toHaveLength(1);
      expect(execute.mock.calls.find((call) => call[1].includes("--end-of-options"))[1]).toEqual([
        "rev-parse",
        "--verify",
        "--end-of-options",
        "origin/dev^{commit}",
      ]);
      expect(execute.mock.calls.find((call) => call[1][0].endsWith("/fallow"))[1].at(-1)).toBe(
        BASE,
      );
    });
  });

  it("requires every clone attribution and the complete aggregate", () => {
    const value = report(0, 1);
    delete value.duplication.clone_groups[0].introduced;
    expect(() => validateSemanticDuplicationReport(value, BASE, HEAD)).toThrow();
    const inconsistent = report(0, 1);
    inconsistent.duplication.clone_groups[0].introduced = true;
    expect(() => validateSemanticDuplicationReport(inconsistent, BASE, HEAD)).toThrow();
  });

  it.each([
    (group) => {
      group.introduced = "false";
    },
    (group) => {
      group.token_count = 99;
    },
    (group) => {
      group.line_count = 9;
    },
    (group) => {
      group.instances = [{}];
    },
  ])("rejects malformed clone groups %s", (mutate) => {
    const value = report(0, 1);
    mutate(value.duplication.clone_groups[0]);
    expect(() => validateSemanticDuplicationReport(value, BASE, HEAD)).toThrow();
  });

  it("rejects head and configuration changes during analysis", () => {
    temporary((root) => {
      let headReads = 0;
      const execute = vi.fn((_command, args) => {
        if (args[0] === "rev-parse")
          return args.includes("--end-of-options") ? BASE : headReads++ === 0 ? HEAD : BASE;
        if (args[0] === "merge-base") return args.includes("--is-ancestor") ? "" : BASE;
        if (args[0] === "cat-file") return "";
        return JSON.stringify(report());
      });
      expect(main(["--changed-since", BASE], { repoRoot: root, execute, error: vi.fn() })).toBe(1);
      execute.mockImplementation((_command, args) => {
        if (args[0] === "rev-parse") return args.includes("--end-of-options") ? BASE : HEAD;
        if (args[0] === "merge-base") return args.includes("--is-ancestor") ? "" : BASE;
        if (args[0] === "cat-file") return "";
        writeFileSync(join(root, ".fallowrc.json"), "{}");
        return JSON.stringify(report());
      });
      expect(main(["--changed-since", BASE], { repoRoot: root, execute, error: vi.fn() })).toBe(1);
    });
  });

  it("accepts native token-equivalent base reuse and the native empty changeset", () => {
    const reused = report(0, 1);
    reused.base_snapshot_skipped = true;
    expect(validateSemanticDuplicationReport(reused, BASE, HEAD)).toBe(0);
    const empty = report();
    empty.changed_files_count = 0;
    delete empty.duplication;
    expect(validateSemanticDuplicationReport(empty, BASE, HEAD)).toBe(0);
  });

  it("names every introduced group by its instance locations and none of the inherited ones", () => {
    temporary((root) => {
      const value = report(1, 1);
      value.duplication.clone_groups[0].instances = [
        { file: "src/first.ts", start_line: 3, end_line: 14 },
        { file: "src/second.ts", start_line: 20, end_line: 31 },
      ];
      value.duplication.clone_groups[1].instances = [
        { file: "src/old.ts", start_line: 1, end_line: 12 },
        { file: "src/older.ts", start_line: 1, end_line: 12 },
      ];
      expect(introducedGroupLocations(value)).toEqual(["src/first.ts:3-14 | src/second.ts:20-31"]);
      const run = mockedRun(root, value);
      expect(run.exit).toBe(1);
      expect(run.error.mock.calls.flat()).toEqual([
        "semantic-duplication: FAIL — 1 introduced clone groups",
        "  introduced clone group: src/first.ts:3-14 | src/second.ts:20-31",
      ]);
    });
  });

  it("names the closed check that refused the evidence, and only that check", () => {
    temporary((root) => {
      const stale = report();
      stale.version = "3.9.1";
      expect(mockedRun(root, stale).error.mock.calls.flat()).toEqual([
        "semantic-duplication: FAIL — unsupported audit protocol",
      ]);
      expect(mockedRun(root, report(), true).error.mock.calls.flat()).toEqual([
        "semantic-duplication: FAIL — invalid range, configuration, or analysis evidence",
      ]);
    });
  });

  it("rejects unknown options, malformed JSON, child failure, and configuration drift", () => {
    temporary((root) => {
      const error = vi.fn();
      for (const args of [[], ["--changed-since", ""], ["--changed-since", BASE, "--skip"]]) {
        expect(main(args, { repoRoot: root, error })).toBe(1);
      }
      expect(mockedRun(root, "{").exit).toBe(1);
      const failed = mockedRun(root, report(), true);
      expect(failed.exit).toBe(1);
      expect(JSON.stringify(failed.error.mock.calls)).not.toContain("private child diagnostic");
      writeFileSync(join(root, ".fallowrc.json"), '{"duplicates":{"mode":"mild"}}');
      expect(mockedRun(root).exit).toBe(1);
    });
  });
});

const clone = (name) => `export function ${name}(input) {
  const values = Array.from(input);
  if (values.length === 0) return { total: 0, result: [] };
  let total = 0;
  const result = [];
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value)) throw new TypeError("invalid input");
    const weighted = value * (index + 1);
    switch (index % 3) {
      case 0: total += weighted; break;
      case 1: total -= weighted / 2; break;
      default: total += Math.abs(weighted); break;
    }
    if (total > 1000) {
      result.push({ index, total, overflow: true });
    } else {
      result.unshift({ index, total, overflow: false });
    }
  }
  const ordered = result.sort((left, right) => left.index - right.index);
  return { total: Math.round(total), result: ordered.filter((entry) => entry.total !== 0) };
}
`;

function fixtureGit(root, args) {
  return execFileSync(
    resolveHostExecutable("git"),
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=.fixture-hooks",
      "-c",
      "user.name=Keiko fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...semanticDuplicationEnvironment(),
        GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();
}

function commit(root) {
  fixtureGit(root, ["add", "."]);
  fixtureGit(root, ["commit", "-m", "fixture"]);
  return fixtureGit(root, ["rev-parse", "HEAD"]);
}

function nativeGate(root, base, env = process.env) {
  const log = vi.fn();
  const error = vi.fn();
  const exit = main(["--changed-since", base], { repoRoot: root, env, log, error });
  return { exit, diagnostic: error.mock.calls.flat().join("\n") };
}

describe("actual native Fallow new-only attribution", () => {
  it("distinguishes inherited, second, and third instances, deletion and moves", () => {
    temporary((root) => {
      mkdirSync(join(root, ".fixture-hooks"));
      writeFileSync(join(root, "empty-git-config"), "");
      writeFileSync(join(root, "package.json"), '{"name":"semantic-fixture","private":true}');
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.fallow/\n");
      fixtureGit(root, ["init"]);
      writeFileSync(join(root, "first.js"), clone("first"));
      const single = commit(root);
      mkdirSync(join(root, "node_modules"));
      symlinkSync(
        join(REPO_ROOT, "node_modules/fallow"),
        join(root, "node_modules/fallow"),
        "junction",
      );
      writeFileSync(join(root, "second.js"), clone("second"));
      const pair = commit(root);
      fixtureGit(root, ["branch", "reference-base", pair]);
      const second = nativeGate(root, single);
      expect(second.exit).toBe(1);
      expect(second.diagnostic).toMatch(/FAIL — [1-9]\d* introduced clone groups/u);
      expect(nativeGate(root, pair).exit).toBe(0);
      writeFileSync(join(root, "README.md"), "unrelated documentation\n");
      commit(root);
      expect(nativeGate(root, pair).exit).toBe(0);
      expect(nativeGate(root, "reference-base").exit).toBe(0);
      writeFileSync(join(root, "first.js"), `${clone("first")}\n// unchanged token stream\n`);
      commit(root);
      expect(nativeGate(root, pair).exit).toBe(0);
      writeFileSync(join(root, "first.js"), `${clone("first")}\n${clone("third")}`);
      const triple = commit(root);
      const third = nativeGate(root, pair);
      expect(third.exit).toBe(1);
      expect(third.diagnostic).toMatch(/FAIL — [1-9]\d* introduced clone groups/u);
      renameSync(join(root, "second.js"), join(root, "moved.js"));
      const moved = commit(root);
      expect(nativeGate(root, triple).exit).toBe(0);
      rmSync(join(root, "moved.js"));
      commit(root);
      expect(nativeGate(root, moved).exit).toBe(0);
      const missingBase = nativeGate(root, "f".repeat(40));
      expect(missingBase.exit).toBe(1);
      expect(missingBase.diagnostic).toContain(
        "semantic-duplication: FAIL — analysis command failed",
      );
    });
  }, 120_000);

  it("separates distinct string tables while retaining semantic copy rejection", () => {
    temporary((root) => {
      mkdirSync(join(root, ".fixture-hooks"));
      writeFileSync(join(root, "empty-git-config"), "");
      writeFileSync(join(root, "package.json"), '{"name":"literal-fixture","private":true}');
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.fallow/\n");
      fixtureGit(root, ["init"]);
      const table = (name, domain) =>
        `export const ${name} = new Map([\n${Array.from(
          { length: 30 },
          (_, index) => `  ["${domain}-key-${index}", "${domain}-value-${index}"],`,
        ).join("\n")}\n]);\n`;
      writeFileSync(join(root, "first.js"), table("mimeTypes", "mime"));
      const base = commit(root);
      mkdirSync(join(root, "node_modules"));
      symlinkSync(
        join(REPO_ROOT, "node_modules/fallow"),
        join(root, "node_modules/fallow"),
        "junction",
      );
      writeFileSync(join(root, "second.js"), table("journeyPhases", "journey"));
      const different = commit(root);
      expect(nativeGate(root, base).exit).toBe(0);
      writeFileSync(join(root, "second.js"), table("copiedMimeTypes", "mime"));
      commit(root);
      const literalCopy = nativeGate(root, different);
      expect(literalCopy.exit).toBe(1);
      expect(literalCopy.diagnostic).toMatch(/FAIL — [1-9]\d* introduced clone groups/u);
      rmSync(join(root, "second.js"));
      writeFileSync(join(root, "algorithm.js"), clone("firstAlgorithm"));
      const algorithmBase = commit(root);
      const renamed = clone("secondAlgorithm")
        .replaceAll("total", "aggregate")
        .replace("1000", "2000");
      writeFileSync(join(root, "renamed.js"), renamed);
      commit(root);
      const algorithmCopy = nativeGate(root, algorithmBase);
      expect(algorithmCopy.exit).toBe(1);
      expect(algorithmCopy.diagnostic).toMatch(/FAIL — [1-9]\d* introduced clone groups/u);
    });
  }, 120_000);

  it("leaves a foreign repository index untouched under hostile ambient Git variables", () => {
    temporary((root) =>
      temporary((foreign) => {
        for (const repo of [root, foreign]) {
          mkdirSync(join(repo, ".fixture-hooks"));
          writeFileSync(join(repo, "empty-git-config"), "");
          writeFileSync(join(repo, "package.json"), '{"name":"isolated-fixture","private":true}');
          writeFileSync(join(repo, ".gitignore"), "node_modules/\n.fallow/\n");
          fixtureGit(repo, ["init"]);
          writeFileSync(join(repo, "first.js"), clone(repo === foreign ? "foreignOnly" : "first"));
          commit(repo);
        }
        mkdirSync(join(root, "node_modules"));
        symlinkSync(
          join(REPO_ROOT, "node_modules/fallow"),
          join(root, "node_modules/fallow"),
          "junction",
        );
        const base = fixtureGit(root, ["rev-parse", "HEAD"]);
        const index = join(foreign, ".git/index");
        const before = readFileSync(index);
        const foreignHead = fixtureGit(foreign, ["rev-parse", "HEAD"]);
        expect(
          nativeGate(root, base, {
            ...process.env,
            GIT_DIR: join(foreign, ".git"),
            GIT_WORK_TREE: foreign,
            GIT_INDEX_FILE: index,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.worktree",
            GIT_CONFIG_VALUE_0: foreign,
          }).exit,
        ).toBe(0);
        expect(readFileSync(index)).toEqual(before);
        expect(fixtureGit(foreign, ["rev-parse", "HEAD"])).toBe(foreignHead);
      }),
    );
  }, 60_000);

  it("runs the actual wrapper CLI and rejects unknown flags before native analysis", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { spawnSync } from 'node:child_process';
       const result = spawnSync(process.execPath, [process.argv[1], '--changed-since', 'origin/dev', '--skip']);
       if (result.status !== 1 || !result.stderr.toString().includes('semantic-duplication: FAIL')) process.exit(1);`,
        join(REPO_ROOT, "scripts/check-semantic-duplication.mjs"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(output).toBe("");
    expect(JSON.parse(readFileSync(join(REPO_ROOT, ".fallowrc.json"), "utf8"))).toEqual(
      SEMANTIC_DUPLICATION_CONFIG,
    );
  });
});

function writeClone(root, path, name) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, clone(name));
}

function prepareNativeFixture(root) {
  mkdirSync(join(root, ".fixture-hooks"));
  writeFileSync(join(root, "empty-git-config"), "");
  writeFileSync(join(root, "package.json"), '{"name":"strict-baseline-fixture","private":true}');
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.fallow/\n");
  fixtureGit(root, ["init"]);
  mkdirSync(join(root, "node_modules"));
  symlinkSync(
    join(REPO_ROOT, "node_modules/fallow"),
    join(root, "node_modules/fallow"),
    "junction",
  );
}

describe("strict coverage of generated and catalog sources", () => {
  it.each([
    ["entry.ts", "copy.generated.ts"],
    ["entry.js", "copy.generated.js"],
    ["entry.mjs", "copy.generated.mjs"],
    ["entry.ts", "packages/keiko-ui/src/lib/i18n-messages.en.ts"],
    ["entry.ts", "packages/keiko-ui/src/feature/view-i18n.de.ts"],
    ["entry.ts", "packages/keiko-contracts/src/activity-log-failure-class-contracts.ts"],
    ["entry.mjs", "scripts/lib/activity-log-failure-surfaces.mjs"],
  ])(
    "retains strict clone coverage for %s and %s",
    (first, second) => {
      temporary((root) => {
        prepareNativeFixture(root);
        writeClone(root, first, "first");
        const base = commit(root);
        writeClone(root, second, "second");
        commit(root);
        const refusal = nativeGate(root, base);
        expect(refusal.exit).toBe(1);
        expect(refusal.diagnostic).toMatch(/FAIL — [1-9]\d* introduced clone groups/u);
      });
    },
    60_000,
  );
});
