import { describe, expect, it } from "vitest";
import { apiKeyHeaderValue } from "../../packages/keiko-model-gateway/dist/index.js";
import {
  CUSTOMER_SHAPE_API_KEY,
  startCustomerShapeLiteLlmTwin,
} from "../lib/customer-shape-litellm-twin.mjs";
import {
  completedTurnEvidence,
  customerShapeRequestEvidence,
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

  it("does not satisfy current-run request evidence with an earlier run's requests", () => {
    const requests = [
      { stream: true, hasStreamOptions: true },
      { stream: true, hasStreamOptions: false },
    ];
    expect(customerShapeRequestEvidence(requests, 0)).toEqual({
      rejectedOptionalField: true,
      compatibleRetry: true,
    });
    expect(customerShapeRequestEvidence(requests, 2)).toEqual({
      rejectedOptionalField: false,
      compatibleRetry: false,
    });
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
});
