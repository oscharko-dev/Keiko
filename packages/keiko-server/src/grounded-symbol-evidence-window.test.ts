import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ConnectedContextPack,
  type ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildGroundedGatewayMessages } from "./grounded-qa.js";
import { buildRedactor } from "./deps.js";

const NOW = 1_700_000_000_000;
let root = "";
const values = new Map<string, string>();

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-late-symbol-evidence-"));
  values.clear();
  for (let index = 0; index < 96; index += 1) {
    const path = `packages/source-${String(index)}/src/LateDefinitionProbe.ts`;
    const value = String(10_000 + index);
    values.set(path, value);
    mkdirSync(join(root, path, ".."), { recursive: true });
    const padding = "// Unrelated source header padding\n".repeat(300);
    writeFileSync(
      join(root, path),
      padding + `export function LateDefinitionProbe(): number {\n  return ${value};\n}\n`,
    );
  }
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(budget?: ExplorationBudget): Promise<ConnectedContextPack> {
  const { pack } = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "late-symbol-evidence",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: undefined,
        connectedAtMs: NOW,
      },
      query: {
        kind: "natural-language",
        text: "Wo ist LateDefinitionProbe implementiert? Nenne die Rückgabewerte sämtlicher Dateien mit Definitionszeile als Tabelle.",
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: NOW,
      },
      ...(budget === undefined ? {} : { budget }),
    },
    {
      correlationId: undefined,
      nowMs: () => NOW,
      answerer: {
        answer: (): Promise<string> => Promise.resolve("Unused retrieval-only answerer."),
      },
    },
  );
  return pack;
}

function expectRequestedDefinitions(pack: ConnectedContextPack): void {
  for (const file of pack.files) {
    const value = values.get(file.scopePath);
    if (value === undefined) throw new Error("fixture fact missing");
    const excerpt = file.excerpts.find((entry) => entry.content.includes(`return ${value};`));
    expect(excerpt).toBeDefined();
    const range = excerpt?.atom.lineRange;
    if (excerpt === undefined || range === undefined)
      throw new Error("definition evidence missing");
    const lines = excerpt.content.split("\n");
    expect(
      range.startLine +
        lines.findIndex((line) => line.includes("export function LateDefinitionProbe")),
    ).toBe(301);
    expect(range.startLine + lines.findIndex((line) => line.includes(`return ${value};`))).toBe(
      302,
    );
    expect(range.endLine).toBeGreaterThanOrEqual(302);
  }
}

describe("requested symbol definition excerpt priority", () => {
  it("retains all 96 late definitions under the default byte and model budgets", async () => {
    const pack = await retrieve();
    expect(pack.files).toHaveLength(96);
    expect(pack.usage.filesRead).toBe(96);
    expectRequestedDefinitions(pack);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(pack.budget.excerptBytesMax);
    expect(validateConnectedContextPack(pack).ok).toBe(true);
    const messages = buildGroundedGatewayMessages(pack.query.text, pack, buildRedactor({}));
    expect(countGatewayPromptTokens({ messages })).toBeLessThanOrEqual(
      pack.budget.modelInputTokensMax,
    );
    for (const value of values.values()) {
      expect(messages.at(-1)?.content).toContain(`return ${value};`);
    }
  });

  it("preserves an explicit finite file-read budget while prioritizing actual definitions", async () => {
    const pack = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2 });
    expect(pack.files).toHaveLength(2);
    expect(pack.usage.filesRead).toBe(2);
    expect(pack.omitted.filter((entry) => entry.reason === "budget-exhausted")).toHaveLength(94);
    expectRequestedDefinitions(pack);
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });

  it("clips honestly when an explicit byte budget cannot retain the requested definitions", async () => {
    const pack = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 96 });
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(96);
    expect(
      pack.uncertainty.some((marker) => marker.claim.includes("excerpt byte limit truncated")),
    ).toBe(true);
    const retainedDefinitions = pack.files.filter((file) => {
      const value = values.get(file.scopePath);
      if (value === undefined) throw new Error("fixture fact missing");
      return file.excerpts.some((excerpt) => excerpt.content.includes(`return ${value};`));
    });
    expect(retainedDefinitions.length).toBeGreaterThan(0);
    expect(retainedDefinitions.length).toBeLessThan(values.size);
    expectRequestedDefinitions({ ...pack, files: retainedDefinitions });
    expect(pack.omitted.some((entry) => entry.reason === "budget-exhausted")).toBe(true);
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });
});
