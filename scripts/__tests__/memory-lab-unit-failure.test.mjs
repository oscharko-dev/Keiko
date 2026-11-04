// A unit that cannot be measured costs that unit, not the run: it is recorded with its error name
// (and a scrubbed message where the scenario text may appear in evidence), and the run goes on.
// Nothing here forks the product; a checkout without a runtime makes every unit fail at its start.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";
import { LabConfigurationError } from "../testing/memory-lab/isolation.mjs";
import {
  describeUnitError,
  failedUnitResult,
  isFailedUnit,
} from "../testing/memory-lab/unit-failure.mjs";

const SCENARIO = { language: "de", class: "preference", difficulty: "plain" };
// Built from parts: the secret scan of the repository runs over this file.
const KEY = ["sk-", "proj-", "AbCdEfGhIjKlMnOpQrStUvWx", "_1234"].join("");

describe("describing a unit's error", () => {
  it("keeps the class name and a message without paths or credential shapes", () => {
    const error = new TypeError(
      `cannot read /Users/someone/Projects/x/state/project/file.json with key ${KEY} on C:\\Users\\me\\x\\y`,
    );
    const described = describeUnitError(error, true);
    expect(described.name).toBe("TypeError");
    expect(described.message).toBe("cannot read <path> with key [redacted] on <path>");
  });

  it("keeps a route name apart from a host path and drops cookie and authorization headers", () => {
    const described = describeUnitError(
      new Error("chat turn failed with HTTP 500 for /api, authorization: Basic abcdefgh"),
      true,
    );
    expect(described.message).toContain("HTTP 500");
    expect(described.message).toContain("/api");
    expect(described.message).not.toContain("abcdefgh");
  });

  it("bounds a long message and collapses whitespace", () => {
    const described = describeUnitError(new Error(`a\n\n  b ${"x".repeat(1000)}`), true);
    expect(described.message.length).toBeLessThanOrEqual(300);
    expect(described.message.startsWith("a b xxx")).toBe(true);
  });

  it("gives the name alone where the message may carry conversation text", () => {
    expect(describeUnitError(new RangeError("the user said: zebra"), false)).toEqual({
      name: "RangeError",
      message: "",
    });
  });

  it("falls back to Error for anything that is not a plain class name", () => {
    expect(describeUnitError("just a string", true).name).toBe("Error");
    expect(describeUnitError({ name: "has spaces and /slashes" }, true).name).toBe("Error");
    expect(describeUnitError(undefined, false)).toEqual({ name: "Error", message: "" });
  });
});

describe("the result of a failed unit", () => {
  it("is empty, marked, and carries no figure that could look like a measurement", () => {
    const result = failedUnitResult({
      scenario: SCENARIO,
      name: "preference-tables-de",
      arm: "product",
      repetition: 2,
      error: new Error("boom"),
      includeMessage: true,
    });
    expect(isFailedUnit(result)).toBe(true);
    expect(result).toMatchObject({
      scenario: "preference-tables-de",
      language: "de",
      class: "preference",
      difficulty: "plain",
      arm: "product",
      repetition: 2,
      turns: [],
      probes: [],
      captures: [],
      error: { name: "Error", message: "boom" },
    });
    expect(result.store).toMatchObject({ stored: 0, live: 0, precision: null, recall: null });
    expect(result.store.counters).toEqual({
      credential: 0,
      identifier: 0,
      "third-party": 0,
      "forgotten-returned": 0,
      "private-in-project": 0,
    });
    expect(isFailedUnit({ ...result, error: undefined })).toBe(false);
  });
});

describe("a run in which units cannot be measured", () => {
  let root;
  let scenarios;
  let subjectRoot;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-lab-unit-failure-"));
    scenarios = join(root, "scenarios");
    subjectRoot = join(root, "no-such-checkout");
    mkdirSync(scenarios);
    for (const id of ["unit-failure-one", "unit-failure-two"])
      writeFileSync(join(scenarios, `${id}.json`), JSON.stringify(scenarioFile(id)));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function scenarioFile(id) {
    return {
      schemaVersion: 1,
      id,
      language: "en",
      class: "preference",
      difficulty: "plain",
      description: "A unit that cannot start.",
      truth: [{ key: "k", seed: "I like plain text.", must: true, terms: [["plain text"]] }],
      turns: [{ user: "I like plain text." }],
      probes: [
        { id: "p", question: "Format?", expect: { kind: "answer", terms: [["plain text"]] } },
      ],
    };
  }

  function options(extra = {}) {
    return {
      ...normalizeOptions({
        mode: "offline",
        out: join(root, "out"),
        scenarios,
        arms: "off,product",
        repetitions: "1",
        "quiet-ms": "50",
        "max-wait-ms": "2000",
        "generated-at": "0",
      }),
      subjectRoot,
      ...extra,
    };
  }

  it("records every failed unit, goes on to the next, and ends with FAIL and the count", async () => {
    // The failure this pins: a unit that threw rejected the whole run, so no scorecard was written.
    const lines = [];
    const summary = await runLab(options(), (line) => lines.push(line));
    expect(summary.failedUnits).toBe(4);
    expect(summary.runs).toBe(4);
    expect(lines.filter((line) => line.includes("FAILED"))).toHaveLength(4);
    expect(lines.at(-1)).toBe(
      "FAIL memory-lab runs=4 hard-counters=zero oracle-counters=zero oracle=not-run failed-units=4",
    );
    const card = JSON.parse(readFileSync(join(root, "out", "scorecard.json"), "utf8"));
    expect(card.scenarios).toHaveLength(4);
    for (const entry of card.scenarios) {
      expect(entry.passed).toBe(false);
      expect(entry.name).toMatch(/:r0:store$/u);
      expect(entry.evidence).toMatch(/^unit-failed:\w+$/u);
    }
  });

  it("writes the run file with a scrubbed message and marks the unit in the timing", async () => {
    await runLab(options({ arms: ["product"] }), () => undefined);
    const run = JSON.parse(
      readFileSync(join(root, "out", "runs", "unit-failure-one.product.r0.json"), "utf8"),
    );
    expect(run.error.name).toBe("Error");
    expect(run.error.message).not.toContain(root);
    expect(run.store.live).toBe(0);
    const timing = JSON.parse(readFileSync(join(root, "out", "timing.json"), "utf8"));
    expect(timing.every((row) => row.failed === true)).toBe(true);
    const summary = JSON.parse(readFileSync(join(root, "out", "summary.json"), "utf8"));
    expect(summary.failedUnits).toBe(2);
  });

  it("ends the run instead when the operator's configuration is refused", async () => {
    // A key in the checkout's .env would change every measured instance: no unit could be trusted.
    mkdirSync(subjectRoot);
    writeFileSync(join(subjectRoot, ".env"), "KEIKO_MEMORY_MODE=autonomous-delivery\n");
    const error = await runLab(options(), () => undefined).catch((caught) => caught);
    expect(error).toBeInstanceOf(LabConfigurationError);
    expect(error.message).toContain("--allow-folded-env");
  });
});
