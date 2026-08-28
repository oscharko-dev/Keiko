import {
  requestGatewayReadinessChatCompletion,
  type GatewayConfig,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";

const MAX_PROVIDER_RESPONSE_BYTES = 500_000;

export type GatewayToolCallingProbeStatus = "verified" | "unsupported" | "unverified";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExpectedToolCall(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return false;
  const choices: readonly unknown[] = payload.choices;
  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) {
    return false;
  }
  return choice.message.tool_calls.some(
    (call) =>
      isRecord(call) && isRecord(call.function) && call.function.name === "report_readiness",
  );
}

function rejectedStatus(response: Response): GatewayToolCallingProbeStatus {
  return response.status >= 400 && response.status < 500 ? "unsupported" : "unverified";
}

function toolCallingBody(): Readonly<Record<string, unknown>> {
  return {
    messages: [
      { role: "system", content: "Use the provided tool for readiness checks." },
      { role: "user", content: "Call the report_readiness tool with status ok." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "report_readiness",
          description: "Report gateway readiness.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string", enum: ["ok"] } },
            required: ["status"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "report_readiness" } },
  };
}

export async function probeGatewayToolCalling(
  config: GatewayConfig,
  provider: ModelProviderConfig,
  fetchImpl?: typeof fetch,
): Promise<GatewayToolCallingProbeStatus> {
  try {
    const response = await requestGatewayReadinessChatCompletion({
      config,
      provider,
      body: toolCallingBody(),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
    });
    if (!response.ok) return rejectedStatus(response);
    return hasExpectedToolCall(await readJsonCapped(response, MAX_PROVIDER_RESPONSE_BYTES))
      ? "verified"
      : "unsupported";
  } catch {
    return "unverified";
  }
}
