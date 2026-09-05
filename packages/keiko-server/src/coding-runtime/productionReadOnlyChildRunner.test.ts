import { describe, expect, it } from "vitest";

import type { CodeTaskChildRunId } from "@oscharko-dev/keiko-contracts";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  CHILD_WORKSPACE_READ_ALIAS,
  createToolInvocationNormalizer,
} from "@oscharko-dev/keiko-tool-catalog";

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

/**
 * One tool-calling turn, then a plain finish — the shape a real child session actually takes.
 * Binds the call to the harness's advertised catalog exactly the way a real provider adapter now
 * must (mirrors packages/keiko-harness/src/_support.ts's scriptedModel) -- the mandatory catalog
 * dispatch path (catalog-runtime.ts) rejects a toolCall with no bound `invocation`.
 */
function toolThenFinish(
  name: string,
  args: Record<string, unknown>,
): (request: GatewayCallRequest) => Promise<NormalizedResponse> {
  let turn = 0;
  return (request): Promise<NormalizedResponse> => {
    turn += 1;
    if (turn !== 1) return Promise.resolve(response());
    const invocation =
      request.toolCatalog === undefined
        ? undefined
        : createToolInvocationNormalizer({
            catalog: request.toolCatalog.catalog,
            projection: request.toolCatalog.projection,
            offered: request.toolCatalog.offered,
          }).bindAlias(name, args, 0);
    return Promise.resolve(
      response({
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call-${String(turn)}`,
            name,
            arguments: args,
            ...(invocation === undefined ? {} : { invocation }),
          },
        ],
      }),
    );
  };
}

interface RunInput {
  readonly read?: SecureWorkspaceTextReadPort | undefined;
  readonly call?: ((request: GatewayCallRequest) => Promise<NormalizedResponse>) | undefined;
  readonly gate?: (() => ReadOnlyChildGateDecision) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly reservePromptTokens?: ((promptTokens: number) => boolean) | undefined;
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
    reservePromptTokens: input.reservePromptTokens ?? ((): boolean => true),
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

  it("executes an approved keiko_child_workspace_read call through the parent's secure read port", async () => {
    const requested: string[] = [];

    const outcome = await runChild({
      call: toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "src/index.ts" }),
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

  it("reserves every child prompt immediately before dispatch and never calls the provider after exhaustion", async () => {
    const reservations: number[] = [];
    let providerCalls = 0;

    const scripted = toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "src/index.ts" });
    await expect(
      runChild({
        call: (request): Promise<NormalizedResponse> => {
          providerCalls += 1;
          return scripted(request);
        },
        reservePromptTokens: (promptTokens): boolean => {
          reservations.push(promptTokens);
          return reservations.length === 1;
        },
      }),
    ).rejects.toThrow("child-session-failed");

    expect(reservations).toHaveLength(2);
    expect(reservations.every((tokens) => tokens > 0)).toBe(true);
    expect(providerCalls).toBe(1);
  });

  // Pre-catalog, an unoffered tool name reached executeRead()'s own anomaly check, which cancels
  // the session and answers "denied" without touching the workspace. The mandatory catalog path
  // (#3407) now closes this earlier and harder: a name outside the child's one-tool "child"
  // profile can never bind to an invocation at all (ADR-0175 D2 -- catalog membership is the only
  // source of dispatchable identity), so the run fails closed before any tool executes. This is a
  // strengthening of the same invariant ("the child cannot act outside its one offered tool"), not
  // a relaxation: the workspace is still never touched, and the run now stops even sooner.
  it("fails closed when the model calls a tool it was never given, without touching the workspace", async () => {
    let reads = 0;

    await expect(
      runChild({
        call: toolThenFinish("write_file", { relativePath: "src/index.ts", text: "mutated" }),
        read: {
          readText: () => {
            reads += 1;
            return Promise.resolve({ ok: true as const, text: "unreachable" });
          },
        },
      }),
    ).rejects.toThrow("child-session-failed");

    expect(reads).toBe(0);
  });

  it("stops the child session when the parent authority gate denies, not just the one call", async () => {
    // The runner contract requires stopping on a non-ok gate decision. Answering only that one tool
    // call "denied" would let the child keep spending model calls against the parent's budget after
    // its authority was already revoked.
    let reads = 0;
    let modelCalls = 0;
    const scripted = toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "src/index.ts" });

    const outcome = await runChild({
      call: (request): Promise<NormalizedResponse> => {
        modelCalls += 1;
        return scripted(request);
      },
      gate: (): ReadOnlyChildGateDecision => ({
        ok: false,
        terminal: "denied",
        reasonCode: "authority-revoked",
      }),
      read: {
        readText: (): ReturnType<SecureWorkspaceTextReadPort["readText"]> => {
          reads += 1;
          return Promise.resolve({ ok: true as const, text: "unreachable" });
        },
      },
    });

    expect(reads).toBe(0);
    expect(outcome.resultCount).toBe(0);
    // The denial ended the session: no further model turn was taken.
    expect(modelCalls).toBe(1);
  });

  it("routes an offered read through the gate before touching the workspace", async () => {
    const attempts: string[] = [];

    await runChild({
      call: toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "src/index.ts" }),
      gate: (): ReadOnlyChildGateDecision => {
        attempts.push("gated");
        return { ok: true };
      },
    });

    expect(attempts).toEqual(["gated"]);
  });

  // Pre-catalog, a non-string relativePath reached executeRead()'s own guard. The catalog's own
  // descriptor schema (relativePath: string) now rejects this shape at bind time instead --
  // strictly earlier than before, never forwarding it to the read port either way.
  it("fails closed on a non-string relativePath instead of forwarding it to the read port", async () => {
    let reads = 0;

    await expect(
      runChild({
        call: toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, {
          relativePath: { nested: "../../etc/passwd" },
        }),
        read: {
          readText: () => {
            reads += 1;
            return Promise.resolve({ ok: true as const, text: "unreachable" });
          },
        },
      }),
    ).rejects.toThrow("child-session-failed");

    expect(reads).toBe(0);
  });

  it("does not count a denied read from the secure port as a result", async () => {
    const outcome = await runChild({
      call: toolThenFinish(CHILD_WORKSPACE_READ_ALIAS, { relativePath: "../outside" }),
      read: { readText: () => Promise.resolve({ ok: false as const, reason: "denied" as const }) },
    });

    expect(outcome.resultCount).toBe(0);
  });

  it("fails closed when no model port resolves for the child model id", async () => {
    const runner = createProductionReadOnlyChildRunner({
      modelPortFactory: () => undefined,
      reservePromptTokens: () => true,
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
