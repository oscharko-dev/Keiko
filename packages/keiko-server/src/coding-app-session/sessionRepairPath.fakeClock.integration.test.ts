// #4370: fake-clock reproduction of the browser session repair path (`POST /local-session`).
//
// A paired browser reloaded 26 minutes after pairing and was then refused (#4321 item 1). The log
// of that incident is gone, so this suite drives the real routes, the real registry and a real
// cookie jar (Playwright's APIRequestContext, which applies Path/Max-Age/HttpOnly like a browser)
// on a fake clock, reloading at 26 and 31 minutes after pairing and carrying the session for
// 120 minutes. A reload is modelled the way the browser does it: a fresh context that holds only
// the persisted cookie jar, never an in-page bearer.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type APIRequestContext, type APIResponse } from "@playwright/test";
import { expect, it } from "vitest";
import { buildCspHeader } from "../csp.js";
import { buildUiHandlerDeps } from "../deps.js";
import { createInMemoryUiStore } from "../store/index.js";
import { closeUiTestServer, startUiTestServer } from "../ui-test-server/_support.js";
import {
  createFakeSessionPairingPort,
  createStaticContentSource,
  fakePairingRequestBody,
} from "./_support.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import {
  APP_SESSION_ACTIVE_COOKIE_COUNT,
  APP_SESSION_COOKIE_MAX_AGE_SECONDS,
  APP_SESSION_COOKIE_NAME,
} from "./sessionCookie.js";
import { createSessionRegistry, type SessionRegistry } from "./sessionRegistry.js";

const CANARY = { kind: "probe", body: "repair-path-canary" } as const;
const PREFIX = "/api/coding-workbench/app-session";
const MINUTE_MS = 60_000;
const ABSOLUTE_LIFETIME_MS = APP_SESSION_COOKIE_MAX_AGE_SECONDS * 1_000;

interface Fixture {
  readonly registry: SessionRegistry;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

async function fixture(clock: () => number): Promise<Fixture> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "session-repair-")));
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
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: { ...built, codingAppSessionChannel: channel },
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

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

async function openBrowser(origin: string, state?: StorageState): Promise<APIRequestContext> {
  return request.newContext({
    ...(state === undefined ? {} : { storageState: state }),
    extraHTTPHeaders: { Origin: origin, "X-Keiko-CSRF": "1" },
  });
}

function proofOf(state: StorageState): string {
  const proof = state.cookies.find((cookie) => cookie.name === APP_SESSION_COOKIE_NAME)?.value;
  if (proof === undefined || proof.length === 0) throw new Error("the cookie jar holds no proof");
  return proof;
}

/** The scoped cookies a repair response issues, minus the expiry projections it also sends. */
function issuedProjections(response: APIResponse): { path: string; maxAge: number }[] {
  return response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value)
    .filter((value) => value.startsWith(`${APP_SESSION_COOKIE_NAME}=`))
    .filter((value) => !value.startsWith(`${APP_SESSION_COOKIE_NAME}=;`))
    .map((value) => ({
      path: /Path=([^;]+)/u.exec(value)?.[1] ?? "",
      maxAge: Number(/Max-Age=(\d+)/u.exec(value)?.[1] ?? "NaN"),
    }));
}

interface ReloadObservation {
  readonly status: number;
  readonly projections: { path: string; maxAge: number }[];
}

/** One page reload: a fresh context over the persisted jar, then the repair request. */
async function reload(
  app: Fixture,
  current: APIRequestContext,
): Promise<{ browser: APIRequestContext; observation: ReloadObservation; saved: StorageState }> {
  const saved = await current.storageState();
  await current.dispose();
  const browser = await openBrowser(app.origin, saved);
  const response = await browser.post(`${app.origin}${PREFIX}/local-session`, { data: {} });
  const observation = {
    status: response.status(),
    projections: issuedProjections(response),
  };
  return { browser, observation, saved: await browser.storageState() };
}

async function expectAuthenticated(browser: APIRequestContext, origin: string): Promise<void> {
  const response = await browser.get(`${origin}${PREFIX}/channel`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ content: CANARY });
}

function expectRepairIssuedCookies(observation: ReloadObservation, remainingMs: number): void {
  expect(observation.status).toBe(200);
  // An acknowledged repair that issued no cookie is the defect shape of #4321: the page believes it
  // was repaired and holds nothing.
  expect(observation.projections).toHaveLength(APP_SESSION_ACTIVE_COOKIE_COUNT);
  const expectedMaxAge = Math.floor(remainingMs / 1_000);
  for (const projection of observation.projections) {
    expect(projection.path.startsWith("/api/")).toBe(true);
    expect(projection.maxAge).toBe(expectedMaxAge);
  }
}

async function pair(app: Fixture): Promise<{ browser: APIRequestContext; proof: string }> {
  const browser = await openBrowser(app.origin);
  const paired = await browser.post(`${app.origin}${PREFIX}/pair`, {
    data: fakePairingRequestBody(),
  });
  expect(paired.status()).toBe(200);
  return { browser, proof: proofOf(await browser.storageState()) };
}

it("keeps the session valid for 120 minutes with reloads at 26 and 31 minutes after pairing", async () => {
  let now = 0;
  const app = await fixture(() => now);
  const { proof, browser: pairedBrowser } = await pair(app);
  let browser = pairedBrowser;
  try {
    // The incident's grounded Chat turn: an operation held from shortly after pairing for ~24 min.
    now = 32_000;
    const release = app.registry.beginOperation(proof);
    expect(release).toBeDefined();
    now = 24 * MINUTE_MS;
    release?.();
    const schedule = [26, 31, 50, 70, 90, 110, 120];
    for (const minute of schedule) {
      now = minute * MINUTE_MS;
      const reloaded = await reload(app, browser);
      browser = reloaded.browser;
      expectRepairIssuedCookies(reloaded.observation, ABSOLUTE_LIFETIME_MS - now);
      expect(proofOf(reloaded.saved)).toBe(proof);
      await expectAuthenticated(browser, app.origin);
    }
    expect(app.registry.sessionCount()).toBe(1);
  } finally {
    await browser.dispose();
    await app.close();
  }
});

it("keeps a session whose operation runs the whole 120 minutes valid across reloads", async () => {
  let now = 0;
  const app = await fixture(() => now);
  const { proof, browser: pairedBrowser } = await pair(app);
  let browser = pairedBrowser;
  let release: (() => void) | undefined;
  try {
    release = app.registry.beginOperation(proof);
    expect(release).toBeDefined();
    for (const minute of [26, 31, 61, 91, 120]) {
      now = minute * MINUTE_MS;
      const reloaded = await reload(app, browser);
      browser = reloaded.browser;
      expectRepairIssuedCookies(reloaded.observation, ABSOLUTE_LIFETIME_MS - now);
      await expectAuthenticated(browser, app.origin);
    }
    release?.();
    release = undefined;
    // The release restarts the idle window from the release time, so a reload two minutes later holds.
    now += 2 * MINUTE_MS;
    const reloaded = await reload(app, browser);
    browser = reloaded.browser;
    expectRepairIssuedCookies(reloaded.observation, ABSOLUTE_LIFETIME_MS - now);
  } finally {
    release?.();
    await browser.dispose();
    await app.close();
  }
});

it("refuses, with no cookie, a reload after 31 idle minutes (negative control for the boundary)", async () => {
  let now = 0;
  const app = await fixture(() => now);
  const { browser: paired } = await pair(app);
  let browser = paired;
  try {
    now = 31 * MINUTE_MS;
    const reloaded = await reload(app, browser);
    browser = reloaded.browser;
    expect(reloaded.observation.status).toBe(200);
    expect(reloaded.observation.projections).toHaveLength(0);
  } finally {
    await browser.dispose();
    await app.close();
  }
});

it("keeps an approval-bound session repairable through the same 120 minutes", () => {
  for (const approvalTtlMs of [ABSOLUTE_LIFETIME_MS, 30 * 24 * 60 * MINUTE_MS]) {
    let now = 0;
    const registry = createSessionRegistry({ now: () => now });
    const mint = registry.mintForApproval("test-operator", {
      approvalId: `bra_${"a".repeat(32)}`,
      expiresAtMs: approvalTtlMs,
    });
    const release = registry.beginOperation(mint.cookieToken);
    now = 24 * MINUTE_MS;
    release?.();
    for (const minute of [26, 31, 50, 70, 90, 110, 120]) {
      now = minute * MINUTE_MS;
      const remaining = registry.verifyForCookieRepair(mint.cookieToken, { purpose: "repair" });
      expect(remaining).toBe(ABSOLUTE_LIFETIME_MS - now);
    }
    expect(registry.sessionCount()).toBe(1);
  }
});
