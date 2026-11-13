// Qualification: container only; Vitest --maxWorkers=2. No live server, model, Jira or child.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  events: [],
  held: false,
  failures: {},
  preflight: vi.fn(),
  release: vi.fn(),
  license: vi.fn(),
  createOwned: vi.fn(),
  start: vi.fn(),
  restart: vi.fn(),
  close: vi.fn(),
  fetch: vi.fn(),
  buildDeps: vi.fn(),
  createUiServer: vi.fn(),
  probe: vi.fn(),
  drain: vi.fn(),
}));

vi.mock("../testing/jira-chat-lab/run-preflight.mjs", () => ({ prepareLabRun: ports.preflight }));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: vi.fn(),
  labSessionConnection: vi.fn(),
  loadSession: vi.fn(),
  readPrivateFile: vi.fn(),
  requireLicense: ports.license,
}));
vi.mock("../testing/jira-chat-lab/owned-live-chat.mjs", async (original) => ({
  ...(await original()),
  createOwnedLiveChatProcess: ports.createOwned,
}));
vi.mock("../testing/jira-chat-lab/product-port.mjs", () => ({
  sessionVerificationPort: (_session, port) => port,
}));
vi.mock("../testing/jira-chat-lab/chat-lifecycle.mjs", () => ({ drainLiveChatTurns: ports.drain }));
vi.mock("node:net", () => ({
  createServer: () => ({
    listen: (_port, _host, ready) => ready(),
    address: () => ({ port: 32123 }),
    close: (done) => done(),
  }),
}));
vi.mock("../../packages/keiko-server/dist/index.js", () => ({
  buildUiHandlerDeps: ports.buildDeps,
  createUiServer: ports.createUiServer,
  buildCspHeader: vi.fn(),
  extractInlineScriptHashes: vi.fn(),
}));
vi.mock("../../packages/keiko-server/dist/observability/index.js", () => ({
  createFileServerLogSink: vi.fn(() => ({ write: vi.fn() })),
  createServerLogger: vi.fn(),
  setServerLogger: vi.fn(),
}));
vi.mock("../../packages/keiko-model-gateway/dist/index.js", () => ({
  parseGatewayConfig: (raw) => raw,
  createDefaultChatCapability: (id) => ({ id, contextWindow: 32768, maxOutputTokens: 2048 }),
  createDefaultEmbeddingCapability: vi.fn(),
  toolCallingConfigurationFingerprint: () => "fixture-fingerprint",
}));
vi.mock("../../packages/keiko-server/dist/credentialVault.js", () => ({
  createProviderSecretResolver: vi.fn(),
}));
vi.mock("../../packages/keiko-server/dist/gateway-tool-calling-probe.js", () => ({
  probeGatewayToolCalling: ports.probe,
}));
vi.mock(
  "../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js",
  () => ({
    mintLauncherPairingAttestation: () => ({}),
    SESSION_PAIRING_LAUNCHER_SECRET_ENV: "FIXTURE_LAUNCHER_SECRET",
  }),
);

import { withLiveChat, withModelFreeJira } from "../testing/jira-chat-lab/chat-read.mjs";

let directory;
function record(name) {
  ports.events.push({ name, held: ports.held });
}
function stage(name, value) {
  record(name);
  return ports.failures[name] ? Promise.reject(ports.failures[name]) : Promise.resolve(value);
}
function fakeDeps() {
  return {
    store: { listProjects: () => [], createProject: vi.fn() },
    atlassianConnectorCredentials: { httpBodyPortFactory: vi.fn() },
    gatewayConfig: { set: vi.fn(), recordVerifiedCapability: vi.fn() },
    dispose: () => stage("dispose"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ports.events = [];
  ports.held = false;
  ports.failures = {};
  directory = mkdtempSync(join(tmpdir(), "jira-owned-preflight-"));
  vi.stubEnv("KEIKO_JIRA_LAB_GATEWAY_CONFIG", undefined);
  vi.stubEnv("KEIKO_JIRA_LAB_CONTEXT_WINDOW", undefined);
  vi.stubGlobal("fetch", ports.fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  ports.release.mockImplementation(() => {
    record("release");
    ports.held = false;
  });
  ports.preflight.mockImplementation(() => {
    record("preflight");
    if (ports.failures.preflight) return Promise.reject(ports.failures.preflight);
    ports.held = true;
    return Promise.resolve(ports.release);
  });
  ports.license.mockImplementation(() =>
    stage(ports.license.mock.calls.length === 1 ? "license-open" : "license-audit", 3600),
  );
  ports.start.mockImplementation(() => stage("child-start"));
  ports.restart.mockImplementation(() =>
    stage("child-restart", { restarted: true, downtimeMs: 1 }),
  );
  ports.close.mockImplementation(() => stage("child-close"));
  ports.createOwned.mockImplementation(() => ({
    origin: "http://127.0.0.1:32123",
    start: ports.start,
    restart: ports.restart,
    close: ports.close,
  }));
  ports.fetch.mockImplementation(() =>
    stage("pair", {
      ok: true,
      headers: { getSetCookie: () => ["keiko-app-session=fixture; HttpOnly"] },
    }),
  );
  ports.buildDeps.mockImplementation(() => {
    record("build-deps");
    return fakeDeps();
  });
  ports.probe.mockImplementation(() => stage("model-probe", "verified"));
  ports.drain.mockImplementation(() => stage("drain"));
  ports.createUiServer.mockImplementation(() => ({
    once: vi.fn(),
    closeAllConnections: vi.fn(),
    listen: (_port, _host, ready) => {
      record("inprocess-start");
      ready();
    },
    close: (done) => {
      record("inprocess-close");
      done();
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function options(run, extra = {}) {
  return {
    session: { directory },
    modelId: "fixture-model",
    ownedChild: true,
    retainState: true,
    run,
    ...extra,
  };
}
function names() {
  return ports.events.map(({ name }) => name);
}
function expectLeaseLifetime() {
  expect(ports.preflight).toHaveBeenCalledExactlyOnceWith({ directory });
  expect(ports.release).toHaveBeenCalledOnce();
  expect(names()[0]).toBe("preflight");
  expect(names().at(-1)).toBe("release");
  expect(ports.events.filter(({ name }) => name !== "preflight").every(({ held }) => held)).toBe(
    true,
  );
  expect(ports.held).toBe(false);
}

describe("owned Chat runs use the canonical parent preflight and lane lease", () => {
  it("holds one parent lease through start, pairing, repeated restart, close and license audit", async () => {
    await withLiveChat(
      options(async (live) => {
        record("run-start");
        await live.restartServer({ signal: new globalThis.AbortController().signal });
        await live.restartServer({ signal: new globalThis.AbortController().signal });
        record("run-done");
      }),
    );
    expectLeaseLifetime();
    expect(names()).toEqual([
      "preflight",
      "license-open",
      "child-start",
      "pair",
      "run-start",
      "child-restart",
      "pair",
      "child-restart",
      "pair",
      "run-done",
      "child-close",
      "license-audit",
      "release",
    ]);
    expect(ports.createOwned).toHaveBeenCalledOnce();
    expect(ports.restart).toHaveBeenCalledTimes(2);
    expect(ports.buildDeps).not.toHaveBeenCalled();
    expect(ports.probe).not.toHaveBeenCalled();
  });

  it("refuses a failed canonical preflight before allocating any child, license check or session", async () => {
    const refused = new TypeError("synthetic-preflight-refused");
    ports.failures.preflight = refused;
    const run = vi.fn();
    await expect(withLiveChat(options(run))).rejects.toBe(refused);
    expect(ports.preflight).toHaveBeenCalledOnce();
    expect(ports.createOwned).not.toHaveBeenCalled();
    expect(ports.license).not.toHaveBeenCalled();
    expect(ports.fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
    expect(ports.held).toBe(false);
  });

  it.each(["child-start", "pair", "run", "child-restart", "child-close", "license-audit"])(
    "releases its parent lease only after cleanup and audit when %s fails",
    async (failedStage) => {
      const refused = new TypeError(`synthetic-${failedStage}-refused`);
      ports.failures[failedStage] = refused;
      await expect(
        withLiveChat(
          options(async (live) => {
            record("run-start");
            if (failedStage === "run") throw refused;
            if (failedStage === "child-restart") await live.restartServer();
            record("run-done");
          }),
        ),
      ).rejects.toBe(refused);
      expectLeaseLifetime();
      expect(ports.close).toHaveBeenCalledOnce();
      expect(ports.license).toHaveBeenCalledTimes(2);
      expect(names().indexOf("child-close")).toBeLessThan(names().indexOf("release"));
      expect(names().indexOf("license-audit")).toBeLessThan(names().indexOf("release"));
    },
  );

  it("preserves start, cleanup and audit failures before releasing exactly once", async () => {
    const refused = ["start", "close", "audit"].map(
      (name) => new TypeError(`synthetic-${name}-refused`),
    );
    ports.failures["child-start"] = refused[0];
    ports.failures["child-close"] = refused[1];
    ports.failures["license-audit"] = refused[2];
    const failure = await withLiveChat(options(vi.fn())).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual(refused);
    expectLeaseLifetime();
    expect(ports.close).toHaveBeenCalledOnce();
    expect(ports.license).toHaveBeenCalledTimes(2);
  });

  it("retains the same preflight owner for the default path and the lane-scoped memory directory", async () => {
    let root;
    await withLiveChat(
      options(
        () => {
          record("run");
        },
        {
          ownedChild: false,
          stateReady: (value) => {
            root = value;
          },
        },
      ),
    );
    expectLeaseLifetime();
    expect(ports.createOwned).not.toHaveBeenCalled();
    expect(ports.buildDeps).toHaveBeenCalledOnce();
    const env = ports.buildDeps.mock.calls[0][0].env;
    expect(env.KEIKO_MEMORY_DIR).toBe(join(root, "memory"));
    // The state directory is private too, so no diagnostics writer falls back to `<cwd>/.keiko`.
    expect(env.KEIKO_STATE_DIR).toBe(join(directory, "chat-read-logs"));
    expect(process.env.KEIKO_STATE_DIR).not.toBe(env.KEIKO_STATE_DIR);
    expect(env.KEIKO_OS_KEYCHAIN).toBe("off");
    expect(ports.probe).toHaveBeenCalledOnce();
  });

  it("keeps the model-free caller on that same parent lease without a model probe", async () => {
    await withModelFreeJira({
      session: { directory },
      run: () => {
        record("run");
      },
    });
    expectLeaseLifetime();
    expect(ports.createOwned).not.toHaveBeenCalled();
    expect(ports.probe).not.toHaveBeenCalled();
    expect(ports.buildDeps).toHaveBeenCalledOnce();
  });
});
