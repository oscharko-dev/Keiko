import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  D12_PINNED_BASELINE_SOURCE_TREE_SHA256,
  evaluateGateTarget,
  executePerfEvidenceCli,
  freshnessOptionsFor,
  gateModeLines,
  parseCliArgs,
  readEvidence,
  reportSubjectDriftNotes,
  resolveGateIo,
  runGate,
} from "../perf-evidence-gate.mjs";

describe("gate mode wording", () => {
  it("says the evidence was measured with the current ruler when subject drift is only reported", () => {
    const lines = gateModeLines(false, true);

    expect(lines.ok("editor", "abc1234")).toContain("measured with the current ruler @ abc1234");
    expect(lines.pass).toContain("measured with the current toolchain");
  });

  it("says the evidence is fresh when source freshness is enforced", () => {
    const lines = gateModeLines(true, false);

    expect(lines.ok("editor", "abc1234")).toContain("evidence fresh @ abc1234");
    expect(lines.pass).toContain("within budget and fresh");
  });

  it("names the nightly lane as the owner of freshness when neither applies", () => {
    const lines = gateModeLines(false, false);

    expect(lines.ok("editor", "abc1234")).toContain("integrity verified @ abc1234");
    expect(lines.ok("editor", "abc1234")).toContain("owned by the nightly regeneration lane");
    expect(lines.pass).toContain("internally sound");
  });
});

describe("per-target gate evaluation", () => {
  const soundEvidence = { commit: "deadbee" };

  it("reports the unreadable evidence and evaluates nothing further", () => {
    const target = {
      name: "editor",
      path: "/does/not/exist.json",
      evaluate: () => {
        throw new Error("must not be called");
      },
    };

    const result = evaluateGateTarget(target, {}, gateModeLines(false, false), false);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/^editor: /u);
    expect(result.notes).toEqual([]);
  });

  it("prefixes a budget failure with the target name", () => {
    const directory = mkdtempSync(join(tmpdir(), "perf-gate-"));
    const path = join(directory, "evidence.json");
    writeFileSync(path, JSON.stringify(soundEvidence), "utf8");
    const target = {
      name: "editor",
      path,
      evaluate: () => ({ failures: ["p75 above budget"] }),
    };

    const result = evaluateGateTarget(target, {}, gateModeLines(false, false), false);

    expect(result.failures).toContain("editor budget: p75 above budget");
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("freshness options", () => {
  it("evaluates the toolchain digest unconditionally when there is no base ref", () => {
    const previous = process.env.KEIKO_PERF_EVIDENCE_BASE_REF;
    delete process.env.KEIKO_PERF_EVIDENCE_BASE_REF;

    const options = freshnessOptionsFor(false);

    expect(options.toolchainTouched).toBe(true);
    expect(options.enforceSourceFreshness).toBe(false);
    expect(options.dirtySubjectPaths).toEqual([]);
    expect(options.computeBaselineSourceTreeSha256()).toBe(D12_PINNED_BASELINE_SOURCE_TREE_SHA256);
    if (previous !== undefined) process.env.KEIKO_PERF_EVIDENCE_BASE_REF = previous;
  });

  it("evaluates the toolchain digest unconditionally when source freshness is enforced", () => {
    const previous = process.env.KEIKO_PERF_EVIDENCE_BASE_REF;
    process.env.KEIKO_PERF_EVIDENCE_BASE_REF = "HEAD";

    expect(freshnessOptionsFor(true).toolchainTouched).toBe(true);

    if (previous === undefined) delete process.env.KEIKO_PERF_EVIDENCE_BASE_REF;
    else process.env.KEIKO_PERF_EVIDENCE_BASE_REF = previous;
  });
});

describe("subject-drift notes", () => {
  it("prints every note and closes with the shared explanation", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    reportSubjectDriftNotes(["editor freshness: subject moved"]);

    const printed = log.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toContain("editor freshness: subject moved");
    expect(printed.at(-1)).toContain("no pull request is blocked by this");
    log.mockRestore();
  });

  it("prints nothing at all when there is no drift", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    reportSubjectDriftNotes([]);

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("gate verdict", () => {
  const sound = { failures: [], notes: [] };

  it("prints the pass line and returns zero when every target is sound", () => {
    const log = vi.fn();
    const fail = vi.fn();

    const code = runGate("all", false, false, {
      targets: [{ name: "editor" }],
      evaluateTarget: () => sound,
      log,
      fail,
    });

    expect(code).toBe(0);
    expect(fail).not.toHaveBeenCalled();
    expect(log.mock.calls.at(-1)[0]).toContain("perf-evidence: PASS");
  });

  it("prints every failure and asks for a non-zero exit when one target is not", () => {
    const error = vi.fn();
    const fail = vi.fn().mockReturnValue(1);

    const code = runGate("all", false, false, {
      targets: [{ name: "editor" }],
      evaluateTarget: () => ({ failures: ["p75 above budget", "p95 above budget"], notes: [] }),
      log: vi.fn(),
      error,
      fail,
    });

    expect(code).toBe(1);
    expect(fail).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toBe("perf-evidence: FAIL - p75 above budget");
  });

  it("routes the per-target OK line and the drift notes through the injected sink", () => {
    const log = vi.fn();

    runGate("all", false, false, {
      targets: [{ name: "editor" }],
      evaluateTarget: (target, options, lines, drift, sink) => {
        sink(lines.ok(target.name, "deadbee"));
        return { failures: [], notes: ["editor freshness: subject moved"] };
      },
      log,
      fail: vi.fn(),
    });

    const printed = log.mock.calls.map((call) => String(call[0]));
    // A partly-injected surface is worse than none: the caller must capture every line.
    expect(printed.some((line) => line.includes("editor OK"))).toBe(true);
    expect(printed.some((line) => line.includes("subject moved"))).toBe(true);
    expect(printed.at(-1)).toContain("perf-evidence: PASS");
  });

  it("defaults to the real sinks and the real per-target evaluation", () => {
    const deps = resolveGateIo();

    expect(deps.evaluateTarget).toBe(evaluateGateTarget);
    expect(typeof deps.log).toBe("function");
    expect(typeof deps.error).toBe("function");
    expect(typeof deps.fail).toBe("function");
    expect(deps.targets).toBeUndefined();
  });
});

describe("command line dispatch", () => {
  function harness(extra = {}) {
    return { log: vi.fn(), error: vi.fn(), setExitCode: vi.fn(), gate: vi.fn(), ...extra };
  }

  it("refuses --report-subject-drift without the enforcing mode", () => {
    const io = harness();

    executePerfEvidenceCli(["--report-subject-drift"], io);

    expect(io.setExitCode).toHaveBeenCalledWith(2);
    expect(io.error.mock.calls[0][0]).toContain("requires --enforce-source-freshness");
    expect(io.gate).not.toHaveBeenCalled();
  });

  it("prints the subject digest and runs no gate", () => {
    const io = harness({ digest: () => "abc123" });

    executePerfEvidenceCli(["--print-source-tree-sha256"], io);

    expect(io.log).toHaveBeenCalledWith("abc123");
    expect(io.gate).not.toHaveBeenCalled();
  });

  it("routes --target editor and the empty invocation to the right lane", () => {
    const editor = harness();
    executePerfEvidenceCli(["--target", "editor"], editor);
    expect(editor.gate).toHaveBeenCalledWith("editor", false, false);

    const all = harness();
    executePerfEvidenceCli([], all);
    expect(all.gate).toHaveBeenCalledWith("all", false, false);
  });

  it("passes both flags through when they are given together", () => {
    const io = harness();

    executePerfEvidenceCli(["--enforce-source-freshness", "--report-subject-drift"], io);

    expect(io.gate).toHaveBeenCalledWith("all", true, true);
  });

  it("prints the usage and exits two on anything else", () => {
    const io = harness();

    executePerfEvidenceCli(["--target", "nonsense"], io);

    expect(io.setExitCode).toHaveBeenCalledWith(2);
    expect(io.error.mock.calls[0][0]).toContain("usage:");
  });

  it("separates flags from positionals whatever their order", () => {
    expect(parseCliArgs(["--target", "editor", "--enforce-source-freshness"])).toEqual({
      enforceSourceFreshness: true,
      reportSubjectDrift: false,
      positional: ["--target", "editor"],
    });
  });

  it("defaults to the real gate and the real sinks", () => {
    const io = harness({ gate: undefined });

    executePerfEvidenceCli(["--report-subject-drift"], {
      setExitCode: io.setExitCode,
      error: io.error,
    });

    expect(io.setExitCode).toHaveBeenCalledWith(2);
  });
});

describe("gate target selection", () => {
  it("resolves the real editor target when none is injected", () => {
    const seen = [];
    const code = runGate("editor", false, false, {
      evaluateTarget: (target) => {
        seen.push(target.name);
        return { failures: [], notes: [] };
      },
      log: vi.fn(),
      fail: vi.fn(),
    });

    expect(code).toBe(0);
    expect(seen).toEqual(["editor"]);
  });

  it("resolves both real targets for the full run", () => {
    const seen = [];
    runGate("all", false, false, {
      evaluateTarget: (target) => {
        seen.push(target.name);
        return { failures: [], notes: [] };
      },
      log: vi.fn(),
      fail: vi.fn(),
    });

    expect(seen).toEqual(["workspace", "editor"]);
  });
});

describe("evidence reading", () => {
  it("reports an unreadable file as an error instead of throwing", () => {
    const directory = mkdtempSync(join(tmpdir(), "gate-read-"));
    const path = join(directory, "broken.json");
    writeFileSync(path, "not json{", "utf8");

    expect(readEvidence(path).error).toMatch(/unreadable evidence file/u);
    rmSync(directory, { recursive: true, force: true });
  });

  it("prints the OK line when a real evidence document passes its target", () => {
    // A minimal document that satisfies the unconditional freshness invariants: a stamped source
    // tree, a parseable measurement instant, and a commit reachable from HEAD.
    const directory = mkdtempSync(join(tmpdir(), "gate-ok-"));
    const path = join(directory, "sound.json");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(
      path,
      JSON.stringify({
        commit: head,
        sourceTreeSha256: "a".repeat(64),
        measuredAtIso: "2026-07-26T12:00:00.000Z",
      }),
      "utf8",
    );
    const log = vi.fn();

    const result = evaluateGateTarget(
      { name: "editor", path, evaluate: () => ({ failures: [] }) },
      { toolchainTouched: false },
      gateModeLines(false, false),
      false,
      log,
    );

    expect(result.failures).toEqual([]);
    expect(log.mock.calls[0][0]).toContain("editor OK");
    rmSync(directory, { recursive: true, force: true });
  });
});
