import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  vi.unstubAllEnvs();
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

vi.mock("../../packages/keiko-server/dist/credentialVault.js", () => ({
  createProviderSecretResolver: vi.fn(
    () => (reference) =>
      reference === "synthetic-existing-reference" ? "synthetic-existing-gateway-key" : undefined,
  ),
}));

function configuredFixture(modelId = "chat-model") {
  const f = fixture();
  const sourcePath = join(f.session.directory, "existing-config.json");
  writeFileSync(
    sourcePath,
    JSON.stringify({
      providers: [
        {
          modelId,
          baseUrl: "http://127.0.0.1:4000/v1",
          apiKeySecretRef: "synthetic-existing-reference",
          timeoutMs: 120000,
        },
      ],
    }),
    { mode: 0o600 },
  );
  vi.stubEnv("KEIKO_JIRA_LAB_GATEWAY_CONFIG", sourcePath);
  return { ...f, sourcePath };
}

describe("existing local Gateway configuration for Jira qualification", () => {
  it("uses its selected provider and existing vault key without persisting the key again", async () => {
    const f = configuredFixture();
    const original = readFileSync(f.sourcePath, "utf8");
    await configureModel(f.deps, "chat-model", f.session, f.path);
    const saved = readFileSync(f.path, "utf8");
    expect(JSON.parse(saved).providers[0].baseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(saved).not.toContain("synthetic-existing-gateway-key");
    expect(readFileSync(f.sourcePath, "utf8")).toBe(original);
    const [config, provider] = probeGatewayToolCalling.mock.calls[0];
    expect(config.providers[0].apiKey).toBe("synthetic-existing-gateway-key");
    expect(provider.baseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(provider.apiKey).toBe("synthetic-existing-gateway-key");
    expect(provider.maxRetries).toBe(0);
    expect(provider.timeoutMs).toBe(120000);
  });

  it("refuses an absent selected model without falling back to another Gateway", async () => {
    const f = configuredFixture("another-model");
    await expect(configureModel(f.deps, "chat-model", f.session, f.path)).rejects.toThrow(
      TypeError,
    );
    expect(probeGatewayToolCalling).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  });
});

it.each(["missing-secret", "remote-gateway", "nonprivate-file"])(
  "refuses unsafe or unavailable configured Gateway sources: %s",
  async (scenario) => {
    const f = configuredFixture();
    const raw = JSON.parse(readFileSync(f.sourcePath, "utf8"));
    if (scenario === "missing-secret") raw.providers[0].apiKeySecretRef = "unavailable-reference";
    if (scenario === "remote-gateway")
      raw.providers[0].baseUrl = "https://model.example.invalid/v1";
    writeFileSync(f.sourcePath, JSON.stringify(raw), { mode: 0o600 });
    if (scenario === "nonprivate-file") chmodSync(f.sourcePath, 0o644);
    await expect(configureModel(f.deps, "chat-model", f.session, f.path)).rejects.toThrow();
    expect(probeGatewayToolCalling).not.toHaveBeenCalled();
    expect(existsSync(f.path)).toBe(false);
  },
);
