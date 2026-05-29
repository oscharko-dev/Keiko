import { describe, expect, it } from "vitest";
import { runEvidenceCli } from "../../src/cli/evidence.js";
import { createInMemoryEvidenceStore, type EvidenceStore } from "../../src/audit/store.js";
import type { CliIo } from "../../src/cli/runner.js";
import type { EvidenceManifest } from "../../src/audit/types.js";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

function manifest(runId: string): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "0.1.0",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 150,
      durationMs: 50,
    },
    model: { modelId: "m1", costClass: "low" },
    usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

function seededStore(runIds: readonly string[]): EvidenceStore {
  const store = createInMemoryEvidenceStore();
  for (const runId of runIds) {
    store.put(runId, JSON.stringify(manifest(runId)));
  }
  return store;
}

describe("keiko evidence list", () => {
  it("prints sorted runIds in text and exits 0", () => {
    const c = capture();
    const code = runEvidenceCli(["list"], c.io, { store: seededStore(["run-b", "run-a"]) });
    expect(code).toBe(0);
    expect(c.out().indexOf("run-a")).toBeLessThan(c.out().indexOf("run-b"));
  });

  it("emits a JSON array with --json", () => {
    const c = capture();
    const code = runEvidenceCli(["list", "--json"], c.io, { store: seededStore(["run-a"]) });
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(c.out());
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { runId: string }[])[0]?.runId).toBe("run-a");
  });

  it("reports an empty store gracefully", () => {
    const c = capture();
    const code = runEvidenceCli(["list"], c.io, { store: createInMemoryEvidenceStore() });
    expect(code).toBe(0);
    expect(c.out().toLowerCase()).toContain("no evidence");
  });
});

describe("keiko evidence show", () => {
  it("prints the report for a known runId and exits 0", () => {
    const c = capture();
    const code = runEvidenceCli(["show", "run-a"], c.io, { store: seededStore(["run-a"]) });
    expect(code).toBe(0);
    expect(c.out()).toContain("run-a");
    expect(c.out()).toContain("explain-plan");
  });

  it("emits the full manifest with --json", () => {
    const c = capture();
    const code = runEvidenceCli(["show", "run-a", "--json"], c.io, {
      store: seededStore(["run-a"]),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out()) as EvidenceManifest;
    expect(parsed.evidenceSchemaVersion).toBe("1");
    expect(parsed.run.runId).toBe("run-a");
  });

  it("exits 1 for an absent runId", () => {
    const c = capture();
    const code = runEvidenceCli(["show", "run-z"], c.io, { store: seededStore(["run-a"]) });
    expect(code).toBe(1);
    expect(c.err()).toContain("run-z");
  });

  it("exits 2 with usage when no runId is given", () => {
    const c = capture();
    const code = runEvidenceCli(["show"], c.io, { store: seededStore(["run-a"]) });
    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("requires a <runid>");
  });

  it("exits 2 for an invalid runId (path traversal)", () => {
    const c = capture();
    const code = runEvidenceCli(["show", "../escape"], c.io, { store: seededStore(["run-a"]) });
    expect(code).toBe(2);
  });

  it("exits 1 (no unhandled throw) on a corrupt/unparseable manifest (C1)", () => {
    const c = capture();
    const store = createInMemoryEvidenceStore();
    store.put("run-corrupt", '{"evidenceSchemaVersion": "1", run');
    const code = runEvidenceCli(["show", "run-corrupt"], c.io, { store });
    expect(code).toBe(1);
    expect(c.err().length).toBeGreaterThan(0);
  });
});

describe("keiko evidence usage errors", () => {
  it("exits 2 for an unknown subcommand", () => {
    const c = capture();
    const code = runEvidenceCli(["frobnicate"], c.io, { store: createInMemoryEvidenceStore() });
    expect(code).toBe(2);
    expect(c.err()).toContain("unknown subcommand");
  });

  it("exits 2 for a missing subcommand", () => {
    const c = capture();
    const code = runEvidenceCli([], c.io, { store: createInMemoryEvidenceStore() });
    expect(code).toBe(2);
    expect(c.err().toLowerCase()).toContain("usage");
  });
});
