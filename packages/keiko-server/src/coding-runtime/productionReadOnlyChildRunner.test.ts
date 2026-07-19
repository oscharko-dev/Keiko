import { describe, expect, it } from "vitest";

import type { CodeTaskChildRunId } from "@oscharko-dev/keiko-contracts";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";

import { createProductionReadOnlyChildRunner } from "./productionReadOnlyChildRunner.js";
import type { ReadOnlyChildGateDecision } from "./readOnlyChildOrchestrator.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    modelId: "child-model",
    content: "Repository inspected",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "child-request",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
    ...overrides,
  };
}

/** One tool-calling turn, then a plain finish — the shape a real child session actually takes. */
function toolThenFinish(
  name: string,
  args: Record<string, unknown>,
): () => Promise<NormalizedResponse> {
  let turn = 0;
  return (): Promise<NormalizedResponse> => {
    turn += 1;
    return Promise.resolve(
      turn === 1
        ? response({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: `call-${String(turn)}`, name, arguments: args }],
          })
        : response(),
    );
  };
}

interface RunInput {
  readonly read?: SecureWorkspaceTextReadPort | undefined;
  readonly call?: (() => Promise<NormalizedResponse>) | undefined;
  readonly gate?: (() => ReadOnlyChildGateDecision) | undefined;
  readonly signal?: AbortSignal | undefined;
}

function runChild(
  input: RunInput = {},
): ReturnType<ReturnType<typeof createProductionReadOnlyChildRunner>["run"]> {
  const runner = createProductionReadOnlyChildRunner({
    modelPortFactory: () => ({
      call: input.call ?? ((): Promise<NormalizedResponse> => Promise.resolve(response())),
    }),
    secureWorkspaceTextRead: input.read ?? {
      readText: (): ReturnType<SecureWorkspaceTextReadPort["readText"]> =>
        Promise.resolve({ ok: true as const, text: "file text" }),
    },
  });
  return runner.run({
    envelope: {
      parentRunId: "run-2387",
      childRunId: "chr_test-child" as CodeTaskChildRunId,
      childDepth: 1,
      oneLayer: true,
      allowedActionClasses: ["workspace-read"],
      networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
      canMintGrant: false,
    },
    objective: "Inspect repository",
    modelId: "child-model",
    workspaceRoot: "/workspace",
    maxToolCalls: 2,
    signal: input.signal ?? new AbortController().signal,
    gate: input.gate ?? ((): ReadOnlyChildGateDecision => ({ ok: true })),
  });
}

describe("createProductionReadOnlyChildRunner", () => {
  it("runs a bounded harness session and reports a digest when the model calls no tool", async () => {
    const outcome = await runChild();

    expect(outcome.resultCount).toBe(0);
    expect(outcome.resultDigest.outcome).toBe("known");
  });

  it("executes an approved read_file call through the parent's secure read port", async () => {
    const requested: string[] = [];

    const outcome = await runChild({
      call: toolThenFinish("read_file", { relativePath: "src/index.ts" }),
      read: {
        readText: (request) => {
          requested.push(request.relativePath);
          return Promise.resolve({ ok: true as const, text: "export const value = 1;" });
        },
      },
    });

    expect(requested).toEqual(["src/index.ts"]);
    expect(outcome.resultCount).toBe(1);
  });

  it("denies a tool the child was never given, without touching the workspace", async () => {
    let reads = 0;

    const outcome = await runChild({
      call: toolThenFinish("write_file", { relativePath: "src/index.ts", text: "mutated" }),
      read: {
        readText: () => {
          reads += 1;
          return Promise.resolve({ ok: true as const, text: "unreachable" });
        },
      },
    });

    expect(reads).toBe(0);
    expect(outcome.resultCount).toBe(0);
  });

  it("denies a read the parent authority gate rejects", async () => {
    let reads = 0;

    const outcome = await runChild({
      call: toolThenFinish("read_file", { relativePath: "src/index.ts" }),
      gate: (): ReadOnlyChildGateDecision => ({
        ok: false,
        terminal: "denied",
        reasonCode: "authority-revoked",
      }),
      read: {
        readText: () => {
          reads += 1;
          return Promise.resolve({ ok: true as const, text: "unreachable" });
        },
      },
    });

    expect(reads).toBe(0);
    expect(outcome.resultCount).toBe(0);
  });

  it("rejects a non-string relativePath instead of forwarding it to the read port", async () => {
    let reads = 0;

    const outcome = await runChild({
      call: toolThenFinish("read_file", { relativePath: { nested: "../../etc/passwd" } }),
      read: {
        readText: () => {
          reads += 1;
          return Promise.resolve({ ok: true as const, text: "unreachable" });
        },
      },
    });

    expect(reads).toBe(0);
    expect(outcome.resultCount).toBe(0);
  });

  it("does not count a denied read from the secure port as a result", async () => {
    const outcome = await runChild({
      call: toolThenFinish("read_file", { relativePath: "../outside" }),
      read: { readText: () => Promise.resolve({ ok: false as const, reason: "denied" as const }) },
    });

    expect(outcome.resultCount).toBe(0);
  });

  it("fails closed when no model port resolves for the child model id", async () => {
    const runner = createProductionReadOnlyChildRunner({
      modelPortFactory: () => undefined,
      secureWorkspaceTextRead: {
        readText: () => Promise.resolve({ ok: true as const, text: "text" }),
      },
    });

    await expect(
      runner.run({
        envelope: {
          parentRunId: "run-2387",
          childRunId: "chr_test-child" as CodeTaskChildRunId,
          childDepth: 1,
          oneLayer: true,
          allowedActionClasses: ["workspace-read"],
          networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
          canMintGrant: false,
        },
        objective: "Inspect repository",
        modelId: "child-model",
        workspaceRoot: "/workspace",
        maxToolCalls: 2,
        signal: new AbortController().signal,
        gate: () => ({ ok: true }),
      }),
    ).rejects.toThrow("child-model-unavailable");
  });
});
