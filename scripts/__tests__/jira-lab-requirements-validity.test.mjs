// The requirements scorecard never grades an infrastructure outage as a product failure (#4173).
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  gatewayEvidenceTrusted,
  gradeException,
  redactLabDetail,
  isDeadlineAbort,
  isTransportFailure,
  showsOutage,
  redCheck,
  readGatewayFailures,
  readToolRejections,
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
const NONE = { outages: 0, circuit: 0, productFailures: 0, unparsed: 0 };

describe("journey validity", () => {
  it("keeps a green journey green even when a model call was retried", () => {
    const check = journey("green");
    expect(classifyJourney(check, { ...NONE, outages: 2 })).toBe(check);
  });

  it("grades a red journey during gateway failures invalid and credits nothing", () => {
    const graded = classifyJourney(journey("red"), { ...NONE, outages: 31 });
    expect(graded.status).toBe("invalid");
    expect(graded.reason).toBe("gateway-failure");
    expect(graded.covers).toEqual([]);
  });

  it("keeps a red journey red when the circuit only cycled and no call failed through it", () => {
    const check = journey("red");
    expect(classifyJourney(check, { ...NONE, circuit: 3 })).toBe(check);
    expect(showsOutage({ ...NONE, circuit: 3 })).toBe(false);
  });

  it("grades a correlated outage invalid even without a circuit event", () => {
    expect(showsOutage({ ...NONE, outages: 1 })).toBe(true);
    expect(classifyJourney(journey("unverified"), { ...NONE, outages: 1 }).reason).toBe(
      "gateway-failure",
    );
  });

  it("does not grade a journey-turn timeout invalid", () => {
    const check = journey("red", { turnFailure: "The operation was aborted due to timeout" });
    expect(classifyJourney(check, NONE)).toBe(check);
  });

  it("recognizes a deadline abort by error name only", () => {
    expect(isDeadlineAbort(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isDeadlineAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isDeadlineAbort(new Error("aborted due to timeout"))).toBe(false);
  });

  it("recognizes a gateway failure from the turn itself without log evidence", () => {
    const check = journey("red", { turnFailure: "fetch failed" });
    expect(classifyJourney(check, NONE).reason).toBe("gateway-failure");
  });

  it("keeps a journey red when the gateway only refused a limit (no retry, no circuit)", () => {
    const check = journey("red", { turnFailure: "GATEWAY_CONTEXT_OVERFLOW" });
    expect(classifyJourney(check, { ...NONE, productFailures: 3 })).toBe(check);
    const denied = journey("red", { turnFailure: "GATEWAY_ATTEMPT_ADMISSION_DENIED" });
    expect(classifyJourney(denied, NONE)).toBe(denied);
  });

  it("names the transport signatures only", () => {
    for (const text of [
      "ECONNREFUSED",
      "read ECONNRESET",
      "UND_ERR_SOCKET",
      "fetch failed",
      "socket hang up",
    ])
      expect(isTransportFailure(text)).toBe(true);
    expect(isTransportFailure("GATEWAY_CONTEXT_OVERFLOW")).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
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
    expect(() => redCheck("because", "x")).toThrow(TypeError);
  });
});

describe("exception grading", () => {
  it("keeps a failed Keiko route red with a closed reason", () => {
    const graded = gradeException(new TypeError("Live Chat HTTP stage failed"), { layer: "probe" });
    expect(graded).toMatchObject({ status: "red", reason: "product-route-failed", layer: "probe" });
  });

  it("grades native Jira, fixture, license and transport errors as invalid lab errors", () => {
    for (const message of ["Laboratory read failed (500)", "connect ECONNREFUSED 127.0.0.1:8080"]) {
      const graded = gradeException(new TypeError(message));
      expect(graded).toMatchObject({ status: "invalid", reason: "lab-error" });
      expect(graded.detail).toBe(`lab error: ${message}`);
    }
  });
});

describe("Activity Log gateway evidence", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-lab-validity-"));
    mkdirSync(join(root, "logs"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const line = (op, ts, correlationId, pid = 7, errorKind = undefined) =>
    JSON.stringify({ op, ts, pid, correlationId, ...(errorKind ? { errorKind } : {}) });
  // A real outage's failed call carries the fallback kind `internal`; its retry lines carry the
  // provider's 5xx status (registered without an error kind) and its circuit events `unavailable`
  // (observed 2026-11-12; resilience.ts).
  const failed = (op, ts, correlationId, errorKind = "internal") =>
    line(op, ts, correlationId, 7, errorKind);
  const exhausted = (ts, correlationId, httpStatus = 500) =>
    JSON.stringify({
      op: "gateway.retry.exhausted",
      ts,
      pid: 7,
      correlationId,
      ...(httpStatus === null ? {} : { httpStatus }),
    });
  const T = (second) => `2026-11-12T05:00:${String(second).padStart(2, "0")}.000Z`;
  const window = {
    fromMs: Date.parse("2026-11-12T05:00:00.000Z"),
    toMs: Date.parse("2026-11-12T05:01:00.000Z"),
    pid: 7,
  };
  // The mtime is fixed inside the window so the fixture never depends on the host clock.
  const write = (lines) => {
    const file = join(root, "logs", "activity-1.jsonl");
    writeFileSync(file, lines.join("\n"));
    const inside = new Date(window.fromMs + 30_000);
    utimesSync(file, inside, inside);
  };

  it("counts a failed call that exhausted its retries as an outage, a bare failure as a limit", () => {
    write([
      line("gateway.chat.started", T(1), "a"),
      exhausted(T(2), "a"),
      failed("gateway.chat.failed", T(3), "a"),
      line("gateway.chat.started", T(4), "b"),
      failed("gateway.chat.failed", T(5), "b"),
      line("gateway.stream.started", T(6), "c"),
      line("gateway.circuit.rejected", T(7), "c", 7, "unavailable"),
      failed("gateway.stream.failed", T(8), "c"),
      line("gateway.retry.exhausted", T(9), "d"),
    ]);
    expect(readGatewayFailures(root, window)).toEqual({
      outages: 2,
      circuit: 1,
      productFailures: 1,
      unparsed: 0,
    });
  });

  it("counts an unclassified internal failure without a provider status as no outage", () => {
    write([
      exhausted(T(2), "a", null),
      failed("gateway.chat.failed", T(3), "a"),
      exhausted(T(4), "b", 400),
      failed("gateway.chat.failed", T(5), "b"),
      exhausted(T(6), "c", 429),
      failed("gateway.chat.failed", T(7), "c"),
    ]);
    expect(readGatewayFailures(root, window)).toEqual({
      outages: 1,
      circuit: 0,
      productFailures: 2,
      unparsed: 0,
    });
  });

  it("counts a model that kept answering invalidly as a model outcome, not an outage", () => {
    write([
      line("gateway.retry.exhausted", T(2), "a"),
      failed("gateway.chat.failed", T(3), "a", "validation-failed"),
      line("gateway.retry.exhausted", T(4), "b"),
      failed("gateway.chat.failed", T(5), "b", "invalid-request"),
      line("gateway.retry.exhausted", T(6), "c"),
      failed("gateway.chat.failed", T(7), "c", "timeout"),
    ]);
    expect(readGatewayFailures(root, window)).toEqual({
      outages: 1,
      circuit: 0,
      productFailures: 2,
      unparsed: 0,
    });
  });

  it("ignores lines outside the window, of other processes, and counts unparsable lines", () => {
    write([
      exhausted(T(10), "a"),
      failed("gateway.chat.failed", T(11), "a"),
      line("gateway.circuit.opened", "2026-11-12T04:00:00.000Z", "z"),
      line("gateway.chat.failed", T(12), "x", 99),
      '{"op":"gateway.chat.failed", truncated',
    ]);
    expect(readGatewayFailures(root, window)).toEqual({
      outages: 1,
      circuit: 0,
      productFailures: 0,
      unparsed: 1,
    });
  });

  it("treats an absent log directory or an unparsable gateway line as untrusted evidence", () => {
    const missing = join(root, "absent");
    expect(gatewayEvidenceTrusted(missing, readGatewayFailures(missing, window))).toBe(false);
    write([line("gateway.chat.started", T(1), "a")]);
    expect(
      gatewayEvidenceTrusted(join(root, "logs"), readGatewayFailures(join(root, "logs"), window)),
    ).toBe(true);
    write(['{"op":"gateway.chat.failed", truncated']);
    const failures = readGatewayFailures(join(root, "logs"), window);
    expect(gatewayEvidenceTrusted(join(root, "logs"), failures)).toBe(false);
  });

  it("reads an absent log directory as no evidence", () => {
    expect(readGatewayFailures(join(root, "absent"), { fromMs: 0, toMs: 1 })).toEqual(NONE);
  });

  it("counts the gateway's tool refusals per canonical tool and the failed model calls", () => {
    const refused = (ts, canonicalToolId, pid = 7, reason = "invalid-arguments") =>
      JSON.stringify({
        op: "gateway.tool-catalog.rejected",
        ts,
        pid,
        reason,
        ...(canonicalToolId ? { canonicalToolId } : {}),
      });
    write([
      refused(T(2), "keiko.jira.upsert.remote.link"),
      refused(T(3), "keiko.jira.upsert.remote.link"),
      refused(T(4)),
      failed("gateway.chat.failed", T(5), "a", "validation-failed"),
      refused(T(6), "keiko.jira.other", 8),
      refused("2026-11-12T04:00:00.000Z", "keiko.jira.other"),
      refused(T(7), "keiko.jira.stale", 7, "workspace-stale"),
      JSON.stringify({ op: "gateway.chat.failed", ts: T(8), pid: 8, correlationId: "z" }),
    ]);
    expect(readToolRejections(root, window)).toEqual({
      rejected: { "keiko.jira.upsert.remote.link": 2 },
      unidentified: 1,
      failedCalls: 1,
    });
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

  it("lets any red check decide before invalid", () => {
    const invalid = invalidCheck("model-unavailable", "down", { layer: "journey" });
    expect(scenarioVerdict(scenario, [probe("green"), invalid]).status).toBe("invalid");
    expect(scenarioVerdict(scenario, [probe("red"), invalid]).status).toBe("red");
    const redJourney = redCheck("product-route-failed", "x", { layer: "journey" });
    expect(scenarioVerdict(scenario, [{ ...probe("invalid") }, redJourney]).status).toBe("red");
    expect(scenarioVerdict(scenario, [probe("green"), journey("red")]).status).toBe("red");
  });
});

describe("repeated journeys", () => {
  const run = (status, covers = all) => ({ status, covers, detail: status });

  it("is green only when every valid run is green and one valid run exists", () => {
    expect(aggregateRuns([run("green"), run("invalid", []), run("green")]).status).toBe("green");
    expect(aggregateRuns([run("invalid", []), run("invalid", [])]).status).toBe("invalid");
    expect(aggregateRuns([run("green"), run("invalid", []), run("invalid", [])])).toMatchObject({
      status: "invalid",
      reason: "insufficient-valid-runs",
    });
    expect(aggregateRuns([run("green"), run("green"), run("invalid", [])]).status).toBe("green");
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
    const repeated = report(["invalid"]);
    repeated.results[0].runs = [{}, {}, {}];
    repeated.results[0].invalidRuns = 2;
    expect(scorecardMarkdown(repeated)).toContain("invalid (2 of 3 runs invalid)");
    expect(scorecardMarkdown(report(["green"]))).not.toContain("INVALID RUN");
  });
});

describe("untrusted gateway evidence and redacted details", () => {
  it("grades a failed journey invalid, not red, when its gateway evidence is untrusted", () => {
    const graded = classifyJourney(
      journey("red", { turnFailure: "model call failed" }),
      NONE,
      false,
    );
    expect(graded).toMatchObject({ status: "invalid", reason: "lab-error", covers: [] });
    const check = journey("red", { turnFailure: "model call failed" });
    expect(classifyJourney(check, NONE, true)).toBe(check);
    const clean = journey("unverified");
    expect(classifyJourney(clean, NONE, false)).toBe(clean);
    const green = journey("green");
    expect(classifyJourney(green, NONE, false)).toBe(green);
  });

  it("redacts endpoints and credentials but keeps the lab's loopback address", () => {
    const text = "fetch https://corp.example/v1 via 10.1.2.3:8443 Bearer abc.def 127.0.0.1:8080";
    expect(redactLabDetail(text)).toBe(
      "fetch [redacted-url] via [redacted-host] [redacted-credential] 127.0.0.1:8080",
    );
    const graded = gradeException(new TypeError("connect ECONNREFUSED 10.1.2.3:8443"));
    expect(graded.detail).toBe("lab error: connect ECONNREFUSED [redacted-host]");
  });
});
