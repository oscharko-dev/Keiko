import { describe, expect, it } from "vitest";
import { createManagedMcpHost } from "@oscharko-dev/keiko-mcp";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpTool,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { formatActivityLogProofLine } from "./support/activity-log-proof.js";

describe("managed MCP Activity Log reconstruction", () => {
  it("joins real SDK admission, listing and invocation without exposing result content", async () => {
    const lines: string[] = [];
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
    const host = createManagedMcpHost({
      providers: [
        {
          id: "fixture",
          tools: (): readonly ManagedMcpTool<ManagedMcpInvocationContext>[] => [
            {
              name: "fixture.echo",
              risk: "read",
              descriptor,
              execute: (): Promise<ManagedMcpToolResult> =>
                Promise.resolve({ data: { value: "private-synthetic-result" } }),
            },
          ],
        },
      ],
      log: {
        write: (event) => {
          lines.push(formatActivityLogProofLine(event));
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
    } finally {
      await host.close();
    }
  });
});
