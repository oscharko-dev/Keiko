// Hermetic OpenAI-compatible provider for #3401's production-composed Workbench description
// journey. The server accepts only the one loopback chat endpoint and credential configured by the
// delivery fixture. It derives citations from the production request's actual evidence ids, so the
// returned artifact remains bound to the snapshot the dispatcher captured.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import type { GatewayConfig, ModelProviderConfig } from "@oscharko-dev/keiko-model-gateway";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import {
  DELIVERY_DESCRIPTION_MODEL_API_KEY,
  DELIVERY_DESCRIPTION_MODEL_ID,
  deliveryDescriptionModelState,
} from "../support/coding-issue-delivery.js";

const MAX_REQUEST_BYTES = 256_000;
const CHAT_PATH = "/v1/chat/completions";

export interface DeliveryDescriptionModelState {
  readonly requests: number;
  readonly rejections: number;
  readonly lastEvidenceCount?: number;
  readonly lastResponseDigest?: string;
}

function readState(stateDir: string): DeliveryDescriptionModelState {
  return JSON.parse(
    readFileSync(deliveryDescriptionModelState(stateDir), "utf8"),
  ) as DeliveryDescriptionModelState;
}

function writeState(stateDir: string, state: DeliveryDescriptionModelState): void {
  writeFileSync(deliveryDescriptionModelState(stateDir), JSON.stringify(state));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("description-model-request-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function evidenceIds(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  const text = messages
    .map((message) => {
      if (typeof message !== "object" || message === null) return "";
      const content = (message as Record<string, unknown>).content;
      return typeof content === "string" ? content : "";
    })
    .join("\n");
  return [
    ...new Set([...text.matchAll(/"evidenceId":"([^"]+)"/gu)].map((match) => match[1] ?? "")),
  ].filter((id) => id.length > 0);
}

function candidate(ids: readonly string[]): string {
  const statement = {
    text: "Updates the accepted implementation and its verification fixture.",
    evidenceIds: ids,
  };
  return JSON.stringify({
    summary: [statement],
    keyChanges: [statement],
    risks: [],
    reviewerFocus: [],
  });
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function reject(stateDir: string, response: ServerResponse): void {
  const state = readState(stateDir);
  writeState(stateDir, { ...state, rejections: state.rejections + 1 });
  respondJson(response, 404, { error: { code: "fixture-provider-boundary-denied" } });
}

async function handleRequest(
  stateDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (
    request.method !== "POST" ||
    request.url !== CHAT_PATH ||
    request.headers.authorization !== `Bearer ${DELIVERY_DESCRIPTION_MODEL_API_KEY}`
  ) {
    reject(stateDir, response);
    return;
  }
  const ids = evidenceIds(JSON.parse(await requestBody(request)) as unknown);
  if (ids.length === 0) {
    reject(stateDir, response);
    return;
  }
  const content = candidate(ids);
  const state = readState(stateDir);
  writeState(stateDir, {
    ...state,
    requests: state.requests + 1,
    lastEvidenceCount: ids.length,
    lastResponseDigest: sha256(content),
  });
  respondJson(response, 200, {
    id: `delivery-description-${String(state.requests + 1)}`,
    model: DELIVERY_DESCRIPTION_MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 32, completion_tokens: 24, total_tokens: 56 },
  });
}

function provider(port: number): ModelProviderConfig {
  return {
    modelId: DELIVERY_DESCRIPTION_MODEL_ID,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    apiKey: DELIVERY_DESCRIPTION_MODEL_API_KEY,
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

export function deliveryDescriptionGatewayConfig(port: number): GatewayConfig {
  return {
    providers: [provider(port)],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [
      {
        ...createDefaultChatCapability(DELIVERY_DESCRIPTION_MODEL_ID),
        contextWindow: 32_768,
        maxOutputTokens: 2_048,
      },
    ],
  };
}

export async function startDeliveryDescriptionModel(
  stateDir: string,
  port: number,
): Promise<Server> {
  writeState(stateDir, { requests: 0, rejections: 0 });
  const server = createServer((request, response) => {
    void handleRequest(stateDir, request, response).catch(() => {
      reject(stateDir, response);
    });
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
