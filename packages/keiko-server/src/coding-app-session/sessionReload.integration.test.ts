import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { expect, it } from "vitest";
import { buildUiHandlerDeps } from "../deps.js";
import { buildCspHeader } from "../csp.js";
import { createInMemoryUiStore } from "../store/index.js";
import { startUiTestServer, closeUiTestServer } from "../ui-test-server/_support.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry, type SessionRegistry } from "./sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  createStaticContentSource,
  fakePairingRequestBody,
} from "./_support.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";

const CANARY = { kind: "probe", body: "reload-canary" } as const;
const PREFIX = "/api/coding-workbench/app-session";

async function fixture(
  clock: () => number,
): Promise<{ registry: SessionRegistry; origin: string; close: () => Promise<void> }> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "session-reload-")));
  const registry = createSessionRegistry({ now: clock });
  const channel = createCodingAppSessionChannel({
    registry,
    pairingPort: createFakeSessionPairingPort(),
    contentSource: createStaticContentSource(CANARY),
  });
  const built = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: directory,
    env: {},
    store: createInMemoryUiStore(),
  });
  const handlerDeps = { ...built, codingAppSessionChannel: channel };
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps,
  });
  return {
    registry,
    origin: `http://127.0.0.1:${String(started.port)}`,
    close: async (): Promise<void> => {
      await closeUiTestServer(started.server);
      await built.dispose?.();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function expectAuthenticated(browser: APIRequestContext, origin: string): Promise<void> {
  const response = await browser.get(`${origin}${PREFIX}/channel`);
  expect(response.status()).toBe(200);
  const snapshot: unknown = await response.json();
  expect(snapshot).toMatchObject({ content: CANARY });
}

it("keeps the real scoped browser cookies across reload after a 26-minute turn", async () => {
  let now = 0;
  const app = await fixture(() => now);
  let browser = await request.newContext({
    extraHTTPHeaders: { Origin: app.origin, "X-Keiko-CSRF": "1" },
  });
  let release: (() => void) | undefined;
  try {
    const paired = await browser.post(`${app.origin}${PREFIX}/pair`, {
      data: fakePairingRequestBody(),
    });
    expect(paired.status()).toBe(200);
    const saved = await browser.storageState();
    const proof = saved.cookies.find((cookie) => cookie.name === APP_SESSION_COOKIE_NAME)?.value;
    expect(proof).toBeDefined();
    release = app.registry.beginOperation(proof);
    expect(release).toBeDefined();
    now = 26 * 60_000;
    await expectAuthenticated(browser, app.origin);
    release?.();
    now += 2 * 60_000;
    await browser.dispose();
    // A fresh context has only the browser's persisted cookie jar, no in-page bearer or state.
    browser = await request.newContext({
      storageState: saved,
      extraHTTPHeaders: { Origin: app.origin, "X-Keiko-CSRF": "1" },
    });
    await expectAuthenticated(browser, app.origin);
    expect(
      (await browser.post(`${app.origin}${PREFIX}/local-session`, { data: {} })).status(),
    ).toBe(200);
    expect((await browser.get(`${app.origin}/api/skills`)).status()).toBe(200);
    expect((await browser.get(`${app.origin}/api/mcp/servers`)).status()).toBe(200);
  } finally {
    release?.();
    await browser.dispose();
    await app.close();
  }
});
