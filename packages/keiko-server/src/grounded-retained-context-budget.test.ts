import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ExplorationBudget,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { buildGroundedGatewayMessages, buildQuery } from "./grounded-qa.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const NOW = 1_784_653_600_000;
let root = "";

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-retained-capacity-"));
  mkdirSync(join(root, "facts"));
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function createFacts(count: number, padding = 0): void {
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(
      join(root, "facts", `entry-${String(index).padStart(4, "0")}.ts`),
      `export function CapacityProbe(){ /*${"x".repeat(padding)}*/ return ${String(10000 + index)};}\n`,
    );
  }
}

function question(count: number): string {
  return `Wo ist CapacityProbe implementiert? Nenne alle ${String(count)} tatsächlichen Rückgabewerte mit belegten Dateien und Definitionszeilen.`;
}

async function retrieve(
  count: number,
  maxResults?: number,
  budget?: ExplorationBudget,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  const query = buildQuery(question(count), () => NOW);
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "retained-capacity",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: NOW,
      },
      query: maxResults === undefined ? query : { ...query, maxResults },
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
}

describe("retained results follow accepted context capacity", () => {
  it("retains each requested identifier fact independently of the requested numeric row count", async (): Promise<void> => {
    for (let index = 1; index <= 256; index += 1) {
      writeFileSync(
        join(root, "facts", `entry-${String(index)}.txt`),
        `CompactFactProbe ${String(10000 + index)}\n`,
      );
    }
    const content =
      "Suche rekursiv nach CompactFactProbe. Nenne für alle 256 Einträge den tatsächlich gelesenen fünfstelligen Wert als kompakte Tabelle mit Nummer, Wert und belegter Datei/Zeile. Verwende nur gelesene Werte, keine Vermutungen.";
    const input = await retrieveConnectedContextPack(
      {
        workspaceRoot: root,
        scope: {
          schemaVersion: "1",
          scopeId: "compact-facts",
          workspaceRoot: root,
          kind: "workspace-root",
          relativePaths: [],
          explicitConnection: true,
          conversationId: "chat",
          connectedAtMs: NOW,
        },
        query: buildQuery(content, () => NOW),
      },
      {
        correlationId: undefined,
        nowMs: () => NOW,
        answerer: {
          answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
        },
      },
    );
    const pack = input.pack;
    expect(pack.files).toHaveLength(256);
    expect(pack.usage.filesRead).toBe(256);
    const messages = buildGroundedGatewayMessages(content, pack, (value) => value);
    const prompt = JSON.stringify(messages);
    for (let index = 1; index <= 256; index += 1)
      expect(prompt.includes(`CompactFactProbe ${String(10000 + index)}`)).toBe(true);
    expect(pack.uncertainty).toEqual([]);
    expect(pack.omitted).toEqual([]);
  });

  it("retains all256 independently requested facts when the actual gateway prompt fits", async (): Promise<void> => {
    createFacts(256);
    const { pack } = await retrieve(256);
    expect(pack.files).toHaveLength(256);
    expect(pack.usage.filesRead).toBe(256);
    expect(pack.diagnostics?.coverage).toMatchObject({ filesScanned: 256, incomplete: false });
    expect(pack.omitted).toEqual([]);
    expect(pack.uncertainty).toEqual([]);
    const messages = buildGroundedGatewayMessages(question(256), pack, (value) => value);
    const prompt = JSON.stringify(messages);
    for (let index = 1; index <= 256; index += 1) {
      expect(prompt.includes(`return ${String(10000 + index)};`)).toBe(true);
    }
    expect(pack.usage.excerptBytes).toBeLessThan(pack.budget.excerptBytesMax);
    expect(countGatewayPromptTokens({ messages })).toBeLessThan(pack.budget.modelInputTokensMax);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("preserves explicitly requested fifty retained matches", async (): Promise<void> => {
    createFacts(256);
    const { pack } = await retrieve(256, 50);
    expect(pack.files).toHaveLength(50);
    expect(pack.diagnostics?.coverage?.filesScanned).toBe(256);
    expect(pack.diagnostics?.coverage?.reasons).toContain("match-cap");
  });

  it("retains useful initial evidence when a large matching set exceeds the real byte budget", async (): Promise<void> => {
    createFacts(2048, 300);
    const { pack } = await retrieve(2048);
    expect(pack.diagnostics?.coverage?.filesScanned).toBe(2048);
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.files.length).toBeLessThan(2048);
    expect(
      pack.files.some((file) => file.excerpts.some((entry) => /return \d+;/u.test(entry.content))),
    ).toBe(true);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(pack.budget.excerptBytesMax);
    expect(pack.omitted.some((entry) => entry.reason === "budget-exhausted")).toBe(true);
    expect(pack.uncertainty.some((entry) => entry.kind === "budget-clipped")).toBe(true);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("preserves useful evidence with an explicit tiny byte capacity", async (): Promise<void> => {
    createFacts(256);
    const { pack } = await retrieve(256, undefined, {
      ...DEFAULT_EXPLORATION_BUDGET,
      excerptBytesMax: 256,
    });
    expect(
      pack.files.some((file) => file.excerpts.some((entry) => /return \d+;/u.test(entry.content))),
    ).toBe(true);
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(256);
    expect(pack.omitted.some((entry) => entry.reason === "budget-exhausted")).toBe(true);
  });
});
