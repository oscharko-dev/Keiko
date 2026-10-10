// Qualifies the actual runner with native credential loading; never contacts a model provider.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  loadConfigFromFile,
} from "../../packages/keiko-model-gateway/dist/index.js";
import { currentContextProfileForModel } from "../../packages/keiko-server/dist/deps.js";
import {
  createProviderSecretResolver,
  openProviderCredentialVault,
  providerSecretRef,
} from "../../packages/keiko-server/dist/credentialVault.js";
import { compactionCases } from "../testing/coding-workbench-lab/connected-chat-run.mjs";
import { CONNECTED_CHAT_CAMPAIGNS } from "../testing/coding-workbench-lab/connected-chat-cases.mjs";

const MODEL = "compaction-fixture-model";
const ROOTS = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-compaction-profile-"));
  ROOTS.push(root);
  const path = join(root, "keiko.config.json");
  const secret = randomBytes(24).toString("hex");
  const env = { KEIKO_CONFIG_FILE: path };
  const provider = { modelId: MODEL, baseUrl: "http://127.0.0.1:1/v1" };
  if (mode === "plaintext") provider.apiKey = secret;
  if (mode === "environment") env.KEIKO_DEFAULT_API_KEY = secret;
  if (mode === "vault" || mode === "locked-vault") {
    env.KEIKO_PROVIDER_CREDENTIALS_KEY = randomBytes(32).toString("base64");
    provider.apiKeySecretRef = providerSecretRef(MODEL);
    openProviderCredentialVault({ configPath: path, env }).set(provider.apiKeySecretRef, secret);
  }
  writeFileSync(
    path,
    JSON.stringify({
      providers: [provider],
      capabilities: [{ ...createDefaultChatCapability(MODEL), contextWindow: 131072 }],
    }),
    { mode: 0o600 },
  );
  const config = loadConfigFromFile(path, env, {
    secretResolver: createProviderSecretResolver({ configPath: path, env }),
  });
  const profile = currentContextProfileForModel({ config }, MODEL);
  const session = {
    request: vi.fn(async () => ({
      status: 200,
      json: {
        contextWindowTokens: profile.maxInputTokens,
        inputBudgetTokens: profile.effectiveInputBudget,
      },
    })),
  };
  if (mode === "locked-vault")
    env.KEIKO_PROVIDER_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  return { path, secret, env, session };
}

function cases(input) {
  return compactionCases(
    input.session,
    { selectedModel: MODEL },
    { chatId: "actual-chat-binding", projectPath: "fixture-project" },
    input.env,
  );
}

describe("connected-chat runner's native credential-aware compaction profile", () => {
  it.each(["plaintext", "environment", "vault"])(
    "materializes the six original cases with %s credentials",
    async (mode) => {
      const input = fixture(mode);
      const rows = await cases(input);
      expect(rows.map((row) => row.id)).toEqual(
        CONNECTED_CHAT_CAMPAIGNS.compaction.map((row) => row.id),
      );
      for (const original of CONNECTED_CHAT_CAMPAIGNS.compaction) {
        if (original.setupNote === undefined)
          expect(rows.find((row) => row.id === original.id)?.question).toBe(original.question);
      }
      expect(input.session.request).toHaveBeenCalledOnce();
      expect(input.session.request.mock.calls[0]?.slice(0, 3)).toEqual([
        "GET",
        `/api/chats/context?chatId=actual-chat-binding&projectPath=fixture-project&modelId=${MODEL}`,
        undefined,
      ]);
      expect(JSON.stringify(rows)).not.toContain(input.secret);
      if (mode === "vault") expect(readFileSync(input.path, "utf8")).not.toContain(input.secret);
    },
  );

  it("fails closed before contextual preparation when the vault cannot decrypt", async () => {
    const input = fixture("locked-vault");
    await expect(cases(input)).rejects.toThrow("apiKey");
    expect(input.session.request).not.toHaveBeenCalled();
  });

  it("retains actual authenticated profile binding with environment credentials", async () => {
    const input = fixture("environment");
    input.session.request.mockResolvedValue({
      status: 200,
      json: { contextWindowTokens: 8192, inputBudgetTokens: 4096 },
    });
    await expect(cases(input)).rejects.toThrow("compaction-profile-unbound");
  });
});
