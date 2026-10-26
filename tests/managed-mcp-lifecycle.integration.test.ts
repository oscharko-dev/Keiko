import { describe, expect, it } from "vitest";
import { activityLogLossCounters } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { activityLogLossSummaryEvent } from "@oscharko-dev/keiko-activity-log";
import { createManagedMcpHost } from "@oscharko-dev/keiko-mcp";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpTool,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "./support/activity-log-proof.js";

describe("managed MCP Activity Log reconstruction", () => {
  it("joins real SDK admission, listing and invocation without exposing result content", async () => {
    const lines: string[] = [];
    let rejectTerminal = false;
    const descriptor = createToolDescriptor({
      toolRef: createToolRef("keiko.fixture.echo", 1),
      description: "Return a synthetic bound result.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      resultSchema: {
        type: "object",
        properties: { value: { type: "string", maxLength: 100 } },
        required: ["value"],
        additionalProperties: false,
      },
      effects: ["connector-access"],
      actionMapping: [{ action: "connector", effects: ["connector-access"] }],
      policyReferences: ["fixture"],
      handlerRequirement: { id: "fixture", contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 1024,
        maxResultBytes: 1024,
        maxResultCount: 1,
        maxDurationMs: 1000,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    });
    const execute = (): Promise<ManagedMcpToolResult> =>
      Promise.resolve({ data: { value: "private-synthetic-result" } });
    const host = createManagedMcpHost({
      providers: [
        {
          id: "fixture",
          tools: (): readonly ManagedMcpTool<ManagedMcpInvocationContext>[] => [
            {
              name: "fixture.echo",
              risk: "read",
              descriptor,
              execute,
            },
          ],
        },
      ],
      log: {
        write: (event) => {
          const line = formatActivityLogProofLine(event);
          if (rejectTerminal && (JSON.parse(line) as { phase?: string }).phase === "completed")
            throw new Error("private sink failure");
          lines.push(line);
        },
      },
    });
    try {
      await host.admit("admission-observable-fixture");
      await host.call(
        "fixture.echo",
        {},
        {
          correlationId: "call-observable-fixture",
          invocationId: "invocation-observable-fixture",
          signal: new AbortController().signal,
          beforeEffect: () => true,
        },
      );
      const timeline = analyzeLogText(lines.join("\n")).timelines.find(
        (item) => item.correlationId === "call-observable-fixture",
      );
      expect(timeline?.lines.map((line) => line.extra?.phase)).toEqual([
        "started",
        "listed",
        "completed",
      ]);
      expect(
        timeline?.lines.every(
          (line) => line.extra?.invocationId === "invocation-observable-fixture",
        ),
      ).toBe(true);
      expect(lines.join()).toContain("registrySha256");
      expect(lines.join()).not.toContain("private-synthetic-result");
      rejectTerminal = true;
      const before = activityLogLossCounters()["port-sink-failed"];
      await expect(
        host.call(
          "fixture.echo",
          {},
          {
            correlationId: "loss-observable-fixture",
            invocationId: "loss-invocation-fixture",
            signal: new AbortController().signal,
            beforeEffect: () => true,
          },
        ),
      ).resolves.toEqual({ value: "private-synthetic-result" });
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
      const lossLine = formatActivityLogProofLine(
        activityLogLossSummaryEvent(activityLogLossCounters(), "heartbeat"),
      );
      expect(expectActivityLogProof("activity-log.loss.heartbeat-summary", lossLine)).toMatchObject(
        { portSinkFailed: before + 1, completeness: "partial", loss: "event-dropped" },
      );
      expect(
        analyzeLogText([...lines, lossLine].join("\n")).clusters.some(
          (cluster) => cluster.op === "activity-log.loss" && cluster.errorKind === "unavailable",
        ),
      ).toBe(true);
      expect(lossLine).not.toContain("private sink failure");
      expect(lossLine).not.toContain("private-synthetic-result");
    } finally {
      await host.close();
    }
  });
});
