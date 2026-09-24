import { describe, expect, it } from "vitest";
import { apiKeyHeaderValue } from "../../packages/keiko-model-gateway/dist/index.js";
import {
  CUSTOMER_SHAPE_API_KEY,
  startCustomerShapeLiteLlmTwin,
} from "../lib/customer-shape-litellm-twin.mjs";
import {
  completedTurnEvidence,
  completedToolRoundTripEvidence,
  customerShapeFailureSummary,
  customerShapeRequestEvidence,
  linkedFailureEvidence,
} from "../lib/customer-shape-evidence.mjs";

describe("customer-shape LiteLLM twin", () => {
  it("requires the configured custom authentication header for chat", async () => {
    const twin = await startCustomerShapeLiteLlmTwin();
    try {
      const url = `${twin.baseUrl}/chat/completions`;
      const body = JSON.stringify({ model: "gemma-4-31b-it", messages: [], stream: false });
      for (const headers of [
        { "content-type": "application/json" },
        { "content-type": "application/json", authorization: `Bearer ${CUSTOMER_SHAPE_API_KEY}` },
        { "content-type": "application/json", "x-litellm-key": "wrong-key" },
      ]) {
        const response = await globalThis.fetch(url, { method: "POST", headers, body });
        expect(response.status).toBe(401);
      }
      const accepted = await globalThis.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-litellm-key": apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY),
        },
        body,
      });
      expect(accepted.status).toBe(200);
      expect(twin.requests).toHaveLength(1);
    } finally {
      await twin.close();
    }
  });

  it("streams a vLLM-style governed read call before its follow-up answer", async () => {
    const twin = await startCustomerShapeLiteLlmTwin();
    try {
      twin.planSingleWorkspaceDiscovery();
      const headers = {
        "content-type": "application/json",
        "x-litellm-key": apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY),
      };
      const url = `${twin.baseUrl}/chat/completions`;
      const request = {
        model: "gemma-4-31b-it",
        stream: true,
        messages: [{ role: "user", content: "Discover README.md" }],
        tools: [{ type: "function", function: { name: "keiko_workspace_discover" } }],
      };
      const first = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
      const firstBody = await first.text();
      expect(firstBody).toContain('"name":"keiko_workspace_discover"');
      expect(firstBody).toContain('"finish_reason":"tool_calls"');
      expect(firstBody).not.toContain('"usage"');
      const second = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...request,
          messages: [
            ...request.messages,
            {
              role: "tool",
              tool_call_id: "call-twin",
              content: JSON.stringify({ status: "completed", read: { text: "README.md\n" } }),
            },
          ],
        }),
      });
      expect(await second.text()).toContain("Synthetic Workbench reply.");
      expect(twin.requests[0]).toMatchObject({ deliveredToolCall: true });
      expect(twin.requests[1]).toMatchObject({ completedDiscoveryResult: true });
    } finally {
      await twin.close();
    }
  });

  it("does not accept denied or unrelated tool results as a governed discovery", async () => {
    const twin = await startCustomerShapeLiteLlmTwin();
    try {
      const headers = {
        "content-type": "application/json",
        "x-litellm-key": apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY),
      };
      const url = `${twin.baseUrl}/chat/completions`;
      for (const [toolCallId, result] of [
        ["call-twin", { status: "denied", evidence: [] }],
        ["call-twin", { status: "failed", evidence: [] }],
        ["unrelated-call", { status: "completed", read: { text: "README.md\n" } }],
      ]) {
        const response = await globalThis.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "gemma-4-31b-it",
            messages: [
              { role: "user", content: "Discover README.md" },
              { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result) },
            ],
            stream: true,
          }),
        });
        await response.text();
      }
      expect(twin.requests[0]).toMatchObject({ completedDiscoveryResult: false });
      expect(twin.requests[1]).toMatchObject({ completedDiscoveryResult: false });
      expect(twin.requests[2]).toMatchObject({ completedDiscoveryResult: false });
    } finally {
      await twin.close();
    }
  });

  it("requires the completed discovery to follow the emitted tool call in this phase", () => {
    const emitted = { deliveredToolCall: true, completedDiscoveryResult: false };
    const completed = { deliveredToolCall: false, completedDiscoveryResult: true };
    expect(completedToolRoundTripEvidence([completed, emitted], 0)).toBe(false);
    expect(completedToolRoundTripEvidence([emitted, completed], 0)).toBe(true);
    expect(completedToolRoundTripEvidence([emitted, completed], 2)).toBe(false);
  });

  it("does not satisfy current-run request evidence with an earlier run's requests", () => {
    const requests = [
      { stream: true, hasStreamOptions: true },
      { stream: true, hasStreamOptions: false },
    ];
    expect(customerShapeRequestEvidence(requests, 0)).toEqual({
      rejectedOptionalField: true,
      compatibleRetry: true,
      delayedAcceptedStream: false,
    });
    expect(customerShapeRequestEvidence(requests, 2)).toEqual({
      rejectedOptionalField: false,
      compatibleRetry: false,
      delayedAcceptedStream: false,
    });
  });

  it("redacts unreviewed Activity Log values before printing a release failure", () => {
    const secret = "customer-secret-token";
    const summary = customerShapeFailureSummary(
      [
        {
          op: "coding-runtime.run.settled",
          failureCode: secret,
          errorKind: secret,
          outcome: secret,
          publicationReason: secret,
          diagnosticLineCount: 3,
          message: secret,
        },
        {
          op: "coding-sidecar.gateway.turn-failed",
          failureCode: "provider-failed",
          errorKind: "timeout",
          outcome: "failed",
          publicationReason: "terminal-run",
        },
        { op: `coding-runtime.${secret}`, failureCode: secret },
      ],
      [{ stream: secret, hasStreamOptions: true, delayed: false }],
      0,
    );
    expect(summary).toMatchObject({
      activityLineCount: 3,
      requestCount: 1,
      timeline: [
        {
          op: "coding-runtime.run.settled",
          failureCode: "[redacted]",
          errorKind: "[redacted]",
          outcome: "[redacted]",
          publicationReason: "[redacted]",
          diagnosticLineCount: 3,
        },
        {
          op: "coding-sidecar.gateway.turn-failed",
          failureCode: "provider-failed",
          errorKind: "timeout",
          outcome: "failed",
          publicationReason: "terminal-run",
        },
      ],
      requests: [{ stream: false, hasStreamOptions: true, delayed: false }],
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("records an accepted stream that entered the delayed-response branch", async () => {
    const twin = await startCustomerShapeLiteLlmTwin();
    try {
      twin.delayAcceptedStreamingBy(1);
      const response = await globalThis.fetch(`${twin.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-litellm-key": apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY),
        },
        body: JSON.stringify({ model: "gemma-4-31b-it", messages: [], stream: true }),
      });
      await response.text();
      expect(customerShapeRequestEvidence(twin.requests, 0).delayedAcceptedStream).toBe(true);
    } finally {
      await twin.close();
    }
  });

  it("truncates one accepted stream and then resumes normal completed replies", async () => {
    const twin = await startCustomerShapeLiteLlmTwin();
    try {
      twin.truncateNextAcceptedStream();
      const request = () =>
        globalThis.fetch(`${twin.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-litellm-key": apiKeyHeaderValue("x-litellm-key", CUSTOMER_SHAPE_API_KEY),
          },
          body: JSON.stringify({ model: "gemma-4-31b-it", messages: [], stream: true }),
        });
      const first = await request();
      const partial = await first.text();
      expect(partial).toContain("Synthetic partial reply.");
      expect(partial).not.toContain("[DONE]");
      expect(partial).not.toContain('"finish_reason":"stop"');
      const second = await request();
      expect(await second.text()).toContain("[DONE]");
      expect(twin.requests.map(({ truncated }) => truncated)).toEqual([true, false]);
    } finally {
      await twin.close();
    }
  });

  it("requires accepted completion for the same run and model request", () => {
    const lines = [
      {
        op: "coding-sidecar.gateway.usage-settled",
        parentCorrelationId: "old-run",
        correlationId: "old-request",
        completionTokens: 12,
      },
      {
        op: "coding-sidecar.gateway.outcome",
        parentCorrelationId: "old-run",
        correlationId: "old-request",
        outcome: "accepted",
      },
      {
        op: "coding-sidecar.gateway.usage-settled",
        parentCorrelationId: "current-run",
        correlationId: "current-request",
        completionTokens: 4,
      },
      {
        op: "coding-sidecar.gateway.outcome",
        parentCorrelationId: "current-run",
        correlationId: "other-request",
        outcome: "accepted",
      },
    ];
    expect(completedTurnEvidence(lines, "current-run")).toBe(false);
    lines.push({
      op: "coding-sidecar.gateway.outcome",
      parentCorrelationId: "current-run",
      correlationId: "current-request",
      outcome: "accepted",
    });
    expect(completedTurnEvidence(lines, "current-run")).toBe(true);
  });

  it("rejects completion lines without a populated request correlation", () => {
    expect(
      completedTurnEvidence(
        [
          {
            op: "coding-sidecar.gateway.usage-settled",
            parentCorrelationId: "current-run",
            completionTokens: 4,
          },
          {
            op: "coding-sidecar.gateway.outcome",
            parentCorrelationId: "current-run",
            outcome: "accepted",
          },
        ],
        "current-run",
      ),
    ).toBe(false);
  });

  it("requires a published or terminal-run failure linked to its installed diagnostic", () => {
    const failure = {
      op: "coding-sidecar.gateway.turn-failed",
      runId: "current-run",
      parentCorrelationId: "current-run",
      correlationId: "current-request",
      published: true,
    };
    const diagnostic = {
      op: "server.diagnostic.failure",
      parentCorrelationId: "current-run",
      correlationId: "current-request",
      frames: ["packages/keiko-server/dist/route.js:1:1"],
    };
    expect(linkedFailureEvidence([failure, diagnostic], "current-run")).toEqual({
      turnFailure: failure,
      diagnostic,
    });
    expect(
      linkedFailureEvidence([{ ...failure, correlationId: undefined }, diagnostic], "current-run"),
    ).toBeUndefined();
    expect(
      linkedFailureEvidence(
        [{ ...failure, published: false, publicationReason: "invalid-event" }, diagnostic],
        "current-run",
      ),
    ).toBeUndefined();
    expect(
      linkedFailureEvidence(
        [failure, { ...diagnostic, parentCorrelationId: undefined }],
        "current-run",
      ),
    ).toBeUndefined();
  });
});
