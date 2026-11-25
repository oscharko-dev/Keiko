import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOutboundHttpEgressConfig } from "@oscharko-dev/keiko-model-gateway";
import { gatewayFetch } from "@oscharko-dev/keiko-model-gateway/internal/http";
import { describe, expect, it } from "vitest";

import {
  devServerEnv,
  HERMETIC_DEAD_PROXY,
  HERMETIC_OUTBOUND_ENV,
} from "./support/dev-server-env.js";

// Smoke journeys failed on an unrelated click whenever a Keiko release newer than the checkout
// existed: the server's startup update preflight read the public npm registry, and the update
// notice then covered controls (`update-notice ... intercepts pointer events`, chat-send, a11y,
// atlassian-connectors-2246 and others in three to four runs each). The smoke server's outbound
// traffic is hermetic now. This proves it through the gateway's own egress resolution and fetch,
// the path the update preflight uses, with a reachable loopback positive control.
const env = devServerEnv({
  publicPort: 1,
  bffPort: 2,
  nextPort: 3,
  stateDir: "/state",
  runtimeConfigPath: "/state/keiko.e2e.config.json",
});
const egress = resolveOutboundHttpEgressConfig(undefined, env);
const REGISTRY_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/%40oscharko-dev%2Fkeiko/dist-tags";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return (server.address() as AddressInfo).port;
}

describe("the smoke dev server's outbound traffic", () => {
  it("routes every non-loopback request to a closed loopback proxy", () => {
    expect(egress).toMatchObject({
      httpProxy: `${HERMETIC_DEAD_PROXY}/`,
      httpsProxy: `${HERMETIC_DEAD_PROXY}/`,
      noProxy: ["127.0.0.1", "localhost", "::1"],
    });
  });

  it("cannot reach the public npm registry the update preflight reads", async () => {
    await expect(
      gatewayFetch(REGISTRY_DIST_TAGS_URL, { method: "GET", egress, timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("still reaches a loopback server directly", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    try {
      const port = await listen(server);
      const response = await gatewayFetch(`http://127.0.0.1:${String(port)}/healthz`, {
        method: "GET",
        egress,
        timeoutMs: 5_000,
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      });
    }
  });
});

// The smoke config was hermetic first; the other suites started their Keiko servers with the
// registry reachable and failed the same way once a newer release existed (jira-chat-4081 on the
// epic #4130 branch). Every Playwright config that starts a web server must give each server's env
// the hermetic outbound settings: a derived config inherits them from the base config's servers.
const E2E_ROOT = dirname(fileURLToPath(import.meta.url));
const HERMETIC_ENV_SPREADS = ["...HERMETIC_OUTBOUND_ENV", "...devServerEnv(", "...server.env"];

function playwrightConfigs(): readonly string[] {
  const configDir = join(E2E_ROOT, "config");
  const nested = readdirSync(configDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(configDir, name));
  const topLevel = readdirSync(E2E_ROOT)
    .filter((name) => name.endsWith(".config.ts"))
    .map((name) => join(E2E_ROOT, name));
  return [...nested, ...topLevel].filter((path) =>
    readFileSync(path, "utf8").includes("webServer"),
  );
}

function nonHermeticEnvBlocks(source: string): number {
  const blocks = source.split(/\benv:\s*\{/u).slice(1);
  return blocks.filter(
    (block) => !HERMETIC_ENV_SPREADS.some((spread) => block.trimStart().startsWith(spread)),
  ).length;
}

function hermeticEnvBlocks(source: string): number {
  return source.split(/\benv:\s*\{/u).length - 1 - nonHermeticEnvBlocks(source);
}

// Each server a config starts (a `command:`) needs its own hermetic env block: importing the
// settings, or giving only one of several servers the env, leaves the rest on process.env. A
// derived config starts no command of its own and inherits the base config's servers' env.
function isHermeticConfig(source: string): boolean {
  const servers = source.match(/\bcommand:/gu)?.length ?? 0;
  if (nonHermeticEnvBlocks(source) > 0) return false;
  if (servers === 0)
    return source.includes("baseConfig.webServer") && hermeticEnvBlocks(source) > 0;
  return hermeticEnvBlocks(source) >= servers;
}

describe("every Playwright web server's outbound traffic", () => {
  it("exposes the hermetic settings the smoke server uses", () => {
    expect(HERMETIC_OUTBOUND_ENV).toStrictEqual({
      KEIKO_HTTP_PROXY: HERMETIC_DEAD_PROXY,
      KEIKO_HTTPS_PROXY: HERMETIC_DEAD_PROXY,
      KEIKO_NO_PROXY: "127.0.0.1,localhost,::1",
    });
    expect(env).toMatchObject(HERMETIC_OUTBOUND_ENV);
  });

  it("is hermetic in every config that starts a web server", () => {
    const configs = playwrightConfigs();
    expect(configs.length).toBeGreaterThan(40);
    const offenders = configs
      .filter((path) => {
        return !isHermeticConfig(readFileSync(path, "utf8"));
      })
      .map((path) => relative(E2E_ROOT, path).split("\\").join("/"));
    expect(offenders).toStrictEqual([]);
  });

  it("reaches a Keiko server whose harness replaces process.env", () => {
    // A harness that builds Keiko's handler deps with an explicit env drops process.env, so it
    // must forward the hermetic settings itself, by the names HERMETIC_OUTBOUND_ENV defines.
    const harnesses = [join(E2E_ROOT, "support"), join(E2E_ROOT, "servers")].flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => /\.(mjs|mts|ts)$/u.test(name))
        .map((name) => join(dir, name)),
    );
    const explicitEnvHarnesses = harnesses.filter((path) =>
      /buildUiHandlerDeps\(\{[\s\S]{0,400}?\benv:\s*\{/u.test(readFileSync(path, "utf8")),
    );
    expect(
      explicitEnvHarnesses.map((path) => relative(E2E_ROOT, path).split("\\").join("/")),
    ).toStrictEqual(["support/jira-chat-4081-server.mjs"]);
    for (const path of explicitEnvHarnesses) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("...hermeticOutboundEnv,");
      for (const name of Object.keys(HERMETIC_OUTBOUND_ENV)) expect(source).toContain(`"${name}"`);
    }
  });

  it("flags a web server env block without the hermetic settings", () => {
    expect(nonHermeticEnvBlocks('webServer: { env: { KEIKO_OS_KEYCHAIN: "off" } }')).toBe(1);
    expect(nonHermeticEnvBlocks("webServer: { env: { ...HERMETIC_OUTBOUND_ENV, A: 1 } }")).toBe(0);
    expect(isHermeticConfig("webServer: { command: 'node server.mjs' }")).toBe(false);
    const importOnly = [
      'import { HERMETIC_OUTBOUND_ENV } from "../support/dev-server-env.js";',
      "webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:1' }",
    ].join("\n");
    expect(isHermeticConfig(importOnly)).toBe(false);
    const oneOfTwo =
      "webServer: [{ command: 'a', env: { ...HERMETIC_OUTBOUND_ENV } }, { command: 'b' }]";
    expect(isHermeticConfig(oneOfTwo)).toBe(false);
    expect(
      isHermeticConfig(
        "webServer: [{ command: 'a', env: { ...HERMETIC_OUTBOUND_ENV } }, " +
          "{ command: 'b', env: { ...HERMETIC_OUTBOUND_ENV } }]",
      ),
    ).toBe(true);
    expect(isHermeticConfig("webServer: { command: 'a', env: { ...devServerEnv(1) } }")).toBe(true);
  });
});
