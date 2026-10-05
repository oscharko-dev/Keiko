import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type ExplorationBudget,
  type ConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { buildGroundedGatewayMessages, fittedGroundedGatewayPrompt } from "./grounded-qa.js";
import { buildRedactor } from "./deps.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { retrieveConnectedContextPack, type OrchestratorInput } from "./grounded-orchestrator.js";

const NOW = 1_784_653_600_000;
let root = "";

function request(budget?: ExplorationBudget): OrchestratorInput {
  return {
    workspaceRoot: root,
    scope: {
      schemaVersion: "1",
      scopeId: "scope",
      workspaceRoot: root,
      kind: "workspace-root",
      relativePaths: [],
      conversationId: "chat",
      connectedAtMs: NOW,
      explicitConnection: true,
    },
    query: {
      kind: "exact-symbol",
      text: "FactProbe",
      caseSensitive: true,
      maxResults: 100,
      emittedAtMs: NOW,
    },
    ...(budget === undefined ? {} : { budget }),
  };
}

function completePhysicalFacts(pack: ConnectedContextPack): number {
  return pack.files.filter((file) => {
    const source = readFileSync(join(root, file.scopePath), "utf8");
    for (const excerpt of file.excerpts) {
      expect(source).toContain(excerpt.content);
      expect(excerpt.atom.lineRange?.startLine).toBe(1);
    }
    return file.excerpts.some((excerpt) => excerpt.content.includes(source.trimEnd()));
  }).length;
}

async function retrieve(
  budget?: ExplorationBudget,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  return retrieveConnectedContextPack(request(budget), {
    correlationId: undefined,
    nowMs: () => NOW,
    answerer: { answer: (): Promise<string> => Promise.resolve("Unused retrieval-only answerer.") },
  });
}

function observedByteReads(active: { value: number; peak: number }): WorkspaceFs {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new Error("Physical byte-read fixture is unavailable.");
  return {
    ...nodeWorkspaceFs,
    readFileBytes: async (...args): Promise<Uint8Array> => {
      active.value += 1;
      active.peak = Math.max(active.peak, active.value);
      try {
        return await read(...args);
      } finally {
        active.value -= 1;
      }
    },
  };
}

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-default-reads-"));
  mkdirSync(join(root, "facts"));
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(
      join(root, "facts", `fact-${String(index).padStart(2, "0")}.txt`),
      `FactProbe value=${String(index)}\n`,
    );
  }
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

describe("default connected-folder file reads", () => {
  it("retains the finite excerpt byte budget without a default read-count ceiling", async (): Promise<void> => {
    const { pack } = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, excerptBytesMax: 100 });
    expect(pack.usage.excerptBytes).toBeLessThanOrEqual(100);
    expect(pack.uncertainty.some((entry) => entry.kind === "scope-incomplete")).toBe(true);
    const retainedFacts = completePhysicalFacts(pack);
    expect(retainedFacts).toBeGreaterThan(0);
    expect(retainedFacts).toBeLessThan(40);
    expect(pack.omitted.some((entry) => entry.reason === "budget-exhausted")).toBe(true);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("fits the actual prompt to a smaller explicit model input budget", async (): Promise<void> => {
    const { pack } = await retrieve();
    const sent = fittedGroundedGatewayPrompt(
      "List every FactProbe value",
      pack,
      buildRedactor({}),
      { modelInputTokensMax: 2_000 },
    );
    expect(countGatewayPromptTokens({ messages: sent.messages })).toBeLessThanOrEqual(2_000);
    expect(sent.sentReferenceCount).toBeLessThan(sent.availableReferenceCount);
  });

  it("cancels an unlimited default retrieval before reading the connected folder", async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieveConnectedContextPack(request(), {
        correlationId: undefined,
        signal: controller.signal,
        answerer: {
          answer: (): Promise<string> => Promise.resolve("Unused retrieval-only answerer."),
        },
      }),
    ).rejects.toMatchObject({ name: "CancelledError" });
  });

  it("bounds simultaneous physical reads while retaining all forty facts", async (): Promise<void> => {
    const active = { value: 0, peak: 0 };
    const fs = observedByteReads(active);
    const { pack } = await retrieveConnectedContextPack(request(), {
      correlationId: undefined,
      fs,
      nowMs: () => NOW,
      answerer: {
        answer: (): Promise<string> => Promise.resolve("Unused retrieval-only answerer."),
      },
    });
    expect(pack.files).toHaveLength(40);
    expect(active.peak).toBeGreaterThan(1);
    expect(active.peak).toBeLessThanOrEqual(8);
  });

  it("retains forty tiny physical facts while real byte and model budgets fit", async (): Promise<void> => {
    const { pack } = await retrieve();
    expect(pack.files).toHaveLength(40);
    expect(pack.usage.filesRead).toBe(40);
    expect(pack.omitted).toEqual([]);
    expect(pack.usage.excerptBytes).toBeLessThan(pack.budget.excerptBytesMax);
    const messages = buildGroundedGatewayMessages(
      "List every FactProbe value",
      pack,
      (value) => value,
    );
    expect(countGatewayPromptTokens({ messages })).toBeLessThan(pack.budget.modelInputTokensMax);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });

  it("honors an explicitly supplied finite thirty-two-file budget", async (): Promise<void> => {
    const { pack } = await retrieve({ ...DEFAULT_EXPLORATION_BUDGET, filesReadMax: 32 });
    expect(pack.files).toHaveLength(32);
    expect(pack.omitted.filter((entry) => entry.reason === "budget-exhausted")).toHaveLength(8);
    expect(validateConnectedContextPack(pack)).toEqual({ ok: true });
  });
});
