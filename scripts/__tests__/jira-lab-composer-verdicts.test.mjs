// How the Composer lane reports what it could not verify (#4369): a journey with an unverified part
// never logs green, `unverified` is its own scenario state and column (not partial), and a model run
// exits 0 only when every scenario is green. The older aggregation, which the document lane relies
// on, is pinned unchanged in jira-lab-requirements-journeys-creation.test.mjs.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPOSER_SCENARIOS } from "../testing/jira-chat-lab/requirements/composer-catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { aggregateParts } from "../testing/jira-chat-lab/requirements/journey-support.mjs";
import {
  TREND_HEADER,
  aggregateRuns,
  countStatuses,
  runExitCode,
  trendLine,
} from "../testing/jira-chat-lab/requirements/repeat.mjs";
import {
  finishRun,
  withComposerFieldLift,
} from "../testing/jira-chat-lab/requirements/scorecard-finish.mjs";
import { scorecardMarkdown } from "../testing/jira-chat-lab/requirements/scorecard-markdown.mjs";

const part = (status, covers) => ({ label: covers[0], status, covers, detail: "d" });
const turns = [{ durationMs: 1000, toolCalls: 1 }];
const strict = (parts) => aggregateParts(parts, turns, { unverifiedIsNotGreen: true });

describe("a journey with an unverified part is never green", () => {
  it("is unverified, credits the green parts only and counts the unverified ones", () => {
    const check = strict([part("green", ["a"]), part("unverified", ["b"]), part("green", ["c"])]);
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual(["a", "c"]);
    expect(check.unverifiedParts).toBe(1);
    expect(check.detail).toContain("b: unverified");
  });

  it("stays green with every part green, and red with any red part", () => {
    const green = strict([part("green", ["a"]), part("green", ["b"])]);
    expect(green.status).toBe("green");
    expect(green.unverifiedParts).toBeUndefined();
    expect(strict([part("unverified", ["a"]), part("red", ["b"])]).status).toBe("red");
    expect(strict([part("unverified", ["a"])]).covers).toEqual([]);
  });

  it("a part that is itself a strict aggregate keeps crediting its green parts and counts its unverified ones", () => {
    const inner = strict([
      part("green", ["a"]),
      part("unverified", ["b"]),
      part("unverified", ["c"]),
    ]);
    const outer = strict([{ label: "S10", ...inner }, part("green", ["d"])]);
    expect(outer.status).toBe("unverified");
    expect(outer.covers).toEqual(["a", "d"]);
    expect(outer.unverifiedParts).toBe(2);
    expect(strict([{ label: "S10", ...inner }, part("red", ["e"])]).status).toBe("red");
  });

  it("is the Composer lane's choice: the default keeps the document lane's verdict", () => {
    expect(aggregateParts([part("green", ["a"]), part("unverified", ["b"])], turns).status).toBe(
      "green",
    );
  });
});

describe("the scenario verdict knows unverified", () => {
  const scenario = { id: "C99", obligations: ["a", "b", "c"] };
  const journey = (check) => ({ layer: "journey", ...check });

  it("is unverified, not partial, when a journey could not verify some part, and credits what it did", () => {
    const check = journey(strict([part("green", ["a"]), part("unverified", ["b"])]));
    const verdict = scenarioVerdict(scenario, [check]);
    expect(verdict.status).toBe("unverified");
    expect(verdict.covered).toEqual(["a"]);
    expect(verdict.uncovered).toEqual(["b", "c"]);
  });

  it("keeps red and invalid ahead of unverified, and partial for a plain unverified journey", () => {
    const check = journey(strict([part("green", ["a"]), part("unverified", ["b"])]));
    expect(scenarioVerdict(scenario, [check, { layer: "probe", status: "red" }]).status).toBe(
      "red",
    );
    expect(scenarioVerdict(scenario, [check, { layer: "probe", status: "invalid" }]).status).toBe(
      "invalid",
    );
    expect(scenarioVerdict(scenario, [journey({ status: "unverified", covers: [] })]).status).toBe(
      "partial",
    );
  });

  it("is green only when every part is green and every obligation covered", () => {
    const all = journey(strict(["a", "b", "c"].map((id) => part("green", [id]))));
    expect(scenarioVerdict(scenario, [all]).status).toBe("green");
  });

  it("covers no obligation twice and no unknown one: the catalog's own names are checked", () => {
    for (const entry of COMPOSER_SCENARIOS)
      expect(new Set(entry.obligations).size, entry.id).toBe(entry.obligations.length);
  });
});

describe("repeated runs: the Composer lane's unverified parts are opt-in", () => {
  it("carries the count of runs that were not green when the runs carry unverifiedParts", () => {
    const runs = [
      { status: "green", covers: ["a"], detail: "d" },
      { status: "unverified", covers: [], detail: "d", unverifiedParts: 2 },
    ];
    const check = aggregateRuns(runs);
    expect(check.status).toBe("unverified");
    expect(check.unverifiedParts).toBe(1);
    expect(aggregateRuns([runs[0], runs[0]]).unverifiedParts).toBeUndefined();
    const scenario = { id: "C99", obligations: ["a"] };
    expect(scenarioVerdict(scenario, [{ layer: "journey", ...check }]).status).toBe("unverified");
  });

  it("leaves the document lane's repeat verdict as it was: partial, no unverifiedParts", () => {
    // Document-lane runs never carry unverifiedParts: an unverified run beside a green one is the
    // check `unverified` and the scenario `partial`, as before the Composer lane existed.
    const runs = [
      { status: "green", covers: ["a"], detail: "d" },
      { status: "unverified", covers: [], detail: "d" },
    ];
    const check = aggregateRuns(runs);
    expect(check.status).toBe("unverified");
    expect(check).not.toHaveProperty("unverifiedParts");
    const scenario = { id: "S99", obligations: ["a"] };
    expect(scenarioVerdict(scenario, [{ layer: "journey", ...check }]).status).toBe("partial");
    expect(countStatuses([{ id: "S99", status: "partial" }]).unverified).toBe(0);
  });
});

describe("the report shows unverified as its own state", () => {
  const result = (id, status) => ({
    id,
    status,
    requirement: "composer",
    issue: 4354,
    title: "t",
    checks: [],
    uncovered: [],
  });
  const report = (statuses) => {
    const results = statuses.map((status, index) => result(`C0${index}`, status));
    return { startedAt: "t0", model: "m", repeat: 1, results, counts: countStatuses(results) };
  };

  it("counts it apart from partial", () => {
    const counts = countStatuses(report(["green", "unverified", "unverified", "partial"]).results);
    expect(counts).toMatchObject({ green: 1, unverified: 2, partial: 1, red: 0 });
  });

  it("has its own column in latest.md, with the note that says what it means", () => {
    const text = scorecardMarkdown(report(["green", "unverified"]));
    expect(text).toContain("partial 0 · unverified 1 · invalid 0");
    expect(text).toContain("🟤 unverified");
    expect(text).toContain("could not be verified");
    expect(scorecardMarkdown(report(["green"]))).not.toContain("could not be verified");
  });

  it("has its own column in the trend, and the header and the line stay the same width", () => {
    const line = trendLine(report(["green", "unverified"]));
    expect(TREND_HEADER.trim().split("\t").at(-1)).toBe("unverified");
    expect(line.trim().split("\t").at(-1)).toBe("1");
    expect(line.trim().split("\t")).toHaveLength(TREND_HEADER.trim().split("\t").length);
  });
});

describe("the exit code of a model run", () => {
  const exitOf = (...statuses) => runExitCode({ results: statuses.map((status) => ({ status })) });

  it("is 0 only when every scenario is green", () => {
    expect(exitOf("green", "green")).toBe(0);
  });

  it.each(["red", "partial", "unverified", "invalid", "probe-only", "unchecked"])(
    "is 1 when a scenario is %s",
    (status) => {
      expect(exitOf("green", status)).toBe(1);
    },
  );

  it("is 1 when no scenario ran at all", () => {
    expect(runExitCode({ results: [] })).toBe(1);
    expect(runExitCode({})).toBe(1);
  });
});

describe("the end of a run, by execution", () => {
  const directories = [];
  const finish = (statuses, modelRun) => {
    const output = mkdtempSync(join(tmpdir(), "scorecard-finish-"));
    directories.push(output);
    const lines = [];
    const results = statuses.map((status, index) => ({
      id: `S0${index}`,
      status,
      requirement: "r",
      issue: 1,
      title: "t",
      checks: [],
      uncovered: [],
    }));
    const report = { startedAt: "2026-11-14T00:00:00.000Z", model: "m", repeat: 1, results };
    const code = finishRun({ report, output, modelRun, log: (line) => lines.push(line) });
    return { code, output, lines, report };
  };
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("a model run exits 0 only when every scenario is green, and writes its report either way", () => {
    const green = finish(["green", "green"], true);
    expect(green.code).toBe(0);
    expect(readdirSync(green.output).sort()).toEqual(
      ["2026-11-14T00-00-00.000Z.json", "latest.md", "trend.tsv"].sort(),
    );
    expect(readFileSync(join(green.output, "latest.md"), "utf8")).toContain("Green 2");
    expect(green.lines).toHaveLength(1);
    for (const status of ["red", "partial", "unverified", "invalid", "probe-only", "unchecked"])
      expect(finish(["green", status], true).code, status).toBe(1);
  });

  it("applies to the document lane's model run too: the rule never looks at the scenario ids", () => {
    expect(finish(["green"], true).code).toBe(0);
    expect(finish(["partial"], true).code).toBe(1);
  });

  it("a run without a model writes its report and exits 0", () => {
    const probes = finish(["probe-only"], false);
    expect(probes.code).toBe(0);
    expect(probes.report.counts["probe-only"]).toBe(1);
  });

  it("the field-lift bracket surrounds the Composer lane only", async () => {
    const calls = [];
    const lift = async (session, run) => {
      calls.push(["lift-start", session]);
      const value = await run();
      calls.push(["lift-end", session]);
      return value;
    };
    const run = async () => {
      calls.push(["run"]);
      return "done";
    };
    expect(await withComposerFieldLift(true, "s", run, lift)).toBe("done");
    expect(calls).toEqual([["lift-start", "s"], ["run"], ["lift-end", "s"]]);
    calls.length = 0;
    expect(await withComposerFieldLift(false, "s", run, lift)).toBe("done");
    expect(calls).toEqual([["run"]]);
  });
});
