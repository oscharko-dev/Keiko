import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { anchorFailures, main, parseAnchors } from "../check-zizmor-anchors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG = `rules:
  cache-poisoning:
    ignore:
      # a comment that must not be read as an anchor
      - ci.yml:3
      - other.yml:1
  misfeature:
    ignore:
      - ci.yml:4
  adhoc-packages:
    ignore:
      - ci.yml:6
  ref-version-mismatch:
    ignore:
      - ci.yml:7
`;

const CI = [
  "jobs:",
  "  a:",
  "      uses: actions/cache@abc # v6",
  "        shell: cmd",
  "      run: echo",
  "      run: npm install --global npm@11.16.0",
  "      uses: oscharko-dev/Keiko/.github/actions/verify-ci-merge-candidate@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # gate-snapshot-1",
].join("\n");
const OTHER = ["      uses: actions/cache@abc # v6"].join("\n");

const read = (file) => ({ "ci.yml": CI, "other.yml": OTHER })[file];

describe("zizmor ignore anchors", () => {
  it("reads every anchor with the rule it belongs to, and nothing else", () => {
    expect(parseAnchors(CONFIG)).toEqual([
      { rule: "cache-poisoning", file: "ci.yml", line: 3 },
      { rule: "cache-poisoning", file: "other.yml", line: 1 },
      { rule: "misfeature", file: "ci.yml", line: 4 },
      { rule: "adhoc-packages", file: "ci.yml", line: 6 },
      { rule: "ref-version-mismatch", file: "ci.yml", line: 7 },
    ]);
  });

  it("passes while each anchor still lands on the step it documents", () => {
    expect(anchorFailures(parseAnchors(CONFIG), read)).toEqual([]);
  });

  // The whole point: an unrelated edit inserts a line, the anchor slides off its step, and the
  // required zizmor job would go red on someone else's pull request.
  it("fails a drifted anchor and names the corrected line", () => {
    const shifted = ["# inserted above the cache step", ...CI.split("\n")].join("\n");
    const failures = anchorFailures(
      [{ rule: "cache-poisoning", file: "ci.yml", line: 3 }],
      (file) => (file === "ci.yml" ? shifted : read(file)),
    );
    expect(failures).toEqual([expect.stringContaining("update the anchor to ci.yml:4")]);
  });

  it("fails an anchor whose step is gone rather than guessing a replacement", () => {
    const failures = anchorFailures(
      [{ rule: "cache-poisoning", file: "ci.yml", line: 3 }],
      (file) => (file === "ci.yml" ? "jobs:\n  a:\n    run: echo" : read(file)),
    );
    expect(failures).toEqual([expect.stringContaining("no such step exists")]);
  });

  it("fails an anchor naming a workflow that does not exist", () => {
    const failures = anchorFailures([{ rule: "cache-poisoning", file: "gone.yml", line: 1 }], read);
    expect(failures).toEqual([expect.stringContaining("names a workflow that does not exist")]);
  });

  // `actions/cache/restore` cannot write a cache, so zizmor never flags it; an anchor pointing at
  // one is a silent no-op rather than a recorded risk acceptance.
  it("does not accept a restore-only step as a cache-poisoning anchor", () => {
    const restoreOnly = "jobs:\n  a:\n      uses: actions/cache/restore@abc # v6\n";
    const failures = anchorFailures(
      [{ rule: "cache-poisoning", file: "ci.yml", line: 3 }],
      () => restoreOnly,
    );
    expect(failures).toEqual([expect.stringContaining("no such step exists")]);
  });

  it("leaves a rule it does not know how to position-check unenforced rather than wrong", () => {
    expect(
      anchorFailures([{ rule: "template-injection", file: "ci.yml", line: 99 }], read),
    ).toEqual([]);
  });

  // The gap CodeRabbit named on #3055: the release.yml npm pin shifted twice in one day and no
  // checker noticed until the required job was red. adhoc anchors are position-checked now.
  it("fails a drifted adhoc-packages anchor and names the corrected line", () => {
    const shifted = ["# inserted above the install step", ...CI.split("\n")].join("\n");
    const failures = anchorFailures(
      [{ rule: "adhoc-packages", file: "ci.yml", line: 6 }],
      (file) => (file === "ci.yml" ? shifted : read(file)),
    );
    expect(failures).toEqual([expect.stringContaining("ci.yml:7")]);
  });

  // The gap this map closed: `misfeature` anchors at a step's `shell:` line, and a drifted one made
  // the required `workflow hygiene` job go red on a pull request that changed nothing about shells.
  it("fails a drifted misfeature anchor and names the corrected line", () => {
    const shifted = ["# inserted above the shell step", ...CI.split("\n")].join("\n");
    const failures = anchorFailures([{ rule: "misfeature", file: "ci.yml", line: 4 }], (file) =>
      file === "ci.yml" ? shifted : read(file),
    );
    expect(failures).toEqual([expect.stringContaining("update the anchor to ci.yml:5")]);
  });

  it("rejects a ref-version ignore that drifts away from the pinned internal gate action", () => {
    const shifted = ["# inserted above the internal action", ...CI.split("\n")].join("\n");
    const failures = anchorFailures(
      [{ rule: "ref-version-mismatch", file: "ci.yml", line: 7 }],
      (file) => (file === "ci.yml" ? shifted : read(file)),
    );
    expect(failures).toEqual([expect.stringContaining("update the anchor to ci.yml:8")]);
  });

  it.each(["main", "", "a".repeat(39), "a".repeat(41)])(
    "rejects a non-immutable internal action revision %j",
    (revision) => {
      const weakened = CI.replace(
        "@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # gate-snapshot-1",
        `@${revision} # gate-snapshot-1`,
      );
      const failures = anchorFailures(
        [{ rule: "ref-version-mismatch", file: "ci.yml", line: 7 }],
        (file) => (file === "ci.yml" ? weakened : read(file)),
      );

      expect(failures).toEqual([expect.stringContaining("pinned to a full commit SHA")]);
    },
  );

  // Reality guard: the committed configuration must satisfy its own checker.
  it("holds for the committed .github/zizmor.yml", () => {
    const config = readFileSync(join(repoRoot, ".github", "zizmor.yml"), "utf8");
    const anchors = parseAnchors(config);
    expect(anchors.length).toBeGreaterThan(0);
    expect(
      anchorFailures(anchors, (file) =>
        readFileSync(join(repoRoot, ".github", "workflows", file), "utf8"),
      ),
    ).toEqual([]);
  });
});

// The verdict half of the gate: which exit code it reaches and what it says. A gate that analyses
// correctly but reports silently is indistinguishable from a passing one.
describe("main", () => {
  let out;
  let err;
  let restore;

  function capture() {
    const previousExitCode = process.exitCode;
    const log = console.log;
    const error = console.error;
    out = [];
    err = [];
    console.log = (message) => out.push(String(message));
    console.error = (message) => err.push(String(message));
    restore = () => {
      console.log = log;
      console.error = error;
      process.exitCode = previousExitCode;
    };
    process.exitCode = undefined;
  }

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("passes and counts the anchors it verified", () => {
    capture();
    main({ readConfig: () => CONFIG, readWorkflow: read });

    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("zizmor-anchors: PASS");
    expect(err).toEqual([]);
  });

  it("fails closed when the configuration is missing rather than reporting nothing to check", () => {
    capture();
    main({ readConfig: () => undefined, readWorkflow: () => undefined });

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain(".github/zizmor.yml is missing");
  });

  it("fails and names every drifted anchor", () => {
    capture();
    main({ readConfig: () => CONFIG, readWorkflow: () => "      run: echo not-a-cache" });

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("zizmor-anchors: FAIL");
    expect(out.join("\n")).not.toContain("PASS");
  });
});
