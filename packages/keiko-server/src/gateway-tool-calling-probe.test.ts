import { describe, expect, it } from "vitest";
import type { GatewayConfig, ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
import { probeGatewayToolCalling } from "./gateway-tool-calling-probe.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "not-a-secret-tool-calling-probe-fixture",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 0,
};

const CONFIG: GatewayConfig = {
  providers: [PROVIDER],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeGatewayToolCalling", () => {
  it("verifies support only when the forced function call is present", async () => {
    let requestBody = "";
    const fetchImpl: typeof fetch = (_url, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        jsonResponse({
          choices: [{ message: { tool_calls: [{ function: { name: "report_readiness" } }] } }],
        }),
      );
    };

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, fetchImpl)).resolves.toBe("verified");
    expect(JSON.parse(requestBody)).toMatchObject({
      tool_choice: { type: "function", function: { name: "report_readiness" } },
    });
  });

  it("marks rejected and malformed successful responses as unsupported", async () => {
    const rejected: typeof fetch = () => Promise.resolve(jsonResponse({}, 400));
    const missingCall: typeof fetch = () => Promise.resolve(jsonResponse({ choices: [] }));

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, rejected)).resolves.toBe("unsupported");
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, missingCall)).resolves.toBe(
      "unsupported",
    );
  });

  it("fails closed when the gateway is unavailable", async () => {
    const unavailable: typeof fetch = () => Promise.resolve(jsonResponse({}, 503));
    const interrupted: typeof fetch = () => Promise.reject(new TypeError("fixture interruption"));

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, unavailable)).resolves.toBe(
      "unverified",
    );
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, interrupted)).resolves.toBe(
      "unverified",
    );
  });
});
