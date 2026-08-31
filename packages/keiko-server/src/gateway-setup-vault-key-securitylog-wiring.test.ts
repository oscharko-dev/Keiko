// Wiring test for `gateway-setup.ts`'s two `securityLogSink: processServerLogSink()` call sites
// that feed the provider-credential vault's key resolution (Wave 4a, epic #3233 §8, gap g18):
// `persistGatewayConfig`'s `persistSealedGatewayConfig` call, and `durableStoredGatewayConfig`'s
// `createProviderSecretResolver` call. Both ultimately reach
// `@oscharko-dev/keiko-security/secret-vault`'s `resolveLocalVaultKey`, which — before this
// change — had no `sink` parameter at all, so neither site could ever report which key tier
// answered (`security.vault.key-resolved`) or that the keychain tier fell back
// (`security.keychain.fallback`).
//
// `@oscharko-dev/keiko-security/secret-vault` is module-mocked to CAPTURE every
// `resolveLocalVaultKey` call's options (real behaviour is preserved via `importOriginal` +
// delegation), so both sites are provable without forcing a real keychain failure — hermetic per
// AGENTS.md. Every captured call sharing `envVarName: "KEIKO_PROVIDER_CREDENTIALS_KEY"` is checked
// with `.every(...)`, not merely the first, because a second `handleGatewaySetup` call exercises
// BOTH sites and either one regressing behind the other must still fail the assertion.
//
// THE FAILURE THIS PINS: dropping `securityLogSink: processServerLogSink()` from either
// `persistGatewayConfig` or `durableStoredGatewayConfig` in `gateway-setup.ts` leaves the matching
// call's `sink` field `undefined`, and the assertion below fails.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";
import type { RouteContext } from "./routes.js";

type ResolveLocalVaultKeyOptions = Parameters<
  typeof import("@oscharko-dev/keiko-security/secret-vault").resolveLocalVaultKey
>[0];

// A deterministic, valid 32-byte-base64 env-tier key so the provider-credential vault resolves at
// tier 1 (env) and never falls through to tier 2 (macOS Keychain, via
// `createKeychainVaultKeyAccess`'s real `/usr/bin/security` spawn) — see the sibling
// `deps-vault-key-securitylog-wiring.test.ts` for the same fix applied to the other four vaults.
const WIRING_TEST_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");

let calls: ResolveLocalVaultKeyOptions[];

vi.mock("@oscharko-dev/keiko-security/secret-vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-security/secret-vault")>();
  return {
    ...actual,
    resolveLocalVaultKey: (
      options: ResolveLocalVaultKeyOptions,
    ): ReturnType<typeof actual.resolveLocalVaultKey> => {
      calls.push(options);
      return actual.resolveLocalVaultKey(options);
    },
  };
});

// Imported AFTER the mock declaration so `gateway-setup.ts`'s internal `resolveLocalVaultKey`
// import (via `credentialVault.ts`/`credentialPersistence.ts`) binds to the capturing wrapper.
const { buildUiHandlerDeps } = await import("./deps.js");
const { handleGatewaySetup } = await import("./gateway-setup.js");

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

function ctx(body: unknown, correlationId: string): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/gateway/setup"),
    correlationId,
  };
}

let sink: BufferedServerLogSink;

beforeEach(() => {
  calls = [];
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});

afterEach(() => {
  resetServerLogger();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("gateway-setup.ts — provider-credential vault wires resolveLocalVaultKey's sink", () => {
  it("supplies a real server-log sink from both persistGatewayConfig and durableStoredGatewayConfig", async () => {
    const uiDir = tmp("gwsetup-vaultkey-ui-");
    const evidenceDir = tmp("gwsetup-vaultkey-ev-");
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir,
      env: { KEIKO_UI_DATA_DIR: uiDir, KEIKO_PROVIDER_CREDENTIALS_KEY: WIRING_TEST_VAULT_KEY },
      gatewayModelDiscovery: () => Promise.resolve(["wiring-test-model"]),
      gatewayEmbeddingProbe: (_config, ids) => Promise.resolve(ids),
      gatewaySetupTester: (_config, modelIds) =>
        Promise.resolve([modelIds[0] ?? "wiring-test-model"]),
    });
    try {
      // First call: a fresh setup with a plaintext apiKey. `current` is undefined, so this goes
      // through `verifyAndSaveGatewaySetup` -> `persistGatewayConfig` -> `persistSealedGatewayConfig`
      // (gateway-setup.ts site #1). `durableStoredGatewayConfig` short-circuits (no stored file yet
      // and no `current`), so site #2 is not exercised here.
      const first = await handleGatewaySetup(
        ctx(
          { baseUrl: "https://wiring-test.example.invalid", apiKey: "plaintext-wiring-secret" },
          "corr-gw-vaultkey-1",
        ),
        deps,
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      // Second call on the SAME deps: `current` is now the just-saved config, and the persisted
      // file holds only a reference (site #1 stripped the plaintext), so
      // `durableStoredGatewayConfig` must resolve the vault to classify it (gateway-setup.ts
      // site #2). `verifyGateway: false` also exercises the "existing config update" branch.
      const second = await handleGatewaySetup(
        ctx(
          {
            baseUrl: "https://wiring-test.example.invalid",
            apiKey: "plaintext-wiring-secret",
            verifyGateway: false,
          },
          "corr-gw-vaultkey-2",
        ),
        deps,
      );
      expect(second.status, JSON.stringify(second.body)).toBe(200);

      const matching = calls.filter((c) => c.envVarName === "KEIKO_PROVIDER_CREDENTIALS_KEY");
      expect(matching.length).toBeGreaterThan(1);
      expect(matching.every((c) => c.sink !== undefined)).toBe(true);

      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "security",
          op: "security.vault.entries-merged",
          correlationId: "corr-gw-vaultkey-1",
        }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("plaintext-wiring-secret");

      // Prove the captured sink is not merely present but IS the process-wide activity log.
      matching[0]?.sink?.write({
        level: "info",
        category: "security",
        op: "security.vault.key-resolved",
        extra: { source: "env" },
      });
      expect(sink.events).toContainEqual(
        expect.objectContaining({ category: "security", op: "security.vault.key-resolved" }),
      );
    } finally {
      deps.store.close();
      deps.memoryVault?.close();
    }
  });
});
