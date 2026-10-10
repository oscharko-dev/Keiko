import { describe, expect, it } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import { parseFailureEvidence } from "../bug-investigation/failure-parse.js";
import { createExplorationPlan, type ExplorationPlan } from "./plan.js";
import { classifyRetrievalIntent } from "./intent.js";

const NOW = 1_700_000_000_000;
const SCOPE: SelectedScope = {
  schemaVersion: "1",
  scopeId: "diagnostic-references",
  workspaceRoot: "/diagnostic-fixture",
  kind: "workspace-root",
  relativePaths: [],
  conversationId: "diagnostic-chat",
  connectedAtMs: NOW,
  explicitConnection: true,
};

function plan(
  text: string,
  previousRetrievalIntent?: "diagnostic-search" | "targeted-code-search",
): ExplorationPlan {
  return createExplorationPlan(
    {
      scope: SCOPE,
      query: {
        kind: "natural-language",
        text,
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: NOW,
      },
      ...Object.assign(
        {},
        previousRetrievalIntent === undefined ? {} : { previousRetrievalIntent },
      ),
    },
    { nowMs: (): number => NOW },
  );
}

describe("diagnostic references preserve the user-term channel", () => {
  it("does not let ten external frames evict three independent user identifiers", () => {
    const frames = Array.from(
      { length: 10 },
      (_value, index) =>
        `    at execute (/diagnostic-fixture/node_modules/tool-${String(index)}/runner.js:10:3)`,
    ).join("\n");
    const result = plan(`Why do PaymentValidator InputMapper ResultEmitter fail?\n${frames}`);
    expect(result.anchors.map((anchor) => anchor.term)).toEqual(
      expect.arrayContaining(["paymentvalidator", "inputmapper", "resultemitter"]),
    );
    expect(result.anchors.some((anchor) => anchor.term.includes("node_modules"))).toBe(false);
    expect(result).toMatchObject({ references: [] });
  });

  it("uses no anchors from a trace containing only external runtime frames", () => {
    const result = plan(
      "    at Object.get (/diagnostic-fixture/node_modules/vitest/runner.js:10:3)",
    );
    expect(result.anchors).toEqual([]);
    expect(result).toMatchObject({ references: [] });
  });

  it("keeps primary frame order, original path case and physical line hints", () => {
    const result = plan(
      [
        "Why does PaymentValidator fail?",
        "    at assertFact (src/Feature/Probe.test.ts:26:5)",
        "    at computeFact (src/Feature/Probe.ts:9:3)",
      ].join("\n"),
    );
    expect(result).toMatchObject({
      references: [
        { path: "src/Feature/Probe.test.ts", line: 26, origin: "diagnostic" },
        { path: "src/Feature/Probe.ts", line: 9, origin: "diagnostic" },
      ],
    });
    expect(result.anchors.map((anchor) => anchor.term)).toContain("paymentvalidator");
    expect(result.anchors.some((anchor) => anchor.kind === "path")).toBe(false);
  });

  it("caps query references at six in occurrence order independently of identifier capacity", () => {
    const paths = [
      "src/Z.ts",
      "src/A.ts",
      "src/Y.ts",
      "src/B.ts",
      "src/X.ts",
      "src/C.ts",
      "src/W.ts",
    ];
    const result = plan(`Explain PaymentValidator and ${paths.join(" ")}`);
    expect(result).toMatchObject({
      references: paths.slice(0, 6).map((path) => ({ path, origin: "query" })),
    });
    expect(result.anchors.map((anchor) => anchor.term)).toContain("paymentvalidator");
  });

  it("retains the explicit human location beside a full diagnostic channel", () => {
    const frames = Array.from(
      { length: 8 },
      (_value, index) => `    at execute (src/frame${String(index)}.ts:12:3)`,
    );
    const result = plan(["Explain src/z/final.ts:480.", ...frames].join("\n"));
    expect(result.references).toHaveLength(6);
    expect(result.references?.[0]).toEqual({
      path: "src/frame0.ts",
      line: 12,
      origin: "diagnostic",
    });
    expect(result.references).toContainEqual({
      path: "src/z/final.ts",
      line: 480,
      origin: "query",
    });
  });

  it("does not treat Object.get and a frame location as a direct HTTP-route lookup", () => {
    const result = plan("Why does this fail?\n    at Object.get (src/Feature/Probe.ts:9:3)");
    expect(result.directEvidenceLookup).toBe(false);
  });

  it("retains a genuine direct METHOD /route lookup", () => {
    expect(plan("Where is GET /api/payments implemented?").directEvidenceLookup).toBe(true);
  });
});

describe("conversational orientation retains diagnostic context", () => {
  it.each(["Was siehst du in der Datei?", "What can you see in that file?"])(
    "classifies a diagnostic follow-up independently of overview patterns: %s",
    (text) => {
      const result = plan(text, "diagnostic-search");
      expect(result.retrievalIntent).toBe("conversational-follow-up");
      expect(result).toMatchObject({ effectiveRetrievalIntent: "diagnostic-search" });
    },
  );

  it.each(["Was siehst du in diesem Repository?", "What can you see in this repository?"])(
    "preserves a genuine repository opener: %s",
    (text) => {
      expect(classifyRetrievalIntent(text, SCOPE).intent).toBe("repository-overview");
    },
  );
});

describe("shared failure parser supports diagnostic source formats", () => {
  it.each([
    { trace: "    at run (src/Feature/Probe.ts:9:3)", file: "src/Feature/Probe.ts", line: 9 },
    { trace: "    at example.Probe.execute(Probe.java:12)", file: "Probe.java", line: 12 },
    {
      trace: '  File "src/Feature/probe.py", line 17, in execute',
      file: "src/Feature/probe.py",
      line: 17,
    },
  ])(
    "preserves source location $file:$line through the existing parser",
    ({ trace, file, line }) => {
      expect(parseFailureEvidence({ stackTrace: trace }).frames).toContainEqual({ file, line });
    },
  );
});
