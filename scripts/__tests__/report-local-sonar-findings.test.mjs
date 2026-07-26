import { describe, expect, it, vi } from "vitest";

import {
  componentPath,
  executeLocalSonarCli,
  parseIssuePayload,
  renderFindings,
  runLocalSonarReport,
  selectFindings,
} from "../report-local-sonar-findings.mjs";

function issue(component, rule, line, message = "something", severity = "MINOR") {
  return { component, rule, line, message, severity };
}

const payload = {
  total: 3,
  issues: [
    issue("keiko-local:scripts/report-settlement-latency.mjs", "javascript:S7786", 172),
    issue("keiko-local:scripts/report-settlement-latency.mjs", "javascript:S7755", 179),
    issue("keiko-local:packages/keiko-server/src/untouched.ts", "typescript:S1234", 4),
  ],
};

describe("payload handling", () => {
  it("fails loud on an empty or shapeless payload rather than reporting a clean scan", () => {
    expect(() => parseIssuePayload("")).toThrow(TypeError);
    expect(() => parseIssuePayload("   ")).toThrow(TypeError);
    expect(() => parseIssuePayload(undefined)).toThrow(TypeError);
    expect(() => parseIssuePayload("{}")).toThrow(/no issue list/u);
    expect(() => parseIssuePayload("not json")).toThrow();
  });

  it("strips the project key from a component and tolerates one without", () => {
    expect(componentPath("keiko-local:scripts/a.mjs")).toBe("scripts/a.mjs");
    expect(componentPath("scripts/a.mjs")).toBe("scripts/a.mjs");
    expect(componentPath(undefined)).toBe("");
  });
});

describe("scoping to the diff", () => {
  it("keeps only findings on files this branch changed", () => {
    const findings = selectFindings(payload, {
      scope: "changed",
      changed: ["scripts/report-settlement-latency.mjs"],
    });

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.rule)).toEqual([
      "javascript:S7786",
      "javascript:S7755",
    ]);
  });

  it("keeps everything when the scope is the whole project", () => {
    expect(selectFindings(payload, { scope: "all", changed: [] })).toHaveLength(3);
  });

  it("reports nothing when the diff touches no file the analyzer flagged", () => {
    expect(selectFindings(payload, { scope: "changed", changed: ["README.md"] })).toEqual([]);
  });

  it("substitutes a placeholder rather than dropping a finding with missing fields", () => {
    const sparse = { total: 1, issues: [{ component: "keiko-local:a.mjs" }] };

    expect(selectFindings(sparse, { scope: "all", changed: [] })[0]).toEqual({
      rule: "unknown",
      severity: "UNKNOWN",
      path: "a.mjs",
      line: 0,
      message: "",
    });
  });
});

describe("reporting", () => {
  it("names every finding it selected, with rule, place and message", () => {
    const findings = selectFindings(payload, { scope: "all", changed: [] });
    const rendered = renderFindings(findings, payload, "all");

    expect(rendered).toContain("local-sonar: 3 finding(s)");
    expect(rendered).toContain("javascript:S7786  scripts/report-settlement-latency.mjs:172");
  });

  it("says so plainly when the diff is clean", () => {
    const rendered = renderFindings([], payload, "changed");

    expect(rendered).toContain("local-sonar: PASS");
    expect(rendered).toContain("the files you changed");
  });

  it("never presents a capped list as a complete one", () => {
    const capped = { total: 900, issues: payload.issues };

    expect(renderFindings([], capped, "all")).toContain("the server holds 900 finding(s)");
    expect(renderFindings([], payload, "all")).not.toContain("NOTE");
  });
});

describe("command line surface", () => {
  it("exits non-zero when a finding lands on a changed file", async () => {
    const setExitCode = vi.fn();
    const log = vi.fn();

    await executeLocalSonarCli({
      input: JSON.stringify(payload),
      scope: "changed",
      changed: "scripts/report-settlement-latency.mjs",
      log,
      setExitCode,
    });

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0][0]).toContain("2 finding(s)");
  });

  it("exits zero on a clean diff", async () => {
    const setExitCode = vi.fn();

    await executeLocalSonarCli({
      input: JSON.stringify(payload),
      scope: "changed",
      changed: "README.md",
      log: vi.fn(),
      setExitCode,
    });

    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it("reads the payload from stdin when none is supplied", async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const setExitCode = vi.fn();

    await executeLocalSonarCli({ read, scope: "all", log: vi.fn(), setExitCode });

    expect(read).toHaveBeenCalled();
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("fails loud and non-zero when the payload cannot be read", async () => {
    const error = vi.fn();
    const setExitCode = vi.fn();

    await executeLocalSonarCli({ input: "{}", log: vi.fn(), error, setExitCode });

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain("local-sonar: FAIL");
  });

  it("splits the changed-file list the shell hands over", () => {
    const findings = runLocalSonarReport({
      input: JSON.stringify(payload),
      scope: "changed",
      changed:
        "scripts/report-settlement-latency.mjs\n\n  packages/keiko-server/src/untouched.ts  ",
      log: vi.fn(),
    });

    expect(findings).toHaveLength(3);
  });
});
