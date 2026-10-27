import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureModel } from "../testing/jira-chat-lab/chat-read.mjs";
import { probeGatewayToolCalling } from "../../packages/keiko-server/dist/gateway-tool-calling-probe.js";

vi.mock("../../packages/keiko-server/dist/gateway-tool-calling-probe.js", () => ({
  probeGatewayToolCalling: vi.fn(async () => "verified"),
}));

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-model-config-"));
  roots.push(directory);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    session: { directory },
    path: join(directory, "config.json"),
    deps: { gatewayConfig: { set: vi.fn(), recordVerifiedCapability: vi.fn() } },
  };
}

describe("explicit live model qualification configuration", () => {
  it.each([undefined, { modelRetries: 1 }])(
    "preserves the default and bounded opt-in: %j",
    async (options) => {
      const f = fixture();
      await configureModel(f.deps, "chat-model", f.session, f.path, options);
      const saved = JSON.parse(readFileSync(f.path, "utf8"));
      expect(saved.providers).toHaveLength(1);
      expect(saved.providers[0].maxRetries).toBe(options?.modelRetries ?? 0);
      expect(saved.capabilities).toHaveLength(1);
      expect(saved.capabilities[0].toolCallingVerification.status).toBe("verified");
      expect(f.deps.gatewayConfig.set.mock.calls[0][0].providers[0].maxRetries).toBe(
        options?.modelRetries ?? 0,
      );
      expect(probeGatewayToolCalling).toHaveBeenCalledOnce();
    },
  );

  it("adds a separately selected real embedding provider without inventing a verification proof", async () => {
    const f = fixture();
    await configureModel(f.deps, "chat-model", f.session, f.path, {
      embeddingModelId: "embedding-model",
    });
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    expect(saved.providers.map((entry) => entry.modelId)).toEqual([
      "chat-model",
      "embedding-model",
    ]);
    expect(saved.capabilities.map((entry) => entry.kind)).toEqual(["chat", "embedding"]);
    expect(saved.capabilities[1].toolCallingVerification).toBeUndefined();
    expect(f.deps.gatewayConfig.recordVerifiedCapability).toHaveBeenCalledOnce();
    expect(f.deps.gatewayConfig.recordVerifiedCapability.mock.calls[0][0]).toBe("chat-model");
  });

  it.each([
    { modelRetries: -1 },
    { modelRetries: 2 },
    { modelRetries: 0.5 },
    { embeddingModelId: "" },
    { embeddingModelId: "chat-model" },
  ])("rejects invalid qualification options before probing or writing: %j", async (options) => {
    const f = fixture();
    await expect(configureModel(f.deps, "chat-model", f.session, f.path, options)).rejects.toThrow(
      TypeError,
    );
    expect(probeGatewayToolCalling).not.toHaveBeenCalled();
    expect(f.deps.gatewayConfig.set).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
});
