import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatewayConfigFromFile } from "./gateway-config.js";
import {
  PROVIDER_CREDENTIALS_KEY,
  REAL_TMPDIR,
  writeReferenceOnlyGatewayConfig,
} from "./test-support/gateway-config-fixture.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-cli-gateway-config-"));
  tmpDirs.push(dir);
  return writeReferenceOnlyGatewayConfig(dir, {
    modelIds: ["example-chat-model"],
    baseUrl: "https://host.example/v1",
    apiKey: "vault-resolved-key",
    filename: "keiko.config.json",
  });
}

describe("loadGatewayConfigFromFile", () => {
  it("resolves apiKeySecretRef values from the provider credential vault", async () => {
    const configPath = makeConfig();

    const config = await loadGatewayConfigFromFile(configPath, {
      KEIKO_PROVIDER_CREDENTIALS_KEY: PROVIDER_CREDENTIALS_KEY,
    });

    expect(config.providers[0]?.apiKey).toBe("vault-resolved-key");
  });
});
