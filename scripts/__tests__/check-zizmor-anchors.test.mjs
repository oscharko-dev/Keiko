import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { anchorFailures, parseAnchors } from "../check-zizmor-anchors.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONFIG = `rules:
  cache-poisoning:
    ignore:
      # a comment that must not be read as an anchor
      - ci.yml:3
      - other.yml:1
  misfeature:
    ignore:
      - ci.yml:99
`;

const CI = ["jobs:", "  a:", "      uses: actions/cache@abc # v6", "      run: echo"].join("\n");
const OTHER = ["      uses: actions/cache@abc # v6"].join("\n");

const read = (file) => ({ "ci.yml": CI, "other.yml": OTHER })[file];

describe("zizmor ignore anchors", () => {
  it("reads every anchor with the rule it belongs to, and nothing else", () => {
    expect(parseAnchors(CONFIG)).toEqual([
      { rule: "cache-poisoning", file: "ci.yml", line: 3 },
      { rule: "cache-poisoning", file: "other.yml", line: 1 },
      { rule: "misfeature", file: "ci.yml", line: 99 },
    ]);
  });

  it("passes while each anchor still lands on the step it documents", () => {
    expect(anchorFailures(parseAnchors(CONFIG), read)).toEqual([]);
  });

  // The whole point: an unrelated edit inserts a line, the anchor slides off its step, and the
  // required zizmor job would go red on someone else's pull request.
  it("fails a drifted anchor and names the corrected line", () => {
    const shifted = ["# inserted above the cache step", ...CI.split("\n")].join("\n");
    const failures = anchorFailures(parseAnchors(CONFIG), (file) =>
      file === "ci.yml" ? shifted : read(file),
    );
    expect(failures).toEqual([expect.stringContaining("update the anchor to ci.yml:4")]);
  });

  it("fails an anchor whose step is gone rather than guessing a replacement", () => {
    const failures = anchorFailures(parseAnchors(CONFIG), (file) =>
      file === "ci.yml" ? "jobs:\n  a:\n    run: echo" : read(file),
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
    expect(anchorFailures([{ rule: "misfeature", file: "ci.yml", line: 99 }], read)).toEqual([]);
  });

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
