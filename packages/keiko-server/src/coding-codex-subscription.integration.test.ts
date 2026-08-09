import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodingWorkbenchCodexSubscriptionProfile } from "@oscharko-dev/keiko-contracts";

import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createCodexSubscriptionProfileCoordinator } from "./coding-codex-subscription.js";
import { buildCspHeader } from "./csp.js";
import { createUiServer, UI_HOST } from "./server.js";

interface RunningServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

function handlerDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: "/private/user/.keiko/keiko-ui.db",
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

async function startServer(deps: UiHandlerDeps): Promise<RunningServer> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-codex-profile-"));
  await writeFile(join(staticRoot, "index.html"), "<html></html>", "utf8");
  const csp = buildCspHeader([]);
  const reservation = createUiServer({ staticRoot, csp, port: 0, handlerDeps: deps });
  const port = await listen(reservation);
  await close(reservation);
  const server = createUiServer({ staticRoot, csp, port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return {
    baseUrl: `http://${UI_HOST}:${String(port)}`,
    close: async (): Promise<void> => {
      await close(server);
      await rm(staticRoot, { recursive: true, force: true });
    },
  };
}

/** Fetches and drains the body, so a response counts only once it has fully arrived. */
async function drainedGet(url: string): Promise<{ readonly status: number }> {
  const response = await fetch(url);
  await response.arrayBuffer();
  return { status: response.status };
}

function withCoordinator(
  probe: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
): UiHandlerDeps {
  const coordinator = createCodexSubscriptionProfileCoordinator({
    probe,
    now: () => Date.now(),
    ttlMs: 1_000,
    timeoutMs,
    setTimeout: (callback, delayMs): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
    clearTimeout: (handle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  return {
    ...handlerDeps(),
    codexRuntimeAvailability: { isApprovedVerified: () => true },
    codexSubscriptionProfileCoordinator: coordinator,
  };
}

function connectedProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return profileProjection("connected");
}

function profileProjection(
  status: "connected" | "missing",
): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: "1" as const,
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile" as const,
    runtimeSource: "codex-cli-adapter" as const,
    status,
    credentialStore: "file" as const,
    stateScope: "keiko-owned-state" as const,
    stateRoot: "keiko-codex-runtime-state" as const,
    usesGlobalCodexHome: false as const,
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

describe("Codex profile BFF responsiveness", () => {
  it("coalesces twenty deferred profiles while one hundred health requests stay responsive", async () => {
    let probes = 0;
    const server = await startServer(
      withCoordinator(async () => {
        probes += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return connectedProfile();
      }, 500),
    );
    try {
      const profileUrl = `${server.baseUrl}/api/coding-workbench/codex-subscription/profile`;
      const profiles = Promise.all(Array.from({ length: 20 }, () => drainedGet(profileUrl)));
      // Whether the deferred probe blocked the server is an ORDERING fact, not a duration: if the
      // twenty profile requests held the loop, the hundred health requests could not finish first.
      let profilesSettled = false;
      void profiles.then(() => {
        profilesSettled = true;
      });
      const healthUrl = `${server.baseUrl}/api/health`;
      const health = await Promise.all(Array.from({ length: 100 }, () => drainedGet(healthUrl)));
      const healthFinishedFirst = !profilesSettled;
      const profileResults = await profiles;

      expect(probes).toBe(1);
      expect(health.every((result) => result.status === 200)).toBe(true);
      expect(profileResults.every((result) => result.status === 200)).toBe(true);
      expect(healthFinishedFirst).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("bounds a hanging profile probe without stalling unrelated health requests", async () => {
    let probes = 0;
    let aborts = 0;
    const server = await startServer(
      withCoordinator((signal) => {
        probes += 1;
        signal.addEventListener("abort", () => {
          aborts += 1;
        });
        return new Promise<never>(() => undefined);
      }, 50),
    );
    try {
      const profileUrl = `${server.baseUrl}/api/coding-workbench/codex-subscription/profile`;
      const profiles = Promise.all(Array.from({ length: 20 }, () => drainedGet(profileUrl)));
      const healthUrl = `${server.baseUrl}/api/health`;
      const health = await Promise.all(Array.from({ length: 100 }, () => drainedGet(healthUrl)));
      const profileResults = await profiles;

      // This probe NEVER resolves. Every assertion below is therefore load-independent: the
      // profile requests can only answer 200 because the coordinator's own timeout bounded them,
      // `aborts` proves the abort actually fired, and a server that genuinely stalled on the
      // hanging probe would not answer at all — it would hang until the suite's own timeout, which
      // is what a real regression looks like here. A wall-clock ceiling added nothing to that and
      // measured the runner instead: it was widened from 200ms after flaking at 200.38ms.
      expect(probes).toBe(1);
      expect(aborts).toBe(1);
      expect(profileResults.every((result) => result.status === 200)).toBe(true);
      expect(health.every((result) => result.status === 200)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
