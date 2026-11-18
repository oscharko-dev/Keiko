import { expect, type APIRequestContext } from "@playwright/test";

// The chat model the e2e runtime configuration names (tests/e2e/support/model-mock-server.mjs).
export const E2E_CHAT_MODEL_ID = "e2e-chat-model";

// Since ADR-0171 D2 (amended 2026-11-16) no chat model is checked at start: every chat model is
// inactive in a fresh server process until a person activates it in Settings > Models, and a send
// to an inactive model is refused. A journey that sends a turn therefore activates its model first,
// through the same explicit check that Settings > Models sends.
export async function activateChatModel(
  request: APIRequestContext,
  modelId: string = E2E_CHAT_MODEL_ID,
): Promise<void> {
  const response = await request.post("/api/gateway/readiness", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { modelId, options: { probes: ["chat"] } },
  });
  expect(response.ok(), await response.text().catch(() => "")).toBe(true);
}
