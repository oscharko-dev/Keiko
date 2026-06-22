import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openProviderCredentialVault } from "@oscharko-dev/keiko-server/credential-vault";
import { loadGatewayConfigFromFile } from "./gateway-config.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const PROVIDER_CREDENTIALS_KEY = Buffer.alloc(32, 0x32).toString("base64");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-cli-gateway-config-"));
  tmpDirs.push(dir);
  const configPath = join(dir, "keiko.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        {
          modelId: "example-chat-model",
          baseUrl: "https://host.example/v1",
          apiKeySecretRef: "cred:example-chat-model",
        },
      ],
    }),
    "utf8",
  );
  openProviderCredentialVault({
    configPath,
    env: { KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY },
  }).set("cred:example-chat-model", "vault-resolved-key");
  return configPath;
}

describe("loadGatewayConfigFromFile", () => {
  it("resolves apiKeySecretRef values from the provider credential vault", () => {
    const configPath = makeConfig();

    const config = loadGatewayConfigFromFile(configPath, {
      KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY,
    });

    expect(config.providers[0]?.apiKey).toBe("vault-resolved-key");
  });
});
