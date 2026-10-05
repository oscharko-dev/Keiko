import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
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
let root = "";

async function retrieve(
  maxResults?: number,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  const query = buildQuery(QUESTION, () => NOW);
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "late-definitions",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: NOW,
      },
      query: maxResults === undefined ? query : { ...query, maxResults },
    },
    {
      correlationId: undefined,
      nowMs: () => NOW,
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
      },
    },
  );
}

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-default-matches-"));
  mkdirSync(join(root, "definitions"));
  for (let index = 1; index <= 96; index += 1) {
    const name = `LateDefinition-${String(index).padStart(3, "0")}.ts`;
    const comments = Array.from({ length: 300 }, (_, line) => `// Background note ${String(line)}`);
    writeFileSync(
      join(root, "definitions", name),
      `${comments.join("\n")}\nexport function LateDefinitionProbe() { return ${String(10000 + index)}; }\n`,
    );
  }
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

describe("default connected-folder retained matches", () => {
  it("retains all ninety-six definitions when the actual evidence and prompt budgets fit", async (): Promise<void> => {
    const { pack, plan } = await retrieve();
    expect(plan.targetDecision?.kind).toBe("contextual");
    expect(plan.rings[0]?.kind).toBe("lexical");
    expect(pack.files).toHaveLength(96);
    expect(pack.diagnostics?.coverage).toMatchObject({
      filesDiscovered: 96,
      filesScanned: 96,
      incomplete: false,
    });
    expect(pack.usage.filesRead).toBe(96);
    const messages = buildGroundedGatewayMessages(QUESTION, pack, (value) => value);
    const promptText = JSON.stringify(messages);
    for (let index = 1; index <= 96; index += 1) {
      const file = pack.files.find((entry) =>
        entry.scopePath.endsWith(`LateDefinition-${String(index).padStart(3, "0")}.ts`),
      );
      expect(
        file?.excerpts.some(
          (entry) =>
            entry.content.includes(`return ${String(10000 + index)};`) &&
            entry.atom.lineRange !== undefined &&
            entry.atom.lineRange.startLine <= 301 &&
            entry.atom.lineRange.endLine >= 301,
        ),
      ).toBe(true);
      expect(promptText).toContain(`return ${String(10000 + index)};`);
    }
    expect(pack.omitted).toEqual([]);
    expect(pack.uncertainty).toEqual([]);
    expect(pack.usage.excerptBytes).toBeLessThan(pack.budget.excerptBytesMax);
    expect(countGatewayPromptTokens({ messages })).toBeLessThan(pack.budget.modelInputTokensMax);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("preserves an explicitly supplied fifty-match limit and its honest retention warning", async (): Promise<void> => {
    const { pack } = await retrieve(50);
    expect(pack.files).toHaveLength(50);
    expect(pack.usage.filesRead).toBe(50);
    expect(pack.diagnostics?.coverage).toMatchObject({ filesDiscovered: 96, filesScanned: 96 });
    expect(pack.diagnostics?.coverage?.reasons).toContain("match-cap");
    expect(pack.uncertainty.some((entry) => entry.kind === "budget-clipped")).toBe(true);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });
});
