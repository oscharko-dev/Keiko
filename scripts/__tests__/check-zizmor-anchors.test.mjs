import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  anchorFailures,
  applyCorrections,
  correctedAnchors,
  main,
  parseAnchors,
} from "../check-zizmor-anchors.mjs";

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
// An inserted line shifts every anchor below it, which is why this gate goes red on diffs that have
// nothing to do with the accepted risk. Re-pinning is mechanical for a pure shift — but only if the
// anchors are matched to their steps BY ORDER. "Nearest line" collides once several anchors shift
// together: two anchors can resolve to the same step, which moves a reviewed acceptance onto a step
// nobody reviewed. That is the failure this suite exists to prevent.
describe("re-pinning shifted anchors", () => {
  // A PURE SHIFT: both cache steps keep their job, only their line moved. The layout is chosen so
  // nearest-line would give BOTH anchors the same step (10 -> 15 and 20 -> 15), which is the
  // collision that moves an accepted risk onto another job's step.
  //
  // COMMITTED (what the anchors were verified against): cache in job `a` at 10, job `b` at 20.
  const COMMITTED_WORKFLOW = [
    "name: W", // 1
    "jobs:", // 2
    "  a:", // 3
    "    steps:", // 4
    "      - run: one", // 5
    "      - run: two", // 6
    "      - run: three", // 7
    "      - run: four", // 8
    "      - run: five", // 9
    "      - uses: actions/cache@abc", // 10
    "  b:", // 11
    "    steps:", // 12
    "      - run: six", // 13
    "      - run: seven", // 14
    "      - run: eight", // 15
    "      - run: nine", // 16
    "      - run: ten", // 17
    "      - run: eleven", // 18
    "      - run: twelve", // 19
    "      - uses: actions/cache@def", // 20
  ].join("\n");

  // CURRENT: the same two steps in the same two jobs, shifted up by preceding lines being removed.
  const SHIFTED_WORKFLOW = [
    "name: W", // 1
    "jobs:", // 2
    "  a:", // 3
    "    steps:", // 4
    "      - uses: actions/cache@abc", // 5
    "  b:", // 6
    "    steps:", // 7
    "      - run: six", // 8
    "      - run: seven", // 9
    "      - run: eight", // 10
    "      - run: nine", // 11
    "      - run: ten", // 12
    "      - run: eleven", // 13
    "      - run: twelve", // 14
    "      - uses: actions/cache@def", // 15
  ].join("\n");

  const SHIFTED_CONFIG = `rules:
  cache-poisoning:
    ignore:
      - w.yml:10
      - w.yml:20
`;

  const anchorsOf = (config) => parseAnchors(config);
  const readShifted = () => SHIFTED_WORKFLOW;
  const readCommitted = () => COMMITTED_WORKFLOW;

  it("pairs anchors with steps by order, not by nearest line", () => {
    const corrections = correctedAnchors(anchorsOf(SHIFTED_CONFIG), readShifted, readCommitted);
    expect([...corrections.values()]).toEqual([5, 15]);
  });

  it("writes each anchor back to its own step", () => {
    const anchors = anchorsOf(SHIFTED_CONFIG);
    const rewritten = applyCorrections(
      SHIFTED_CONFIG,
      correctedAnchors(anchors, readShifted, readCommitted),
    );
    expect(rewritten).toContain("- w.yml:5");
    expect(rewritten).toContain("- w.yml:15");
    expect(rewritten).not.toContain("- w.yml:10");
    expect(rewritten).not.toContain("- w.yml:20");
  });

  it("refuses a replacement step inside the SAME job, where count and job both still agree", () => {
    // The hardest case: `a` keeps exactly one cache step, so the count matches AND the owning job
    // matches — but it is a DIFFERENT step. Only the step body distinguishes them, and carrying the
    // suppression across would attach a reviewed risk acceptance to a step nobody reviewed.
    const sameJobReplacement = [
      "name: W", // 1
      "jobs:", // 2
      "  a:", // 3
      "    steps:", // 4
      "      - uses: actions/cache@abc", // 5
      "        with:", // 6
      "          key: REPLACED-KEY", // 7
      "  b:", // 8
      "    steps:", // 9
      "      - run: six", // 10
      "      - run: seven", // 11
      "      - run: eight", // 12
      "      - run: nine", // 13
      "      - run: ten", // 14
      "      - uses: actions/cache@def", // 15
    ].join("\n");
    const committed = [
      "name: W",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/cache@abc",
      "        with:",
      "          key: ORIGINAL-KEY",
      "  b:",
      "    steps:",
      "      - run: six",
      "      - run: seven",
      "      - run: eight",
      "      - run: nine",
      "      - run: ten",
      "      - uses: actions/cache@def",
    ].join("\n");
    const config = `rules:
  cache-poisoning:
    ignore:
      - w.yml:5
      - w.yml:15
`;
    // Nothing moved, so there is nothing to correct either way; the guard matters when a shift
    // coincides with a replacement, which the shifted variant below exercises.
    const shiftedWithReplacement = ["name: W", "jobs:", "  a:", "    steps:"]
      .concat([
        "      - uses: actions/cache@abc",
        "        with:",
        "          key: REPLACED-KEY",
        "  b:",
        "    steps:",
        "      - uses: actions/cache@def",
      ])
      .join("\n");
    const committedShifted = [
      "name: W",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: filler",
      "      - uses: actions/cache@abc",
      "        with:",
      "          key: ORIGINAL-KEY",
      "  b:",
      "    steps:",
      "      - uses: actions/cache@def",
    ].join("\n");
    const shiftedConfig = `rules:
  cache-poisoning:
    ignore:
      - w.yml:6
      - w.yml:11
`;
    const corrections = correctedAnchors(
      parseAnchors(shiftedConfig),
      () => shiftedWithReplacement,
      () => committedShifted,
    );
    // The anchor in job `a` must NOT be re-pinned: its step body changed.
    expect([...corrections.values()]).not.toContain(5);
    expect(
      correctedAnchors(
        parseAnchors(config),
        () => sameJobReplacement,
        () => committed,
      ).size,
    ).toBe(0);
  });

  it("refuses a step that moved to a different job, even when the count is unchanged", () => {
    // `a` loses its cache step and `b` gains a second one: two before, two after.
    const replaced = [
      "name: W",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: replaced",
      "  b:",
      "    steps:",
      "      - uses: actions/cache@def",
      "      - uses: actions/cache@new",
    ].join("\n");
    const corrections = correctedAnchors(anchorsOf(SHIFTED_CONFIG), () => replaced, readCommitted);
    // The anchor from job `a` must NOT be carried into job `b`.
    expect([...corrections.values()]).not.toContain(8);
  });

  it("refuses to re-pin when a step was added or removed, which is not a shift", () => {
    const oneStepOnly = [
      "name: W",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/cache@abc",
    ].join("\n");
    const corrections = correctedAnchors(
      anchorsOf(SHIFTED_CONFIG),
      () => oneStepOnly,
      readCommitted,
    );
    expect(corrections.size).toBe(0);
  });

  it("leaves an already-correct anchor untouched", () => {
    const correct = `rules:
  cache-poisoning:
    ignore:
      - w.yml:5
      - w.yml:15
`;
    expect(correctedAnchors(anchorsOf(correct), readShifted, readShifted).size).toBe(0);
    expect(applyCorrections(correct, new Map())).toBe(correct);
  });
});

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

  it("re-pins shifted anchors through --fix and writes them back once", () => {
    capture();
    let written;
    main({
      fix: true,
      readConfig: () => CONFIG,
      readWorkflow: read,
      writeConfig: (text) => {
        written = text;
      },
    });

    // The repository's own anchors are correct, so --fix must write nothing and stay green.
    expect(written).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("nothing to re-pin");
  });

  it("points at --fix when anchors only drifted, so the repair is one command", () => {
    capture();
    main({ readConfig: () => CONFIG, readWorkflow: () => "      run: echo not-a-cache" });

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("--fix");
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
