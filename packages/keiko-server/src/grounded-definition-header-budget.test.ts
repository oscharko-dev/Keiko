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
import { buildGroundedGatewayMessages, buildQuery } from "./grounded-qa.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const NOW = 1_784_653_600_000;
const QUESTION =
  "Wo ist LateDefinitionProbe in den verbundenen Dateien implementiert? " +
  "Erstelle eine vollständige Tabelle für alle 96 Dateien mit Dateinummer, tatsächlichem " +
  "Rückgabewert und belegter Definitionszeile. Verwende nur gelesene Werte, keine Vermutungen. " +
  "Lange Kommentarblöcke vor der Funktion sind keine Implementierung. " +
  "Gib jeden Rückgabewert an und zitiere jede Definitionszeile.";
const HEADER = "// Unrelated source header padding\n";
let root = "";

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-definition-headers-"));
  for (let index = 1; index <= 96; index += 1) {
    const directory = join(root, `source-${String(index).padStart(3, "0")}`);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "LateDefinitionProbe.ts"),
      HEADER.repeat(300) +
        `export function LateDefinitionProbe(): number {\n  return ${String(10000 + index)};\n}\n`,
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
        scopeId: "definition-headers",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: NOW,
      },
      query: buildQuery(QUESTION, () => NOW),
      ...(budget === undefined ? {} : { budget }),
    },
    {
      correlationId: undefined,
      nowMs: () => NOW,
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
      },
    },
  );
  return pack;
}

function expectDefinitionValues(pack: ConnectedContextPack): void {
  for (const file of pack.files) {
    const index = Number(/source-(\d+)/u.exec(file.scopePath)?.[1]);
    const value = String(10000 + index);
    const excerpt = file.excerpts.find((entry) => entry.content.includes(`return ${value};`));
    if (excerpt?.atom.lineRange === undefined)
      throw new Error("Definition evidence is unavailable.");
    const lines = excerpt.content.split("\n");
    expect(
      excerpt.atom.lineRange.startLine +
        lines.findIndex((line) => line.includes("export function")),
    ).toBe(301);
    expect(
      excerpt.atom.lineRange.startLine +
        lines.findIndex((line) => line.includes(`return ${value};`)),
    ).toBe(302);
  }
}

describe("located definitions replace redundant discovery headers", () => {
  it("sends all ninety-six requested values without unrelated headers or header truncation", async (): Promise<void> => {
    const pack = await retrieve();
    expect(pack.files).toHaveLength(96);
    expect(pack.usage.filesRead).toBe(96);
    expectDefinitionValues(pack);
    const messages = buildGroundedGatewayMessages(QUESTION, pack, (value) => value);
    const prompt = JSON.stringify(messages);
    expect(pack.usage.excerptBytes).toBeLessThan(10_000);
    expect(prompt.includes(HEADER.trim())).toBe(false);
    expect(pack.uncertainty).toEqual([]);
    expect(pack.omitted).toEqual([]);
    expect(pack.diagnostics?.coverage?.incomplete).toBe(false);
    for (let index = 1; index <= 96; index += 1) {
      expect(prompt).toContain(`return ${String(10000 + index)};`);
    }
    expect(countGatewayPromptTokens({ messages })).toBeLessThan(pack.budget.modelInputTokensMax);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("preserves an explicit finite read budget while dropping only redundant headers", async (): Promise<void> => {
    const pack = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 2 });
    expect(pack.files).toHaveLength(2);
    expect(pack.usage.filesRead).toBe(2);
    expectDefinitionValues(pack);
    expect(pack.omitted.filter((entry) => entry.reason === "budget-exhausted")).toHaveLength(94);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("retains real truncation when requested definitions exceed an explicit byte budget", async (): Promise<void> => {
    const pack = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 96 });
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(96);
    expect(
      pack.uncertainty.some((entry) => entry.claim.includes("excerpt byte limit truncated")),
    ).toBe(true);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });
});
