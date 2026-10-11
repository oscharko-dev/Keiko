import { describe, expect, it, vi } from "vitest";
import { testSourcePairingAdapter } from "@oscharko-dev/keiko-workspace/code-intelligence";
import { INCIDENT_RETRIEVAL_FILES } from "../../../scripts/check-retrieval-quality.mjs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const TEST_PATH = "src/Feature/Probe.test.ts";
const SOURCE_PATH = "src/Feature/Probe.ts";
const FILES = {
  ...INCIDENT_RETRIEVAL_FILES,
  [TEST_PATH]: [
    'import { expect, it } from "vitest";',
    'import { computedFact } from "./Probe";',
    ...Array.from({ length: 23 }, () => ""),
    'it("preserves the computed fact", () => expect(computedFact).toBe(73));',
    "",
  ].join("\n"),
  [SOURCE_PATH]: "export const computedFact = 73;\n",
  "package.json": JSON.stringify({
    name: "diagnostic-fixture",
    engines: { node: ">=24" },
  }),
};

describe("diagnostic retrieval uses references without injecting toolchain metadata", () => {
  it("preserves the canonical mixed-case path at the structural pairing caller", async () => {
    const lookup = vi.spyOn(testSourcePairingAdapter, "lookup");
    try {
      await runConnectedRetrievalEval({
        files: FILES,
        query: `Investigate ${TEST_PATH}`,
        correlationId: "diagnostic-structural-case-pair",
      });
      const callIndex = lookup.mock.calls.findIndex(
        ([, query]) => query.text.toLowerCase() === TEST_PATH.toLowerCase(),
      );
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(lookup.mock.calls[callIndex]?.[1].text).toBe(TEST_PATH);
      const result = lookup.mock.results[callIndex];
      if (result?.type !== "return") {
        throw new Error("The structural pairing caller did not return a result.");
      }
      const atoms = await result.value;
      expect(atoms.map((atom) => atom.scopePath)).toEqual([SOURCE_PATH]);
      expect(atoms[0]?.provenance.tool).toBe("test-source-pairing");
    } finally {
      lookup.mockRestore();
    }
  });

  it("reads the mixed-case assertion frame and its paired source through production orchestration", async () => {
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: FILES,
      query: `Why does this Vitest assertion fail?\nAssertionError: expected 73\n    at assertFact (${TEST_PATH}:26:5)`,
      activityLog: log,
      correlationId: "diagnostic-references-case-pair",
    });
    expect(pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([TEST_PATH, SOURCE_PATH]),
    );
    const excerpt = pack.files.find((file) => file.scopePath === TEST_PATH)?.excerpts[0];
    expect(excerpt?.content).toContain("expect(computedFact).toBe(73)");
    expect(excerpt?.atom.lineRange?.startLine).toBeLessThanOrEqual(26);
    expect(excerpt?.atom.lineRange?.endLine).toBeGreaterThanOrEqual(26);
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({
      stackTraceDetected: true,
      stackTraceInScopeFrameCount: 1,
      testSourcePairCount: 1,
      metadataInjectionReason: "none",
    });
    expect(JSON.stringify(log.events)).not.toContain(TEST_PATH);
  });

  it("does not inject package metadata for runtime frame tokens", async () => {
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: FILES,
      query: `Why does this assertion fail?\n    at Object.get (${TEST_PATH}:26:5)\n    at execute (node_modules/vitest/runner.js:10:3)`,
      activityLog: log,
      correlationId: "diagnostic-references-no-metadata",
    });
    expect(pack.files.map((file) => file.scopePath)).not.toContain("package.json");
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ stackTraceDetected: true, metadataInjectionReason: "none" });
  });

  it("still injects project metadata for a genuine Node-version question", async () => {
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: FILES,
      query: "Which Node version does this project use?",
      activityLog: log,
      correlationId: "diagnostic-references-genuine-metadata",
    });
    expect(pack.files.map((file) => file.scopePath)).toContain("package.json");
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ metadataInjectionReason: "intent" });
  });

  it("keeps history for admitted diagnostic sources and dependencies without unrelated co-commit files", async () => {
    const dependency = "src/Feature/limits.ts";
    const unrelated = "guides/navigation.md";
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: {
        ".git/HEAD": "ref: refs/heads/fixture\n",
        [TEST_PATH]: FILES[TEST_PATH],
        "package.json": FILES["package.json"],
        [SOURCE_PATH]: 'import { limit } from "./limits";\nexport const computedFact = limit;\n',
        [dependency]: "export const limit = 73;\n",
        [unrelated]: "Standalone customer navigation index.\n",
      },
      query: `Why does this assertion fail?\n    at Object.get (${TEST_PATH}:26:5)`,
      activityLog: log,
      correlationId: "diagnostic-reference-history-candidates",
    });
    expect(pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([TEST_PATH, SOURCE_PATH, dependency]),
    );
    expect(
      log.events.find((event) => event.op === "search.connected-context.completed")?.extra,
    ).toMatchObject({ executedRingKinds: ["lexical", "structural", "git-history"] });
    expect(pack.files.map((file) => file.scopePath)).not.toContain(unrelated);
    expect(pack.files.map((file) => file.scopePath)).not.toContain("package.json");
    expect(
      log.events.find((event) => event.op === "search.connected-context.source-details")?.extra,
    ).toMatchObject({ stackTraceAdmittedPathCount: 1, metadataInjectionReason: "none" });
    expect(JSON.stringify(log.events)).not.toContain(dependency);
  });
});
