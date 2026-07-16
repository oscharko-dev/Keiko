import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchCodexAuthStatus,
  CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  createCodexAuthNavigationIntentCoordinator,
  createCodexSubscriptionProfileCoordinator,
  handleCodingCodexSubscriptionProfile,
  handleCodingCodexSubscriptionSetup,
  isCodexAuthNavigationUrl,
  type CodexAuthNavigationIntentCoordinator,
} from "./coding-codex-subscription.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

function realScheduler(): Pick<
  Parameters<typeof createCodexSubscriptionProfileCoordinator>[0],
  "setTimeout" | "clearTimeout"
> {
  return {
    setTimeout: (callback, delayMs): ReturnType<typeof setTimeout> => setTimeout(callback, delayMs),
    clearTimeout: (handle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

interface ManualScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (handle: object | number) => void;
  readonly runNext: () => void;
  readonly pendingCount: () => number;
}

function manualScheduler(): ManualScheduler {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    setTimeout: (callback): number => {
      nextHandle += 1;
      callbacks.set(nextHandle, callback);
      return nextHandle;
    },
    clearTimeout: (handle): void => {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    runNext: (): void => {
      const entry = callbacks.entries().next().value;
      if (entry === undefined) throw new Error("no scheduled timeout");
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pendingCount: (): number => callbacks.size,
  };
}

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
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
    ...overrides,
  };
}

function approvedRuntime(): Pick<UiHandlerDeps, "codexRuntimeAvailability"> {
  return { codexRuntimeAvailability: { isApprovedVerified: () => true } };
}

function req(body: unknown): RouteContext["req"] {
  const emitter = new EventEmitter() as RouteContext["req"];
  queueMicrotask(() => {
    emitter.emit("data", Buffer.from(JSON.stringify(body)));
    emitter.emit("end");
  });
  return emitter;
}

function ctx(body: unknown = {}): RouteContext {
  return {
    req: req(body),
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/coding-workbench/codex-subscription/setup"),
  };
}

describe("coding Codex subscription profile routes", () => {
  it("reports explicit unapproved redistribution without claiming runtime or setup support", async () => {
    const result = await handleCodingCodexSubscriptionProfile(ctx(), deps());

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "redistribution-unapproved",
        modelSource: "chatgpt-codex-subscription-profile",
        runtimeSource: "codex-cli-adapter",
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
        runtimeBinarySources: [],
        supportsBrowserLogin: false,
        supportsDeviceCode: false,
        supportsAccessToken: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain("CODEX_HOME");
    expect(JSON.stringify(result)).not.toContain(".codex");
    expect(JSON.stringify(result)).not.toContain("/private/user");
  });

  it.each([
    ["connected", { CODEX_ACCESS_TOKEN: "secret-token" }],
    ["expired", { KEIKO_CODEX_AUTH_STATUS: "expired" }],
    ["revoked", { KEIKO_CODEX_AUTH_STATUS: "revoked" }],
    ["unsupported-headless", { KEIKO_CODEX_AUTH_STATUS: "unsupported-headless" }],
    ["failed-login", { KEIKO_CODEX_AUTH_STATUS: "failed-login" }],
  ] as const)("projects %s status without leaking credential material", async (status, env) => {
    const result = await handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ env, ...approvedRuntime() }),
    );

    expect(result).toMatchObject({ status: 200, body: { status } });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("refresh");
    expect(JSON.stringify(result)).not.toContain("auth.json");
  });

  it("fails closed when deployment policy disables subscription login", async () => {
    let calls = 0;
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: () => {
        calls += 1;
        return Promise.resolve(codexProfile("connected"));
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 100,
      ...realScheduler(),
    });
    const result = await handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({
        env: { KEIKO_CODEX_SUBSCRIPTION_DISABLED: "1" },
        ...approvedRuntime(),
        codexSubscriptionProfileCoordinator: coordinator,
      }),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "disabled-by-deployment",
        deploymentPolicyDisabled: true,
      },
    });
    expect(calls).toBe(0);
  });

  it("uses one injected server-scoped coordinator only with verified runtime provenance", async () => {
    let calls = 0;
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: () => {
        calls += 1;
        return Promise.resolve(codexProfile("connected"));
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 100,
      ...realScheduler(),
    });

    const result = await handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ ...approvedRuntime(), codexSubscriptionProfileCoordinator: coordinator }),
    );
    const unapproved = await handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ codexSubscriptionProfileCoordinator: coordinator }),
    );

    expect(result).toMatchObject({ status: 200, body: { status: "connected" } });
    expect(unapproved).toMatchObject({
      status: 200,
      body: { status: "redistribution-unapproved" },
    });
    expect(calls).toBe(1);
  });

  it("returns a device-code setup plan without executing Codex or exposing paths", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "chatgpt-device-code" }),
      deps(approvedRuntime()),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        method: "chatgpt-device-code",
        commandLabel: "codex-login-device-auth",
        requiresSecretInput: false,
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain(".codex");
    expect(JSON.stringify(result)).not.toContain("/private/user");
    expect(JSON.stringify(result)).not.toContain("accessToken");
  });

  it("invalidates the injected profile coordinator when setup starts login", async () => {
    let calls = 0;
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: () => {
        calls += 1;
        return Promise.resolve(codexProfile("missing"));
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 100,
      ...realScheduler(),
    });
    const handlerDeps = deps({
      ...approvedRuntime(),
      codexSubscriptionProfileCoordinator: coordinator,
    });
    await coordinator.getProfile();

    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "chatgpt-device-code" }),
      handlerDeps,
    );
    await coordinator.getProfile();

    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("rejects access-token setup bodies that try to send the token to Keiko", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "codex-access-token", accessToken: "Bearer secret-token" }),
      deps(),
    );

    expect(result).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Codex subscription setup request is invalid.",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("blocks browser-login setup in unsupported headless environments", async () => {
    const result = await handleCodingCodexSubscriptionSetup(
      ctx({ method: "chatgpt-browser-login" }),
      deps({ env: { KEIKO_CODEX_HEADLESS: "1" }, ...approvedRuntime() }),
    );

    expect(result).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "CODEX_SUBSCRIPTION_UNAVAILABLE",
          message: "Codex subscription browser login is unavailable in this environment.",
        },
      },
    });
  });

  it("does not report connected from an access token without approved runtime provenance", async () => {
    const result = await handleCodingCodexSubscriptionProfile(
      ctx(),
      deps({ env: { CODEX_ACCESS_TOKEN: "secret-token" } }),
    );

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "redistribution-unapproved",
        runtimeBinarySources: [],
        supportsBrowserLogin: false,
        supportsDeviceCode: false,
        supportsAccessToken: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it.each(["chatgpt-browser-login", "chatgpt-device-code", "codex-access-token"] as const)(
    "blocks %s setup until Codex redistribution is approved",
    async (method) => {
      const result = await handleCodingCodexSubscriptionSetup(ctx({ method }), deps());

      expect(result).toMatchObject({
        status: 409,
        body: {
          status: "redistribution-unapproved",
          reasonCode: "redistribution-unapproved",
          codexSubscriptionAllowed: false,
          runtimeBinarySources: [],
          setupMethods: [],
        },
      });
    },
  );
});

describe("Codex subscription profile coordinator", () => {
  it("coalesces exactly twenty callers into one asynchronous probe and caches only the projection", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: async () => {
        calls += 1;
        await pending;
        return codexProfile("connected");
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 50,
      ...realScheduler(),
    });

    const callers = Array.from({ length: 20 }, () => coordinator.getProfile());
    await Promise.resolve();
    expect(calls).toBe(1);
    release?.();
    await expect(Promise.all(callers)).resolves.toEqual(Array(20).fill(codexProfile("connected")));

    await expect(coordinator.getProfile()).resolves.toEqual(codexProfile("connected"));
    expect(calls).toBe(1);
  });

  it("aborts one timed-out probe, settles twenty waiters once, and starts one replacement", async () => {
    const scheduler = manualScheduler();
    const signals: AbortSignal[] = [];
    const resolvers: ((profile: CodingWorkbenchCodexSubscriptionProfile) => void)[] = [];
    let aborts = 0;
    let calls = 0;
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: async (signal) => {
        calls += 1;
        signals.push(signal);
        signal.addEventListener("abort", () => {
          aborts += 1;
        });
        return new Promise<CodingWorkbenchCodexSubscriptionProfile>((resolve) => {
          resolvers.push(resolve);
        });
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 100,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });

    const settlements = Array.from({ length: 20 }, () => 0);
    const waiters = Array.from({ length: 20 }, (_, index) =>
      coordinator.getProfile().then((profile) => {
        settlements[index] = (settlements[index] ?? 0) + 1;
        return profile;
      }),
    );
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.runNext();
    const profiles = await Promise.all(waiters);
    expect(profiles).toEqual(Array(20).fill(unavailableCodexProfile()));
    expect(aborts).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(settlements).toEqual(Array(20).fill(1));

    resolvers[0]?.(codexProfile("connected"));
    await Promise.resolve();
    expect(settlements).toEqual(Array(20).fill(1));

    const replacement = coordinator.getProfile();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(scheduler.pendingCount()).toBe(1);
    resolvers[1]?.(codexProfile("missing"));
    await expect(replacement).resolves.toEqual(codexProfile("missing"));
    expect(calls).toBe(2);
  });

  it("invalidates on every login lifecycle boundary and does not let a late probe revive state", async () => {
    let resolveFirst: ((profile: CodingWorkbenchCodexSubscriptionProfile) => void) | undefined;
    let calls = 0;
    const coordinator = createCodexSubscriptionProfileCoordinator({
      probe: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<CodingWorkbenchCodexSubscriptionProfile>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return codexProfile("missing");
      },
      now: () => 100,
      ttlMs: 1_000,
      timeoutMs: 100,
      ...realScheduler(),
    });

    const stale = coordinator.getProfile();
    coordinator.loginStarted();
    resolveFirst?.(codexProfile("connected"));
    await expect(stale).resolves.toEqual(unavailableCodexProfile());

    for (const event of [
      (): void => {
        coordinator.browserLoginStarted();
      },
      (): void => {
        coordinator.deviceCodeLoginStarted();
      },
      (): void => {
        coordinator.loginCancelled();
      },
      (): void => {
        coordinator.loginCompleted();
      },
      (): void => {
        coordinator.loginSucceeded();
      },
      (): void => {
        coordinator.loginFailed();
      },
      (): void => {
        coordinator.loginExpired();
      },
      (): void => {
        coordinator.loginRevoked();
      },
      (): void => {
        coordinator.loginClosed("expired");
      },
      (): void => {
        coordinator.logout();
      },
    ]) {
      event();
      await expect(coordinator.getProfile()).resolves.toEqual(codexProfile("missing"));
    }
    expect(calls).toBe(11);
  });
});

describe("Codex authentication navigation intent", () => {
  it("binds distinct validated URLs to distinct opaque, non-serializing intents", () => {
    const intents = navigationIntents();
    const firstUrl = "https://auth.openai.com/authorize?code=secret-one#fragment";
    const secondUrl = "https://auth.openai.com/authorize?code=secret-two";
    const first = intents.create({ url: firstUrl, runId: "run-1", loginId: "login-1" });
    const second = intents.create({ url: secondUrl, runId: "run-1", loginId: "login-1" });

    expect(first).toEqual({ nonce: "nonce-1" });
    expect(second).toEqual({ nonce: "nonce-2" });
    expect(JSON.stringify([first, second])).not.toContain("secret-one");
    expect(JSON.stringify([first, second])).not.toContain("fragment");
    expect(intents.consume({ nonce: first?.nonce ?? "", runId: "run-1", loginId: "login-1" })).toBe(
      firstUrl,
    );
    expect(
      intents.consume({ nonce: second?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBe(secondUrl);
  });

  it("consumes an intent exactly once and denies replay", () => {
    const intents = navigationIntents();
    const intent = intents.create({
      url: "https://auth.openai.com/authorize?code=secret",
      runId: "run-1",
      loginId: "login-1",
    });

    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBe("https://auth.openai.com/authorize?code=secret");
    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBeUndefined();
  });

  it("denies expired and mismatched run or login consumption", () => {
    let now = 100;
    const intents = navigationIntents({ now: (): number => now, ttlMs: 10 });
    const intent = intents.create({
      url: "https://auth.openai.com/authorize?code=secret",
      runId: "run-1",
      loginId: "login-1",
    });

    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-2", loginId: "login-1" }),
    ).toBeUndefined();
    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-1", loginId: "login-2" }),
    ).toBeUndefined();
    now = 110;
    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBeUndefined();
  });

  it("wipes intents on login or run invalidation", () => {
    const intents = navigationIntents();
    const first = intents.create({
      url: "https://auth.openai.com/authorize?code=first",
      runId: "run-1",
      loginId: "login-1",
    });
    const second = intents.create({
      url: "https://auth.openai.com/authorize?code=second",
      runId: "run-1",
      loginId: "login-2",
    });
    intents.invalidateLogin("run-1", "login-1");
    intents.invalidateRun("run-1");

    expect(
      intents.consume({ nonce: first?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBeUndefined();
    expect(
      intents.consume({ nonce: second?.nonce ?? "", runId: "run-1", loginId: "login-2" }),
    ).toBeUndefined();
  });

  it("proactively wipes an expired URL at its exact deadline without a later operation", () => {
    const scheduler = navigationIntentScheduler();
    const intents = navigationIntents({
      now: scheduler.now,
      ttlMs: 10,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const intent = intents.create({
      url: "https://auth.openai.com/authorize?code=secret",
      runId: "run-1",
      loginId: "login-1",
    });

    expect(scheduler.pendingCount()).toBe(1);
    scheduler.advanceBy(9);
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.advanceBy(1);
    expect(scheduler.pendingCount()).toBe(0);
    expect(
      intents.consume({ nonce: intent?.nonce ?? "", runId: "run-1", loginId: "login-1" }),
    ).toBeUndefined();
  });

  it("denies duplicate nonces and capacity overflow without replacing a live intent", () => {
    const scheduler = navigationIntentScheduler();
    const intents = navigationIntents({
      maxIntents: 2,
      newNonce: (): string => "duplicate",
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const first = intents.create({
      url: "https://auth.openai.com/authorize?code=first",
      runId: "run-1",
      loginId: "login-1",
    });
    const duplicate = intents.create({
      url: "https://auth.openai.com/authorize?code=second",
      runId: "run-1",
      loginId: "login-2",
    });

    expect(duplicate).toBeUndefined();
    expect(scheduler.pendingCount()).toBe(1);
    expect(intents.consume({ nonce: first?.nonce ?? "", runId: "run-1", loginId: "login-1" })).toBe(
      "https://auth.openai.com/authorize?code=first",
    );

    let sequence = 0;
    const bounded = navigationIntents({
      maxIntents: 2,
      newNonce: (): string => `nonce-${String(++sequence)}`,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    bounded.create({
      url: "https://auth.openai.com/authorize?code=one",
      runId: "run",
      loginId: "1",
    });
    bounded.create({
      url: "https://auth.openai.com/authorize?code=two",
      runId: "run",
      loginId: "2",
    });
    expect(
      bounded.create({
        url: "https://auth.openai.com/authorize?code=three",
        runId: "run",
        loginId: "3",
      }),
    ).toBeUndefined();
  });

  it("clears expiry timers on consume, invalidation, and disposal", () => {
    const scheduler = navigationIntentScheduler();
    const intents = navigationIntents({
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const consumed = intents.create({
      url: "https://auth.openai.com/authorize?code=consume",
      runId: "run-1",
      loginId: "login-1",
    });
    const invalidated = intents.create({
      url: "https://auth.openai.com/authorize?code=invalidate",
      runId: "run-1",
      loginId: "login-2",
    });
    const disposed = intents.create({
      url: "https://auth.openai.com/authorize?code=dispose",
      runId: "run-2",
      loginId: "login-3",
    });

    expect(scheduler.pendingCount()).toBe(3);
    intents.consume({ nonce: consumed?.nonce ?? "", runId: "run-1", loginId: "login-1" });
    expect(scheduler.pendingCount()).toBe(2);
    intents.invalidateLogin("run-1", "login-2");
    expect(scheduler.pendingCount()).toBe(1);
    intents.dispose();
    expect(scheduler.pendingCount()).toBe(0);
    expect(
      intents.consume({ nonce: invalidated?.nonce ?? "", runId: "run-1", loginId: "login-2" }),
    ).toBeUndefined();
    expect(
      intents.consume({ nonce: disposed?.nonce ?? "", runId: "run-2", loginId: "login-3" }),
    ).toBeUndefined();
  });

  it.each([
    "http://auth.openai.com/authorize",
    "https://user:password@auth.openai.com/authorize",
    "https://auth.openai.com:444/authorize",
    "https://openai.com/authorize",
  ])("rejects unsafe authentication navigation URLs", (url) => {
    expect(isCodexAuthNavigationUrl(url)).toBe(false);
  });

  it("accepts only the official HTTPS origin at its default port", () => {
    expect(isCodexAuthNavigationUrl("https://auth.openai.com/authorize")).toBe(true);
    expect(isCodexAuthNavigationUrl("https://auth.openai.com:443/authorize")).toBe(true);
  });
});

function navigationIntents(
  overrides: Partial<Parameters<typeof createCodexAuthNavigationIntentCoordinator>[0]> = {},
): CodexAuthNavigationIntentCoordinator {
  let sequence = 0;
  return createCodexAuthNavigationIntentCoordinator({
    now: (): number => 100,
    ttlMs: 1_000,
    newNonce: (): string => {
      sequence += 1;
      return `nonce-${String(sequence)}`;
    },
    sha256: (value): string => `sha256:${value.length.toString(16)}`,
    ...overrides,
  });
}

interface NavigationIntentScheduler {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (handle: object | number) => void;
  readonly advanceBy: (milliseconds: number) => void;
  readonly pendingCount: () => number;
}

function navigationIntentScheduler(): NavigationIntentScheduler {
  let now = 100;
  let nextHandle = 0;
  const scheduled = new Map<number, { readonly callback: () => void; readonly dueAt: number }>();
  const runDue = (): void => {
    for (;;) {
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.dueAt <= now)
        .sort(([left], [right]) => left - right)[0];
      if (due === undefined) return;
      scheduled.delete(due[0]);
      due[1].callback();
    }
  };
  return {
    now: (): number => now,
    setTimeout: (callback, delayMs): number => {
      nextHandle += 1;
      scheduled.set(nextHandle, { callback, dueAt: now + delayMs });
      return nextHandle;
    },
    clearTimeout: (handle): void => {
      if (typeof handle === "number") scheduled.delete(handle);
    },
    advanceBy: (milliseconds): void => {
      now += milliseconds;
      runDue();
    },
    pendingCount: (): number => scheduled.size,
  };
}

function codexProfile(
  status: CodingWorkbenchCodexAuthStatus,
): CodingWorkbenchCodexSubscriptionProfile {
  return {
    schemaVersion: "1",
    profileId: "codex-subscription",
    modelSource: "chatgpt-codex-subscription-profile",
    runtimeSource: "codex-cli-adapter",
    status,
    credentialStore: "file",
    stateScope: "keiko-owned-state",
    stateRoot: "keiko-codex-runtime-state",
    usesGlobalCodexHome: false,
    runtimeBinarySources: [],
    supportsBrowserLogin: false,
    supportsDeviceCode: false,
    supportsAccessToken: false,
    deploymentPolicyDisabled: false,
    headless: false,
  };
}

function unavailableCodexProfile(): CodingWorkbenchCodexSubscriptionProfile {
  return codexProfile("failed-login");
}
