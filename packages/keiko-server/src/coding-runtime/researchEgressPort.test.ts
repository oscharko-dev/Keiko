import { describe, expect, it } from "vitest";

import {
  validateCodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayFetchOptions,
  OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

import type { CodingToolMutationGuard } from "./codingToolFacadePorts.js";
import type { CodingToolActionOf } from "./codingToolGovernedDelegate.js";
import {
  createResearchEgressPort,
  sanitizeVisibleText,
  sha256Hex,
  type ResearchEgressPortConfig,
  type ResearchEgressPortDeps,
} from "./researchEgressPort.js";
import type {
  ResearchChargeResult,
  ResearchGrantRegistry,
  ResolvedResearchGrant,
} from "./researchGrantRegistry.js";

const IDENTITY = { actionId: "action-1", idempotencyKey: "key-1" } as const;
const LIVE_GUARD: CodingToolMutationGuard = { check: (): boolean => true };
const DEAD_GUARD: CodingToolMutationGuard = { check: (): boolean => false };

function egressRequest(target: string): CodingToolActionOf<"egress"> {
  return { ...IDENTITY, action: "egress", target };
}

function makeGrant(overrides: Partial<ResolvedResearchGrant> = {}): ResolvedResearchGrant {
  return {
    grantId: "grant-1",
    runId: "run-1",
    domains: ["docs.example.com"],
    expiresAtMs: 10_000,
    approvalDigest: "b".repeat(64),
    maxFetches: 8,
    usedFetches: 0,
    maxTotalBytes: 1_000_000,
    usedBytes: 0,
    ...overrides,
  };
}

interface FetchCall {
  readonly url: string;
  readonly options: GatewayFetchOptions;
}

interface Harness {
  readonly execute: (
    request: CodingToolActionOf<"egress">,
    signal: AbortSignal | undefined,
    guard: CodingToolMutationGuard,
  ) => Promise<unknown>;
  readonly events: CodingWorkbenchRuntimeEvent[];
  readonly charges: { grantId: string; bytes: number }[];
  readonly reserves: { grantId: string }[];
  readonly calls: FetchCall[];
}

interface HarnessConfig {
  readonly grants: readonly ResolvedResearchGrant[];
  readonly responses?: readonly (Response | Error)[];
  // Static override for every `reserveFetch` call. Takes precedence over `maxReserves`.
  readonly reserve?: ResearchChargeResult;
  // The (maxReserves + 1)th `reserveFetch` call, and every one after, returns "limit-reached" —
  // simulates a real registry's per-grant fetch-count budget across redirect hops.
  readonly maxReserves?: number;
  readonly charge?: ResearchChargeResult;
  readonly gatewayEgress?: OutboundHttpEgressConfig | undefined;
  readonly portConfig?: ResearchEgressPortConfig;
  readonly now?: number;
}

function harness(config: HarnessConfig): Harness {
  const events: CodingWorkbenchRuntimeEvent[] = [];
  const charges: { grantId: string; bytes: number }[] = [];
  const reserves: { grantId: string }[] = [];
  const calls: FetchCall[] = [];
  const queue = [...(config.responses ?? [])];
  const registry: ResearchGrantRegistry = {
    register: () => undefined,
    activeGrants: () => config.grants,
    resolveForHost: () => undefined,
    reserveFetch: (_runId, grantId) => {
      reserves.push({ grantId });
      if (config.reserve !== undefined) return config.reserve;
      if (config.maxReserves !== undefined && reserves.length > config.maxReserves) {
        return "limit-reached";
      }
      return "ok";
    },
    chargeFetch: (_runId, grantId, bytes) => {
      charges.push({ grantId, bytes });
      return config.charge ?? "ok";
    },
    invalidateRun: () => undefined,
  };
  const deps: ResearchEgressPortDeps = {
    registry,
    resolveRunId: () => "run-1",
    gatewayEgress: () => config.gatewayEgress,
    emitEvent: (event) => events.push(event),
    now: () => config.now ?? 5_000,
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error("no scripted response"));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    ...(config.portConfig === undefined ? {} : { config: config.portConfig }),
  };
  return { execute: createResearchEgressPort(deps).execute, events, charges, reserves, calls };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function ok(body: string): Response {
  return new Response(body, { status: 200 });
}

describe("researchEgressPort success path", () => {
  it("completes an allowlisted fetch, charges the grant, and emits a content-free event", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("hello")] });

    const result = await test.execute(
      egressRequest("https://docs.example.com/"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toEqual({
      status: "completed",
      read: { text: "hello", byteCount: 5, digest: sha256Hex("hello") },
    });
    expect(test.charges).toEqual([{ grantId: "grant-1", bytes: 5 }]);
    expect(test.events).toHaveLength(1);
    const event = test.events[0];
    expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
    expect(Object.keys(event ?? {}).sort()).toEqual([
      "auxiliaryOutcome",
      "byteCount",
      "eventId",
      "kind",
      "occurredAt",
      "runId",
      "schemaVersion",
    ]);
    expect(event?.kind).toBe("research-performed");
    expect(event?.auxiliaryOutcome).toBe("accepted");
    expect(event?.byteCount).toBe(5);
  });

  it("sends a fixed research identity and never a credential or cookie header", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("x")] });

    await test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD);

    const sent = new Headers(test.calls[0]?.options.headers);
    expect(sent.has("authorization")).toBe(false);
    expect(sent.has("cookie")).toBe(false);
    expect(sent.has("x-api-key")).toBe(false);
    expect(sent.has("api-key")).toBe(false);
    expect(sent.get("user-agent")).toBe("Keiko-Research/1");
    expect(sent.get("accept-language")).toBe("en");
    expect(test.calls[0]?.options.method).toBe("GET");
  });

  it("builds a distinct research egress config: denies loopback, drops private-network allowances", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [ok("x")],
      gatewayEgress: {
        httpsProxy: "http://proxy.internal:8080",
        noProxy: ["metadata.internal"],
        allowPrivateNetwork: true,
        allowLinkLocalAndMetadata: true,
      },
    });

    await test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD);

    const egress = test.calls[0]?.options.egress;
    expect(egress?.denyLoopback).toBe(true);
    expect(egress?.httpsProxy).toBe("http://proxy.internal:8080");
    expect(egress?.noProxy).toEqual(["metadata.internal"]);
    expect(egress?.allowPrivateNetwork).toBeUndefined();
    expect(egress?.allowLinkLocalAndMetadata).toBeUndefined();
  });
});

describe("researchEgressPort target admission", () => {
  it("rejects a non-https target", async () => {
    const test = harness({ grants: [makeGrant()] });
    await expect(
      test.execute(egressRequest("http://docs.example.com/a"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a target carrying embedded credentials", async () => {
    const test = harness({ grants: [makeGrant()] });
    await expect(
      test.execute(egressRequest("https://user:pass@docs.example.com/a"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a target on a non-default port", async () => {
    const test = harness({ grants: [makeGrant()] });
    await expect(
      test.execute(egressRequest("https://docs.example.com:8443/a"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a malformed target", async () => {
    const test = harness({ grants: [makeGrant()] });
    await expect(test.execute(egressRequest("not a url"), undefined, LIVE_GUARD)).resolves.toEqual({
      status: "failed",
    });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects when there is no active grant", async () => {
    const test = harness({ grants: [] });
    await expect(
      test.execute(egressRequest("https://docs.example.com/a"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a host not covered by any grant (no subdomain widening)", async () => {
    const test = harness({ grants: [makeGrant({ domains: ["example.com"] })] });
    await expect(
      test.execute(egressRequest("https://sub.example.com/a"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });
});

describe("researchEgressPort revocation and cancellation", () => {
  it("rejects an already-aborted signal", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("x")] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      test.execute(egressRequest("https://docs.example.com/a"), controller.signal, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects when the mutation guard is revoked before the run", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("x")] });
    await expect(
      test.execute(egressRequest("https://docs.example.com/a"), undefined, DEAD_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("re-checks the guard on every hop and fails a mid-run revocation after a redirect", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("https://docs.example.com/next"), ok("x")],
    });
    const outcomes = [true, true, false];
    let index = 0;
    const guard: CodingToolMutationGuard = {
      check: (): boolean => {
        const value = outcomes[index] ?? false;
        index += 1;
        return value;
      },
    };

    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, guard),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(1);
    expect(test.charges).toHaveLength(0);
    expect(test.events).toHaveLength(0);
  });
});

describe("researchEgressPort redirect handling", () => {
  it("follows an allowlisted redirect to another grant domain and completes", async () => {
    const test = harness({
      grants: [makeGrant({ domains: ["a.example.com", "b.example.com"] })],
      responses: [redirect("https://b.example.com/x"), ok("ok")],
    });

    const result = await test.execute(
      egressRequest("https://a.example.com/"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toEqual({
      status: "completed",
      read: { text: "ok", byteCount: 2, digest: sha256Hex("ok") },
    });
    expect(test.calls).toHaveLength(2);
    expect(test.calls[1]?.url).toBe("https://b.example.com/x");
    expect(test.charges).toEqual([{ grantId: "grant-1", bytes: 2 }]);
  });

  it("rejects a redirect that escapes the allowlisted domains and emits a denied event", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("https://evil.example.net/a")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(1);
    expect(test.charges).toHaveLength(0);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.auxiliaryOutcome).toBe("denied");
  });

  it("rejects a redirect to a private/metadata host", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("https://169.254.169.254/latest/meta-data")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(1);
  });

  it("rejects a redirect to a non-https location", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("http://docs.example.com/a")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
  });

  it("rejects a redirect with an absent location header", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [new Response(null, { status: 302 })],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
  });

  it("stops after exhausting the redirect budget", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("https://docs.example.com/1"), redirect("https://docs.example.com/2")],
      portConfig: { maxRedirects: 1 },
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(2);
    expect(test.charges).toHaveLength(0);
  });

  it("performs at most the reserved hops when the grant's fetch budget runs out mid-redirect", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [redirect("https://docs.example.com/1"), redirect("https://docs.example.com/2")],
      maxReserves: 1,
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.reserves).toHaveLength(2);
    expect(test.calls).toHaveLength(1);
  });
});

describe("researchEgressPort transport and budget failures", () => {
  it("fails closed when the fetch transport throws and drops the body", async () => {
    const test = harness({
      grants: [makeGrant()],
      responses: [new Error("blocked by egress policy")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.charges).toHaveLength(0);
    expect(test.events).toHaveLength(0);
  });

  it("makes no fetchImpl call at all when the grant's fetch budget is already exhausted", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("x")], reserve: "limit-reached" });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.reserves).toHaveLength(1);
    expect(test.calls).toHaveLength(0);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.auxiliaryOutcome).toBe("limit-reached");
  });

  it("fails closed and emits a limit-reached event when the byte budget is exhausted after the read", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("x")], charge: "limit-reached" });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(1);
    expect(test.charges).toHaveLength(1);
    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.auxiliaryOutcome).toBe("limit-reached");
  });

  it("fails closed and emits a denial event when the grant is expired or unknown at charge time", async () => {
    const expired = harness({ grants: [makeGrant()], responses: [ok("x")], charge: "expired" });
    await expect(
      expired.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(expired.events[0]?.auxiliaryOutcome).toBe("denied");

    const unknown = harness({ grants: [makeGrant()], responses: [ok("x")], charge: "unknown" });
    await expect(
      unknown.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(unknown.events[0]?.auxiliaryOutcome).toBe("unavailable");
  });
});

describe("researchEgressPort request-line binding", () => {
  function requestLineDigest(pathname: string, query: string): string {
    return sha256Hex(sanitizeVisibleText(`${pathname} ${query}`));
  }

  it("allows a root path with an empty query without any bound digest", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("page")] });
    await expect(
      test.execute(egressRequest("https://docs.example.com/"), undefined, LIVE_GUARD),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("admits a non-root path whose decoded request line matches the bound digest", async () => {
    const digest = requestLineDigest("/guide", "");
    const test = harness({
      grants: [makeGrant({ queryTextDigest: digest })],
      responses: [ok("page")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/guide"), undefined, LIVE_GUARD),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects a non-root path when the grant bound no digest (path-smuggling)", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("page")] });
    await expect(
      test.execute(
        egressRequest("https://docs.example.com/c2VjcmV0LXRva2Vu"),
        undefined,
        LIVE_GUARD,
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a non-root path whose decoded text does not match the bound digest", async () => {
    const digest = requestLineDigest("/guide", "");
    const test = harness({
      grants: [makeGrant({ queryTextDigest: digest })],
      responses: [ok("page")],
    });
    await expect(
      test.execute(egressRequest("https://docs.example.com/other"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("admits a query that matches the grant's bound request-line digest", async () => {
    const digest = requestLineDigest("/s", "q=react hooks");
    const test = harness({
      grants: [makeGrant({ queryTextDigest: digest })],
      responses: [ok("page")],
    });

    const result = await test.execute(
      egressRequest("https://docs.example.com/s?q=react+hooks"),
      undefined,
      LIVE_GUARD,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(test.calls).toHaveLength(1);
  });

  it("rejects a query that does not match the bound digest (query-smuggling)", async () => {
    const digest = requestLineDigest("/s", "q=react hooks");
    const test = harness({
      grants: [makeGrant({ queryTextDigest: digest })],
      responses: [ok("page")],
    });
    await expect(
      test.execute(
        egressRequest("https://docs.example.com/s?q=evil+payload"),
        undefined,
        LIVE_GUARD,
      ),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("rejects a root path with a non-empty query when the grant bound no digest", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("page")] });
    await expect(
      test.execute(egressRequest("https://docs.example.com/?q=anything"), undefined, LIVE_GUARD),
    ).resolves.toEqual({ status: "failed" });
    expect(test.calls).toHaveLength(0);
  });

  it("emits a content-free denied event with no url/query when the request line is smuggled", async () => {
    const test = harness({ grants: [makeGrant()], responses: [ok("page")] });

    await test.execute(
      egressRequest("https://docs.example.com/c2VjcmV0LXRva2Vu"),
      undefined,
      LIVE_GUARD,
    );

    expect(test.events).toHaveLength(1);
    const event = test.events[0];
    expect(validateCodingWorkbenchRuntimeEvent(event).ok).toBe(true);
    expect(event?.kind).toBe("research-performed");
    expect(event?.auxiliaryOutcome).not.toBe("accepted");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/docs\.example\.com|c2VjcmV0|https?:|[?&]q=/iu);
  });
});

describe("sanitizeVisibleText", () => {
  it("normalizes whitespace and strips control characters deterministically", () => {
    expect(sanitizeVisibleText("  react   hooks\t\n")).toBe("react hooks");
    expect(sanitizeVisibleText("react hooks")).toBe("react hooks");
  });
});
