import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
let root = "";
const deepDirectory = Array.from({ length: 45 }, () => "nested").join("/");

function writeFixture(scopePath: string, content: string): void {
  const slash = scopePath.lastIndexOf("/");
  if (slash !== -1) mkdirSync(join(root, scopePath.slice(0, slash)), { recursive: true });
  writeFileSync(join(root, scopePath), content);
}

function workspace(): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: "auxiliary-discovery",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function request(text: string): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "ordinary-auxiliary-root",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      explicitConnection: true,
      conversationId: undefined,
      connectedAtMs: NOW,
    },
    query: {
      kind: "natural-language",
      text,
      caseSensitive: false,
      maxResults: 50,
      emittedAtMs: NOW,
    },
  };
}

async function retrieve(text: string): Promise<ConnectedContextPack> {
  const output = await retrieveConnectedContextPack(request(text), {
    correlationId: undefined,
    answerer: { answer: () => Promise.reject(new Error("Retrieval must not call the model.")) },
    nowMs: () => NOW,
    detectWorkspace: workspace,
  });
  expect(output.plan.budget.filesReadMax).toBeNull();
  expect(output.pack.usage.excerptBytes).toBeLessThanOrEqual(output.plan.budget.excerptBytesMax);
  expect(validateConnectedContextPack(output.pack).ok).toBe(true);
  return output.pack;
}

function expectMultiSymbolRouting(
  output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>,
  direct: boolean,
): void {
  expect(output.plan.targetDecision?.kind).toBe(direct ? "direct-fact" : "contextual");
  // Both routes reuse verified declarations after the complete primary scan. Contextual
  // classification preserves the question while avoiding unrequested optional graph work.
  expect(output.pack.usage.searchCalls).toBe(2);
  expect(output.pack.uncertainty).toEqual([]);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-auxiliary-discovery-"));
  for (let index = 0; index < 10_020; index += 1) {
    writeFixture(`noise-${String(index).padStart(5, "0")}.txt`, "Unrelated text.\n");
  }
  for (let index = 0; index < 110; index += 1) {
    writeFixture(
      `fair-targets/${String(index).padStart(3, "0")}/FairAlphaProbe.ts`,
      "export function FairAlphaProbe(): number { return 73; }\n",
    );
  }
  writeFixture(
    "fair-targets/zzzz/FairBetaProbe.ts",
    "export function FairBetaProbe(): number { return 91; }\n",
  );
  writeFixture(
    "zzzz/LateAuxiliaryProbe.ts",
    "export function LateAuxiliaryProbe(): number { return 73; }\n",
  );
  writeFixture(
    "zzzz/ADR-987654-late.md",
    "# Discovery record\nThe documented interval is 730 hours.\n",
  );
  writeFixture(
    `${deepDirectory}/DeepAuxiliaryProbe.ts`,
    "export function DeepAuxiliaryProbe(): number { return 91; }\n",
  );
  writeFixture(
    `${deepDirectory}/ADR-987655-deep.md`,
    "# Deep record\nThe documented interval is 910 hours.\n",
  );
  for (let index = 0; index < 12; index += 1) {
    writeFixture(
      `zzzz/ADR-987656-record-${String(index).padStart(2, "0")}.md`,
      `Record ${String(index)}.\n`,
    );
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("grounded auxiliary discovery traverses the complete admitted scope", () => {
  it.each([
    {
      text: "Where are LateAuxiliaryProbe and DeepAuxiliaryProbe implemented? Find ADR-987654 and ADR-987655.",
      direct: true,
    },
    {
      text: "Untersuche den aktuell verbundenen Ordner rekursiv. Wo sind LateAuxiliaryProbe und DeepAuxiliaryProbe implementiert, und welche Werte liefern sie? Was steht in ADR-987654 und ADR-987655 zum Wartungsintervall? Nenne belegte Dateien und Zeilen und unterscheide fehlende Evidenz von nicht vorhandenen Dateien.",
      direct: false,
    },
  ])(
    "retains implementation and document facts under complete request routing: $text",
    async ({ text, direct }) => {
      const output = await retrieveConnectedContextPack(request(text), {
        correlationId: undefined,
        answerer: { answer: () => Promise.reject(new Error("Retrieval must not call the model.")) },
        nowMs: () => NOW,
        detectWorkspace: workspace,
      });
      expect(output.pack.files.map((file) => file.scopePath)).toEqual(
        expect.arrayContaining([
          "zzzz/LateAuxiliaryProbe.ts",
          `${deepDirectory}/DeepAuxiliaryProbe.ts`,
          "zzzz/ADR-987654-late.md",
          `${deepDirectory}/ADR-987655-deep.md`,
        ]),
      );
      expect(output.plan.targetDecision?.kind).toBe(direct ? "literal-search" : "contextual");
      if (direct) {
        expect(output.plan.rings.map((ring) => ring.kind)).toEqual(["lexical"]);
        expect(output.pack.usage.searchCalls).toBe(3);
        expect(output.pack.uncertainty).toEqual([]);
      } else expect(output.pack.usage.searchCalls).toBe(14);
      // Neighboring implementations share token fragments, but are not requested identifiers.
      expect(output.pack.diagnostics?.coverage?.reasons).toEqual([]);
      expect(validateConnectedContextPack(output.pack).ok).toBe(true);
    },
    60_000,
  );

  it.each([
    { text: "Where are DeepAuxiliaryProbe and FairBetaProbe implemented?", direct: true },
    {
      text: "Wo sind DeepAuxiliaryProbe und FairBetaProbe implementiert, und welche Werte liefern sie?",
      direct: false,
    },
  ])(
    "keeps independent exact content targets across request shapes: $text",
    async ({ text, direct }) => {
      const output = await retrieveConnectedContextPack(request(text), {
        correlationId: undefined,
        answerer: { answer: () => Promise.reject(new Error("Retrieval must not call the model.")) },
        nowMs: () => NOW,
        detectWorkspace: workspace,
      });
      expect(output.pack.files.map((file) => file.scopePath).sort()).toEqual(
        [`${deepDirectory}/DeepAuxiliaryProbe.ts`, "fair-targets/zzzz/FairBetaProbe.ts"].sort(),
      );
      expect(output.pack.diagnostics?.coverage?.filesDiscovered).toBeGreaterThan(10_000);
      expect(output.pack.diagnostics?.coverage?.incomplete).toBe(false);
      expect(output.pack.diagnostics?.coverage?.reasons).toEqual([]);
      expectMultiSymbolRouting(output, direct);
      expect(output.pack.usage.filesRead).toBe(2);
      expect(validateConnectedContextPack(output.pack).ok).toBe(true);
    },
    60_000,
  );

  it("retains document discovery for an explicit document-only fact question", async () => {
    const output = await retrieveConnectedContextPack(
      request(
        "Was steht in ADR-987654 und ADR-987655 zum Wartungsintervall? Nenne belegte Dateien und Zeilen.",
      ),
      {
        correlationId: undefined,
        answerer: { answer: () => Promise.reject(new Error("Retrieval must not call the model.")) },
        nowMs: () => NOW,
        detectWorkspace: workspace,
      },
    );
    expect(output.pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining(["zzzz/ADR-987654-late.md", `${deepDirectory}/ADR-987655-deep.md`]),
    );
    expect(output.plan.targetDecision?.kind).toBe("contextual");
    expect(output.pack.usage.searchCalls).toBe(11);
    expect(validateConnectedContextPack(output.pack).ok).toBe(true);
  }, 60_000);

  it("retains a separately requested implementation after more than 96 earlier matches", async () => {
    const input = request(
      "Where are FairAlphaProbe and FairBetaProbe implemented? Cite both actual files and lines.",
    );
    const output = await retrieveConnectedContextPack(
      {
        ...input,
        budget: { ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 32 },
        scope: { ...input.scope, kind: "directory", relativePaths: ["fair-targets"] },
      },
      {
        correlationId: undefined,
        answerer: { answer: () => Promise.reject(new Error("Retrieval must not call the model.")) },
        nowMs: () => NOW,
        detectWorkspace: workspace,
      },
    );
    expect(output.pack.files.some((file) => file.scopePath.endsWith("/FairAlphaProbe.ts"))).toBe(
      true,
    );
    const beta = output.pack.files.find((file) => file.scopePath.endsWith("/FairBetaProbe.ts"));
    expect(beta?.excerpts.some((excerpt) => excerpt.content.includes("return 91"))).toBe(true);
    expect(output.plan.budget.filesReadMax).toBe(32);
    expect(output.pack.usage.filesRead).toBeLessThanOrEqual(32);
    expect(output.pack.diagnostics?.coverage?.reasons).toContain("match-cap");
    const symbolCoverage = output.pack.uncertainty.find((marker) =>
      marker.claim.startsWith("Symbol file discovery"),
    );
    expect(symbolCoverage?.kind).toBe("budget-clipped");
    expect(symbolCoverage?.claim).toContain("all eligible files were searched");
    expect(symbolCoverage?.claim).toContain("additional matching results were omitted");
    expect(validateConnectedContextPack(output.pack).ok).toBe(true);
  });

  it("retains each requested document reference within its existing bounded output", async () => {
    const pack = await retrieve("Summarize ADR-987656 and ADR-987654 precisely.");
    expect(pack.files.some((file) => file.scopePath === "zzzz/ADR-987654-late.md")).toBe(true);
    expect(pack.files.filter((file) => file.scopePath.includes("ADR-987656"))).toHaveLength(8);
    expect(pack.files).toHaveLength(9);
  }, 60_000);

  it("keeps referenced-document output bounded while traversing every admitted file", async () => {
    const pack = await retrieve("Summarize ADR-987656 precisely.");
    const references = pack.files.filter((file) => file.scopePath.includes("ADR-987656"));
    expect(references).toHaveLength(8);
    const marker = pack.uncertainty.find((entry) =>
      entry.claim.startsWith("Document reference discovery"),
    );
    expect(marker?.claim).toContain("match-cap");
    expect(marker?.claim).not.toContain("file-cap");
    expect(marker?.kind).toBe("budget-clipped");
    expect(marker?.claim).toContain("all eligible files were searched");
  }, 60_000);

  it.each([
    ["LateAuxiliaryProbe", "zzzz/LateAuxiliaryProbe.ts"],
    ["DeepAuxiliaryProbe", `${deepDirectory}/DeepAuxiliaryProbe.ts`],
  ])(
    "finds the %s implementation without an implicit corpus ceiling",
    async (symbol, scopePath) => {
      const pack = await retrieve(`Wo ist ${symbol} implementiert? Nenne die Datei und Zeile.`);
      const selected = pack.files.find((file) => file.scopePath === scopePath);
      expect(selected).toBeDefined();
      expect(selected?.excerpts.some((excerpt) => excerpt.content.includes(symbol))).toBe(true);
      expect(
        pack.uncertainty.some((marker) => marker.claim.startsWith("Symbol file discovery")),
      ).toBe(false);
    },
    60_000,
  );

  it.each([
    ["ADR-987654", "zzzz/ADR-987654-late.md"],
    ["ADR-987655", `${deepDirectory}/ADR-987655-deep.md`],
  ])(
    "finds referenced %s beyond default file and depth ceilings",
    async (reference, scopePath) => {
      const pack = await retrieve(`Summarize ${reference} precisely.`);
      const selected = pack.files.find((file) => file.scopePath === scopePath);
      expect(selected).toBeDefined();
      expect(
        selected?.excerpts.some((excerpt) => excerpt.atom.provenance.tool === "repo.findFiles"),
      ).toBe(true);
      expect(
        pack.uncertainty.some((marker) => marker.claim.startsWith("Document reference discovery")),
      ).toBe(false);
    },
    60_000,
  );
});
