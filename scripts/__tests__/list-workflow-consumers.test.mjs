import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  asPattern,
  main,
  availableWorkflows,
  couplingKinds,
  isMissing,
  reportScanFailure,
  reportWorkflow,
  selectWorkflows,
  sourceFiles,
} from "../list-workflow-consumers.mjs";

// This tool exists because a workflow's consumers are invisible from the workflow itself: gates and
// suites read it by parsing, by counting, and in one case by LINE NUMBER. Its value is entirely in
// being COMPLETE and HONEST — an under-reported list that still exits 0 is worse than no list, and
// a name taken from the command line must never reach the pattern builder (CodeQL js/regex-injection).
// Both properties are pinned here.

describe("asPattern", () => {
  it("escapes every metacharacter, so a name can never act as a pattern", () => {
    expect(asPattern("ci.yml")).toBe(String.raw`ci\.yml`);
    // Without full escaping these would match far more than their literal text.
    expect(new RegExp(`^${asPattern("a+b.yml")}$`, "u").test("a+b.yml")).toBe(true);
    expect(new RegExp(`^${asPattern("a+b.yml")}$`, "u").test("aab.yml")).toBe(false);
    expect(new RegExp(`^${asPattern(".*")}$`, "u").test("anything")).toBe(false);
    expect(new RegExp(`^${asPattern(".*")}$`, "u").test(".*")).toBe(true);
  });

  it("leaves an ordinary name unchanged apart from its dots", () => {
    expect(asPattern("release-advance.yml")).toBe(String.raw`release-advance\.yml`);
  });
});

describe("isMissing", () => {
  it("recognises only an absent path, which is the one tolerable scan error", () => {
    expect(isMissing({ code: "ENOENT" })).toBe(true);
    expect(isMissing({ code: "EACCES" })).toBe(false);
    expect(isMissing({ code: "EIO" })).toBe(false);
    expect(isMissing(new Error("no code"))).toBe(false);
    expect(isMissing(undefined)).toBe(false);
    expect(isMissing(null)).toBe(false);
    expect(isMissing("ENOENT")).toBe(false);
  });
});

describe("couplingKinds", () => {
  const NAME = "ci.yml";

  it("names a LINE NUMBER reference, the coupling that breaks on any inserted line", () => {
    expect(couplingKinds("- ci.yml:604", NAME)).toContain(
      "LINE NUMBERS — shifts on any inserted line",
    );
  });

  it("names exact counts, which break on any added job", () => {
    expect(couplingKinds("expect(setups).toBe(31);", NAME)).toContain("exact counts");
    expect(couplingKinds("expect(x).toHaveLength(12);", NAME)).toContain("exact counts");
  });

  it("names YAML parsing and condition reading", () => {
    expect(couplingKinds('parseDocument(readFileSync("x"))', NAME)).toContain("parses YAML");
    expect(couplingKinds("if (job.if !== undefined) {", NAME)).toContain("reads job conditions");
  });

  it("falls back to a plain reference rather than inventing a coupling", () => {
    expect(couplingKinds("a comment mentioning the file", NAME)).toEqual(["references it"]);
  });

  it("does not report a line-number coupling for an unrelated workflow", () => {
    expect(couplingKinds("- release.yml:12", NAME)).not.toContain(
      "LINE NUMBERS — shifts on any inserted line",
    );
  });
});

describe("availableWorkflows", () => {
  it("lists the repository's real workflow files", () => {
    const found = availableWorkflows();
    expect(found).toContain("ci.yml");
    expect(found.every((name) => name.endsWith(".yml") || name.endsWith(".yaml"))).toBe(true);
  });
});

describe("selectWorkflows", () => {
  let restore;
  let errors;

  function capture() {
    const error = console.error;
    const previousExitCode = process.exitCode;
    errors = [];
    console.error = (message) => errors.push(String(message));
    restore = () => {
      console.error = error;
      process.exitCode = previousExitCode;
    };
    process.exitCode = undefined;
  }

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("returns every workflow for --all", () => {
    expect(selectWorkflows(true, [])).toEqual(availableWorkflows());
  });

  it("defaults to ci.yml when nothing is named", () => {
    expect(selectWorkflows(false, [])).toEqual(["ci.yml"]);
  });

  it("resolves a named workflow against the directory rather than trusting the argument", () => {
    expect(selectWorkflows(false, ["ci.yml"])).toEqual(["ci.yml"]);
  });

  it("refuses an unknown name, fails the run, and says what exists", () => {
    capture();
    expect(selectWorkflows(false, [".*"])).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("no such workflow: .*");
    expect(errors.join("\n")).toContain("ci.yml");
  });

  it("keeps the valid names when only one of several is unknown", () => {
    capture();
    expect(selectWorkflows(false, ["ci.yml", "nope.yml"])).toEqual(["ci.yml"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("main", () => {
  let restore;
  let out;
  let errors;

  function capture(argv) {
    const log = console.log;
    const error = console.error;
    const previousArgv = process.argv;
    const previousExitCode = process.exitCode;
    out = [];
    errors = [];
    console.log = (message) => out.push(String(message));
    console.error = (message) => errors.push(String(message));
    process.argv = ["node", "list-workflow-consumers.mjs", ...argv];
    restore = () => {
      console.log = log;
      console.error = error;
      process.argv = previousArgv;
      process.exitCode = previousExitCode;
    };
    process.exitCode = undefined;
  }

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("reports ci.yml by default, with the gate list and its repair command", () => {
    capture([]);
    main();
    const text = out.join("\n");
    expect(text).toContain("ci.yml —");
    expect(text).toContain("consumer(s)");
    // The gate list is the part a caller acts on, so its presence is pinned, not incidental.
    expect(text).toContain("Gates to run after changing any workflow");
    expect(text).toContain("npm run check:zizmor-anchors");
    expect(text).toContain("repair: npm run check:zizmor-anchors -- --fix");
    expect(text).toContain("npm run check:e2e-suite-wiring");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports every workflow under --all", () => {
    capture(["--all"]);
    main();
    const headings = out.filter((line) => line.includes("consumer(s)"));
    expect(headings).toHaveLength(availableWorkflows().length);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails on an unknown workflow instead of reporting an empty result", () => {
    capture([".*"]);
    main();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("no such workflow");
    expect(out.join("\n")).not.toContain("consumer(s)");
  });
});

describe("reportScanFailure", () => {
  let restore;
  let errors;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("reports the path and code and fails the run, so a short list is never silent", () => {
    const error = console.error;
    const previousExitCode = process.exitCode;
    errors = [];
    console.error = (message) => errors.push(String(message));
    restore = () => {
      console.error = error;
      process.exitCode = previousExitCode;
    };
    process.exitCode = undefined;

    reportScanFailure("/some/path", { code: "EACCES" });

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("EACCES");
  });
});

describe("sourceFiles", () => {
  it("finds this test file, so a traversal regression cannot pass vacuously", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith("list-workflow-consumers.test.mjs"))).toBe(true);
  });

  it("skips dependency and build directories", () => {
    expect(sourceFiles().some((file) => file.includes("/node_modules/"))).toBe(false);
  });
});

describe("reportWorkflow", () => {
  let restore;
  let out;
  let workspace;

  function capture() {
    const log = console.log;
    out = [];
    console.log = (message) => out.push(String(message));
    restore = () => {
      console.log = log;
      if (workspace !== undefined) rmSync(workspace, { force: true, recursive: true });
      workspace = undefined;
    };
  }

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("counts a file that addresses the workflow and ignores one that merely mentions it", () => {
    capture();
    workspace = mkdtempSync(join(tmpdir(), "keiko-consumers-"));
    mkdirSync(join(workspace, "nested"), { recursive: true });
    const addressing = join(workspace, "addressing.mjs");
    const mentioning = join(workspace, "nested", "mentioning.mjs");
    writeFileSync(addressing, 'read(".github/workflows/ci.yml");\n', "utf8");
    writeFileSync(mentioning, "// ci.yml is discussed here in prose only\n", "utf8");

    const count = reportWorkflow("ci.yml", [addressing, mentioning]);

    expect(count).toBe(1);
    expect(out.join("\n")).toContain("1 consumer(s)");
  });

  it("fails the run when a source file cannot be read, rather than shortening the list", () => {
    const log = console.log;
    const error = console.error;
    const previousExitCode = process.exitCode;
    const out = [];
    const errors = [];
    console.log = (message) => out.push(String(message));
    console.error = (message) => errors.push(String(message));
    process.exitCode = undefined;
    try {
      // A path that exists for the walker but cannot be read as a file: reading a DIRECTORY throws
      // EISDIR, which is precisely an "unexpected" error this tool must not swallow.
      const count = reportWorkflow("ci.yml", [join(process.cwd(), "scripts")]);
      expect(count).toBe(0);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("cannot scan");
    } finally {
      console.log = log;
      console.error = error;
      process.exitCode = previousExitCode;
    }
  });

  it("reports the repository's real ci.yml consumers", () => {
    capture();
    const count = reportWorkflow("ci.yml", sourceFiles());
    expect(count).toBeGreaterThan(20);
    expect(out.join("\n")).toContain("consumer(s)");
  });
});
