// The requirements scorecard never grades an infrastructure outage as a product failure (#4173).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import {
  TREND_HEADER,
  aggregateRuns,
  countStatuses,
  trendLine,
} from "../testing/jira-chat-lab/requirements/repeat.mjs";
import { scorecardMarkdown } from "../testing/jira-chat-lab/requirements/scorecard-markdown.mjs";
import {
  classifyJourney,
  invalidCheck,
  labError,
  readGatewayFailures,
} from "../testing/jira-chat-lab/requirements/validity.mjs";
import { result } from "../testing/jira-chat-lab/requirements/journey-support.mjs";

const scenario = SCENARIOS[0];
const all = scenario.obligations;
const journey = (status, extra = {}) => ({
  layer: "journey",
  status,
  covers: status === "green" ? all : [],
  detail: "0 epics created",
  ...extra,
});
const NONE = { failed: 0, circuit: 0, unparsed: 0 };

describe("journey validity", () => {
  it("keeps a green journey green even when a model call was retried", () => {
    const check = journey("green");
    expect(classifyJourney(check, { ...NONE, failed: 2 })).toBe(check);
  });

  it("grades a red journey during gateway failures invalid and credits nothing", () => {
    const graded = classifyJourney(journey("red"), { ...NONE, failed: 31 });
    expect(graded.status).toBe("invalid");
    expect(graded.reason).toBe("gateway-failure");
    expect(graded.covers).toEqual([]);
  });

  it("grades any non-green journey during an open circuit invalid", () => {
    expect(classifyJourney(journey("unverified"), { ...NONE, circuit: 1 }).reason).toBe(
      "gateway-circuit-open",
    );
  });

  it("recognizes a gateway failure from the turn itself without log evidence", () => {
    const check = journey("red", { turnFailure: "fetch failed" });
    expect(classifyJourney(check, NONE).reason).toBe("gateway-failure");
  });

  it("keeps a genuine product failure red", () => {
    const check = journey("red", { turnFailure: "Synthetic product failure" });
    expect(classifyJourney(check, NONE)).toBe(check);
  });

  it("carries the turn failure on the check envelope", () => {
    const check = result("red", { durationMs: 1, toolCalls: 1, failure: "boom" }, "x", []);
    expect(check.turnFailure).toBe("boom");
  });

  it("refuses an unknown invalid reason", () => {
    expect(() => invalidCheck("because", "x")).toThrow(TypeError);
    expect(labError(new Error("down")).detail).toBe("lab error: down");
  });
});

describe("Activity Log gateway evidence", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-lab-validity-"));
    mkdirSync(join(root, "logs"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const line = (op, ts, pid = 7) => JSON.stringify({ op, ts, pid });

  it("counts failures and circuit events of this process inside the window only", () => {
    writeFileSync(
      join(root, "logs", "activity-1.jsonl"),
      [
        line("gateway.chat.failed", "2026-11-12T05:00:10.000Z"),
        line("gateway.stream.failed", "2026-11-12T05:00:11.000Z"),
        line("gateway.circuit.opened", "2026-11-12T05:00:12.000Z"),
        line("gateway.chat.failed", "2026-11-12T04:00:00.000Z"),
        line("gateway.chat.failed", "2026-11-12T05:00:12.000Z", 99),
        line("gateway.conversation.admission", "2026-11-12T05:00:12.000Z"),
        '{"op":"gateway.chat.failed", truncated',
      ].join("\n"),
    );
    const counts = readGatewayFailures(root, {
      fromMs: Date.parse("2026-11-12T05:00:00.000Z"),
      toMs: Date.parse("2026-11-12T05:01:00.000Z"),
      pid: 7,
    });
    expect(counts).toEqual({ failed: 2, circuit: 1, unparsed: 1 });
  });

  it("reads an absent log directory as no evidence", () => {
    expect(readGatewayFailures(join(root, "absent"), { fromMs: 0, toMs: 1 })).toEqual(NONE);
  });
});

describe("scenario verdict", () => {
  const probe = (status) => ({ layer: "probe", status, covers: [], detail: "p" });

  it("needs a green journey: probes covering everything beside an unverified journey stay partial", () => {
    const checks = [
      { layer: "probe", status: "green", covers: all, detail: "p" },
      journey("unverified"),
    ];
    expect(scenarioVerdict(scenario, checks).status).toBe("partial");
  });

  it("is green with a green journey", () => {
    expect(scenarioVerdict(scenario, [journey("green")]).status).toBe("green");
  });

  it("propagates invalid, but a red model-free probe stays red", () => {
    const invalid = invalidCheck("model-unavailable", "down", { layer: "journey" });
    expect(scenarioVerdict(scenario, [probe("green"), invalid]).status).toBe("invalid");
    expect(scenarioVerdict(scenario, [probe("red"), invalid]).status).toBe("red");
    expect(scenarioVerdict(scenario, [probe("green"), journey("red")]).status).toBe("red");
  });
});

describe("repeated journeys", () => {
  const run = (status, covers = all) => ({ status, covers, detail: status });

  it("is green only when every valid run is green and one valid run exists", () => {
    expect(aggregateRuns([run("green"), run("invalid", []), run("green")]).status).toBe("green");
    expect(aggregateRuns([run("invalid", []), run("invalid", [])]).status).toBe("invalid");
    expect(aggregateRuns([run("green"), run("red", [])]).status).toBe("red");
    expect(aggregateRuns([run("green"), run("unverified", [])]).status).toBe("unverified");
  });

  it("reports each run, the pass rate over valid runs and the invalid count", () => {
    const aggregate = aggregateRuns([run("green"), run("red", []), run("invalid", [])]);
    expect(aggregate.passRate).toBe(0.5);
    expect(aggregate.validRuns).toBe(2);
    expect(aggregate.invalidRuns).toBe(1);
    expect(aggregate.runs.map((entry) => entry.status)).toEqual(["green", "red", "invalid"]);
    expect(aggregate.detail).toContain("pass rate 1/2 valid; 1 invalid");
  });

  it("credits only what every valid run verified", () => {
    const [first, second] = all;
    expect(aggregateRuns([run("green", [first, second]), run("green", [first])]).covers).toEqual([
      first,
    ]);
  });
});

describe("counts, markdown and trend", () => {
  const report = (statuses) => {
    const results = statuses.map((status, index) => ({
      id: `S${index}`,
      status,
      requirement: "r",
      issue: 1,
      title: "t",
      checks: [],
      uncovered: [],
    }));
    return { startedAt: "t0", model: "m", repeat: 2, results, counts: countStatuses(results) };
  };

  it("counts invalid and fails closed on an unknown status", () => {
    expect(countStatuses(report(["green", "invalid"]).results).invalid).toBe(1);
    expect(() => countStatuses([{ id: "S1", status: "bogus" }])).toThrow(TypeError);
  });

  it("labels a run with an invalid scenario in the trend and the markdown", () => {
    const bad = report(["green", "invalid"]);
    expect(trendLine(bad).split("\t")[3]).toBe("invalid");
    expect(trendLine(report(["green"])).split("\t")[3]).toBe("valid");
    expect(TREND_HEADER.trim().split("\t")).toHaveLength(trendLine(bad).trim().split("\t").length);
    const markdown = scorecardMarkdown(bad);
    expect(markdown).toContain("INVALID RUN");
    expect(markdown).toContain("invalid 1");
    expect(scorecardMarkdown(report(["green"]))).not.toContain("INVALID RUN");
  });
});
