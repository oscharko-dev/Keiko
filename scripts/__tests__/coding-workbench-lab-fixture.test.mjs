// Keeps the Coding Workbench live lab reproducible from what is checked in: the task catalog and the
// reproduction guide say the same thing, every baseline is bytes in the repository (a patch that
// applies to the fixture), the large-AGENTS.md baseline really is above the loader's cap (checked with
// the loader's own functions and constants, not with numbers copied from them), and the three
// READMEs and the drivers' messages point at files that exist and never teach a command that
// would approve silently.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  REPOSITORY_INSTRUCTIONS_MAX_BYTES,
  REPOSITORY_INSTRUCTIONS_MAX_LINES,
  boundRepositoryInstructions,
} from "../../packages/keiko-server/dist/coding-runtime/codingRuntimeRepositoryInstructions.js";
import { SECURE_WORKSPACE_TEXT_READ_MAX_BYTES } from "../../packages/keiko-server/dist/coding-runtime/secureWorkspaceTextReadProtocol.js";
import {
  LAB_COMMANDS,
  LAB_GUIDE,
  LAB_REPOSITORY_NAME,
  REPO_ROOT,
  loadTasks,
} from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  parseBaselines,
  parseExactTexts,
  parseTaskTable,
} from "./support/coding-workbench-lab-guide.mjs";

const LAB_DIRECTORY = join(REPO_ROOT, "scripts", "testing", "coding-workbench-lab");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "coding-workbench-lab");
const PATCHES = join(FIXTURE, "patches");
const GUIDE = join(REPO_ROOT, LAB_GUIDE);
const COMMANDS = join(REPO_ROOT, LAB_COMMANDS);
const FIXTURE_README = join(FIXTURE, "README.md");
const READMES = [GUIDE, COMMANDS, FIXTURE_README];
// Applying a patch and running the fixture's tests spawn a process each.
const SLOW_TEST_MS = 60_000;

const TEMP_DIRECTORIES = [];

afterEach(() => {
  while (TEMP_DIRECTORIES.length > 0) {
    rmSync(TEMP_DIRECTORIES.pop(), { recursive: true, force: true });
  }
});

const read = (path) => readFileSync(path, "utf8");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/**
 * A scratch copy of the fixture, with an optional patch applied the way the guides tell an operator
 * to: the copy is its own repository first, and the patch is applied inside it.
 */
function fixtureCopy(patch) {
  const copy = mkdtempSync(join(tmpdir(), "keiko-lab-fixture-"));
  TEMP_DIRECTORIES.push(copy);
  cpSync(join(FIXTURE, "ledger-lab"), copy, { recursive: true });
  if (patch !== undefined) {
    git(copy, "init", "-q", "-b", "main");
    git(copy, "apply", join(PATCHES, patch));
  }
  return copy;
}

/** A copy of the fixture inside the work tree of another repository, as under a dotfiles-managed $HOME. */
function enclosedCopy() {
  const enclosing = mkdtempSync(join(tmpdir(), "keiko-lab-enclosing-"));
  TEMP_DIRECTORIES.push(enclosing);
  git(enclosing, "init", "-q", "-b", "main");
  const copy = join(enclosing, "keiko-lab-ledger");
  cpSync(join(FIXTURE, "ledger-lab"), copy, { recursive: true });
  return copy;
}

/** Every file of a tree (the Git directory aside) with the digest of its bytes. */
function snapshot(root) {
  const files = readdirSync(root, { recursive: true })
    .filter((path) => !path.split(/[\\/]/u).includes(".git"))
    .filter((path) => statSync(join(root, path)).isFile())
    .toSorted();
  return Object.fromEntries(
    files.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  );
}

/** The first bash block of a README that copies the fixture out: the guide's recipe for a lab copy. */
function copyRecipe(markdown) {
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map(([, block]) => block);
  const recipe = blocks.find((block) => block.includes("ledger-lab/."));
  if (recipe === undefined) throw new Error("the README has no bash block that copies ledger-lab");
  return recipe.split("\n");
}

describe("the task catalog and the reproduction guide say the same", () => {
  const tasks = loadTasks();
  const guide = read(GUIDE);

  it("lists the same tasks, with the same fields, in the table and in the exact texts", () => {
    const table = parseTaskTable(guide);
    const exact = parseExactTexts(guide);
    const ids = tasks.map((task) => task.id).toSorted();
    expect([...table.keys()].toSorted()).toEqual(ids);
    expect([...exact.keys()].toSorted()).toEqual(ids);
    for (const task of tasks) {
      const { title, mode, baseline, textStatus, text, expected } = task;
      expect(table.get(task.id), `${task.id} in the task table`).toEqual({
        title,
        mode,
        baseline,
        textStatus,
        expected,
      });
      expect(exact.get(task.id), `${task.id} in the exact texts`).toEqual({
        title,
        mode,
        baseline,
        textStatus,
        text,
      });
    }
  });

  it("gives T13 the read-only text of C1, so the only difference between the two runs is the AGENTS.md", () => {
    const text = (id) => tasks.find((task) => task.id === id)?.text;
    expect(text("T13")).toBe(text("C1"));
    expect(tasks.find((task) => task.id === "T13")).toMatchObject({
      mode: "Ask for approval",
      baseline: "head+md",
    });
  });
});

describe("every baseline is bytes in the repository", () => {
  const guide = read(GUIDE);
  const baselines = parseBaselines(guide);

  it("names a baseline row for every baseline a task uses", () => {
    for (const task of loadTasks()) {
      expect(baselines.has(task.baseline), `${task.id} uses ${task.baseline}`).toBe(true);
    }
  });

  it("ships a patch for every baseline that is not the fixture itself, and documents every patch", () => {
    const patched = [...baselines.entries()].filter(([, patch]) => patch !== undefined);
    expect(patched.map(([name]) => name).toSorted()).toEqual(["head+md", "head+t7", "initial"]);
    for (const [, patch] of patched) {
      expect(existsSync(join(PATCHES, patch)), patch).toBe(true);
    }
    const fixtureReadme = read(FIXTURE_README);
    for (const patch of readdirSync(PATCHES).filter((name) => name.endsWith(".patch"))) {
      expect(fixtureReadme, `${patch} is not described in the fixture README`).toContain(
        `patches/${patch}`,
      );
    }
  });

  it(
    "applies every patch to the fixture as it is",
    () => {
      for (const patch of readdirSync(PATCHES).filter((name) => name.endsWith(".patch"))) {
        expect(() => fixtureCopy(patch), patch).not.toThrow();
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "keeps the lab's own tests green on the fixture and on the baselines a task starts from",
    () => {
      for (const patch of [undefined, "head-t7.patch", "head-md.patch"]) {
        const output = execFileSync(process.execPath, ["--test"], {
          cwd: fixtureCopy(patch),
          encoding: "utf8",
        });
        expect(output, String(patch)).toMatch(/# fail 0|ℹ fail 0/u);
      }
    },
    SLOW_TEST_MS,
  );

  it("marks every copy as the lab, so the drivers accept it", () => {
    const copy = fixtureCopy("head-t7.patch");
    expect(JSON.parse(read(join(copy, "package.json"))).name).toBe(LAB_REPOSITORY_NAME);
  });

  it(
    "leaves the T8 defects in place on head+t7: the reference T7 result fixes lint findings only",
    () => {
      const copy = fixtureCopy("head-t7.patch");
      expect(read(join(copy, "src", "importers", "bank-b.ts"))).toContain(
        'Number.parseFloat(input.trim().replace(",", "."))',
      );
      expect(read(join(copy, "src", "report.ts"))).toContain(
        "entry.amount > largestExpense.amount",
      );
      for (const untouched of ["eslint.config.mjs", "tsconfig.json", "package.json"]) {
        expect(read(join(copy, untouched))).toBe(read(join(FIXTURE, "ledger-lab", untouched)));
      }
    },
    SLOW_TEST_MS,
  );
});

describe("a baseline patch is applied inside the copy's own repository", () => {
  const patches = readdirSync(PATCHES).filter((name) => name.endsWith(".patch"));
  const apply = (copy, patch) => git(copy, "apply", join(PATCHES, patch));

  it(
    "applies nothing, and still succeeds, in a copy that sits in another repository's work tree and is not one itself",
    () => {
      // `git apply` ignores every path outside the repository it runs in: the failure this order of
      // the guides avoids, and the reason `git init` comes first.
      for (const patch of patches) {
        const copy = enclosedCopy();
        expect(() => apply(copy, patch), patch).not.toThrow();
        expect(snapshot(copy), patch).toEqual(snapshot(fixtureCopy()));
        expect(git(copy, "apply", "--stat", join(PATCHES, patch)), patch).toMatch(
          /0 files changed/u,
        );
        expect(
          () => git(copy, "apply", "--check", "-R", join(PATCHES, patch)),
          patch,
        ).not.toThrow();
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "applies every patch in full, in the same bytes, in a copy that is its own repository first",
    () => {
      for (const patch of patches) {
        const copy = enclosedCopy();
        git(copy, "init", "-q", "-b", "main");
        apply(copy, patch);
        expect(snapshot(copy), patch).toEqual(snapshot(fixtureCopy(patch)));
        expect(snapshot(copy), patch).not.toEqual(snapshot(fixtureCopy()));
        expect(git(copy, "apply", "--stat", join(PATCHES, patch)), patch).not.toMatch(
          /\b0 files changed/u,
        );
      }
    },
    SLOW_TEST_MS,
  );

  it.each([
    ["the lab guide", GUIDE],
    ["the fixture README", FIXTURE_README],
  ])(
    "%s initialises the copy before its first patch and stages the files after it",
    (_name, path) => {
      const lines = copyRecipe(read(path));
      const indexOf = (pattern) => lines.findIndex((line) => pattern.test(line));
      // A patch line is commented out in the recipe (the operator picks at most one, and a label may
      // precede it): it is still the command that applies a file of the patches directory.
      const init = indexOf(/^git\b.*\binit -b main\b/u);
      const firstPatch = indexOf(/\bgit\b.*\bapply\b.*\.patch\b/u);
      const stage = indexOf(/^git\b.*\badd -A\b/u);
      expect(init, "git init -b main").toBeGreaterThanOrEqual(0);
      expect(firstPatch, "the first git apply").toBeGreaterThan(init);
      expect(stage, "git add -A").toBeGreaterThan(firstPatch);
    },
  );
});

describe("the head+md baseline exercises the AGENTS.md loader's cap", () => {
  const guide = read(GUIDE);
  const fixtureReadme = read(FIXTURE_README);
  const original = read(join(FIXTURE, "ledger-lab", "AGENTS.md"));
  const largeCopy = () => read(join(fixtureCopy("head-md.patch"), "AGENTS.md"));
  const bytes = (text) => Buffer.byteLength(text, "utf8");

  it("leaves the lab's own file whole: it fits the cap", () => {
    const bounded = boundRepositoryInstructions(original);
    expect(bounded.truncated).toBe(false);
    expect(bounded.byteCount).toBe(bytes(original));
  });

  it(
    "is about 30 KiB: above the cap, under the read ceiling and under the line limit, so the byte cap is what truncates",
    () => {
      const large = largeCopy();
      expect(bytes(large)).toBeGreaterThan(REPOSITORY_INSTRUCTIONS_MAX_BYTES);
      expect(bytes(large)).toBeGreaterThan(28 * 1024);
      expect(bytes(large)).toBeLessThan(32 * 1024);
      expect(bytes(large)).toBeLessThanOrEqual(SECURE_WORKSPACE_TEXT_READ_MAX_BYTES);
      expect(large.split("\n").length).toBeLessThan(REPOSITORY_INSTRUCTIONS_MAX_LINES);
    },
    SLOW_TEST_MS,
  );

  it(
    "is attached truncated by the loader, at a line boundary within the cap",
    () => {
      const large = largeCopy();
      const bounded = boundRepositoryInstructions(large);
      expect(bounded.truncated).toBe(true);
      expect(bounded.totalByteCount).toBe(bytes(large));
      expect(bounded.byteCount).toBeLessThanOrEqual(REPOSITORY_INSTRUCTIONS_MAX_BYTES);
      expect(bounded.byteCount).toBeGreaterThan(REPOSITORY_INSTRUCTIONS_MAX_BYTES - 512);
      expect(large.startsWith(bounded.text)).toBe(true);
    },
    SLOW_TEST_MS,
  );

  it(
    "keeps the lab's rules verbatim on top, so a model reads the same rules with or without the extra text",
    () => {
      expect(largeCopy().startsWith(original)).toBe(true);
    },
    SLOW_TEST_MS,
  );

  it(
    "states its real size, and the size of the lab's own file, in the guide and in the fixture README",
    () => {
      const large = bytes(largeCopy()).toLocaleString("en-US");
      expect(guide).toContain(`${large} bytes`);
      expect(fixtureReadme).toContain(`${large} bytes`);
      expect(guide).toContain(`${String(bytes(original))} bytes`);
    },
    SLOW_TEST_MS,
  );
});

describe("the READMEs and the drivers point at files that exist", () => {
  it("resolves every relative link of the three READMEs", () => {
    for (const readme of READMES) {
      const links = [...read(readme).matchAll(/\]\(([^)\s]+)\)/gu)]
        .map(([, target]) => target)
        .filter((target) => !/^(?:https?:|mailto:|#)/u.test(target))
        .map((target) => target.split("#")[0]);
      for (const target of links) {
        expect(existsSync(resolve(dirname(readme), target)), `${readme} links ${target}`).toBe(
          true,
        );
      }
    }
  });

  it("names, in every message of the drivers, a README that exists", () => {
    expect(existsSync(GUIDE)).toBe(true);
    expect(existsSync(COMMANDS)).toBe(true);
    const mentioned = [];
    for (const file of readdirSync(LAB_DIRECTORY).filter((name) => name.endsWith(".mjs"))) {
      for (const [, path] of read(join(LAB_DIRECTORY, file)).matchAll(/([\w./-]*README\.md)/gu)) {
        mentioned.push({ file, path });
        // A bare `README.md` is the one in the drivers' own directory.
        const target = path.includes("/") ? join(REPO_ROOT, path) : join(LAB_DIRECTORY, path);
        expect(existsSync(target), `${file} says ${path}`).toBe(true);
      }
    }
    expect(mentioned.length).toBeGreaterThan(0);
  });

  it("documents every script of the lab directory in the command reference", () => {
    const commands = read(COMMANDS);
    for (const file of readdirSync(LAB_DIRECTORY).filter((name) => /\.(?:mjs|json)$/u.test(name))) {
      expect(commands, `${file} is not in the scripts table`).toContain(`\`${file}\``);
    }
  });

  it("never shows a driver command that would approve silently", () => {
    const driver = /(?:wb-ui|wb-run|chaos-suite)\.mjs/u;
    for (const readme of READMES) {
      for (const line of read(readme).split("\n")) {
        const command = line.trim().startsWith("node ") && driver.test(line);
        if (!command || /--list-tasks|--help/u.test(line)) continue;
        expect(line, `${readme}: ${line.trim()}`).toContain("--approve");
      }
    }
  });
});
