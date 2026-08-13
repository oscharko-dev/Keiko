import { describe, expect, it } from "vitest";

import type { AuxiliaryResearchScopeV1 } from "@oscharko-dev/keiko-contracts";

import {
  RESEARCH_GRANT_DEFAULT_MAX_FETCHES,
  RESEARCH_GRANT_DEFAULT_MAX_TOTAL_BYTES,
  createResearchGrantRegistry,
  normalizeResearchHost,
  type ResearchGrantRegistry,
  type ResearchGrantRegistryOptions,
} from "./researchGrantRegistry.js";

const NOW = 1_000_000;
const DIGEST = "a".repeat(64);
const FAR_FUTURE = "2100-01-01T00:00:00.000Z";
const RUN = "run-1";
const APPROVAL = "b".repeat(64);

interface ScopeOptions {
  readonly grantId?: string;
  readonly domains?: readonly string[];
  readonly expiresAt?: string;
  readonly queryTextDigest?: AuxiliaryResearchScopeV1["queryTextDigest"];
}

function makeScope(options: ScopeOptions = {}): AuxiliaryResearchScopeV1 {
  return {
    grantId: (options.grantId ?? "grant-1") as AuxiliaryResearchScopeV1["grantId"],
    domains: options.domains ?? ["example.com"],
    expiresAt: options.expiresAt ?? FAR_FUTURE,
    queryTextDigest: options.queryTextDigest ?? { outcome: "known", value: DIGEST },
  };
}

function registry(options: ResearchGrantRegistryOptions = {}): ResearchGrantRegistry {
  return createResearchGrantRegistry(options);
}

describe("ResearchGrantRegistry registration", () => {
  it("registers a grant with canonicalized, de-duplicated public domains and zeroed budgets", () => {
    const grant = registry().register(
      RUN,
      makeScope({ domains: ["Example.COM", "docs.example.com", "example.com."] }),
      "typed query",
      APPROVAL,
      NOW,
    );

    expect(grant).toBeDefined();
    expect(grant?.domains).toEqual(["example.com", "docs.example.com"]);
    expect(grant?.usedFetches).toBe(0);
    expect(grant?.usedBytes).toBe(0);
    expect(grant?.maxFetches).toBe(RESEARCH_GRANT_DEFAULT_MAX_FETCHES);
    expect(grant?.maxTotalBytes).toBe(RESEARCH_GRANT_DEFAULT_MAX_TOTAL_BYTES);
    expect(grant?.queryTextDigest).toBe(DIGEST);
    expect(grant?.sanitizedQuery).toBe("typed query");
    expect(grant?.approvalDigest).toBe(APPROVAL);
  });

  it("caps expiry at the store TTL and honors an earlier scope expiry", () => {
    const store = registry({ limits: { maxGrantTtlMs: 60_000 } });
    const capped = store.register(
      RUN,
      makeScope({ expiresAt: FAR_FUTURE }),
      undefined,
      APPROVAL,
      NOW,
    );
    const earlier = store.register(
      "run-2",
      makeScope({ expiresAt: new Date(NOW + 10_000).toISOString() }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(capped?.expiresAtMs).toBe(NOW + 60_000);
    expect(earlier?.expiresAtMs).toBe(NOW + 10_000);
  });

  it("records an unknown query digest as an unbound grant", () => {
    const grant = registry().register(
      RUN,
      makeScope({ queryTextDigest: { outcome: "unknown" } }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(grant?.queryTextDigest).toBeUndefined();
  });

  it("fails closed on an empty domain list", () => {
    expect(
      registry().register(RUN, makeScope({ domains: [] }), undefined, APPROVAL, NOW),
    ).toBeUndefined();
  });

  it("fails closed on any non-public (ip literal or loopback) domain", () => {
    const store = registry();
    expect(
      store.register(RUN, makeScope({ domains: ["127.0.0.1"] }), undefined, APPROVAL, NOW),
    ).toBeUndefined();
    expect(
      store.register(RUN, makeScope({ domains: ["localhost"] }), undefined, APPROVAL, NOW),
    ).toBeUndefined();
    expect(
      store.register(
        RUN,
        makeScope({ domains: ["example.com", "169.254.169.254"] }),
        undefined,
        APPROVAL,
        NOW,
      ),
    ).toBeUndefined();
  });

  it("fails closed on an elapsed or unparseable expiry", () => {
    const store = registry();
    expect(
      store.register(
        RUN,
        makeScope({ expiresAt: new Date(NOW - 1).toISOString() }),
        undefined,
        APPROVAL,
        NOW,
      ),
    ).toBeUndefined();
    expect(
      store.register(RUN, makeScope({ expiresAt: "not-a-real-date" }), undefined, APPROVAL, NOW),
    ).toBeUndefined();
  });

  it("replaces a re-registered grant id idempotently", () => {
    const store = registry();
    store.register(
      RUN,
      makeScope({ grantId: "grant-1", domains: ["one.example.com"] }),
      undefined,
      APPROVAL,
      NOW,
    );
    store.register(
      RUN,
      makeScope({ grantId: "grant-1", domains: ["two.example.com"] }),
      undefined,
      APPROVAL,
      NOW,
    );

    const active = store.activeGrants(RUN, NOW);
    expect(active).toHaveLength(1);
    expect(active[0]?.domains).toEqual(["two.example.com"]);
  });
});

describe("ResearchGrantRegistry resolution and pruning", () => {
  it("matches a host exactly and never widens to a subdomain or sibling", () => {
    const store = registry();
    store.register(
      RUN,
      makeScope({ domains: ["example.com", "docs.example.com"] }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(store.resolveForHost(RUN, "example.com", NOW)?.grantId).toBe("grant-1");
    expect(store.resolveForHost(RUN, "EXAMPLE.COM", NOW)?.grantId).toBe("grant-1");
    expect(store.resolveForHost(RUN, "example.com.", NOW)?.grantId).toBe("grant-1");
    expect(store.resolveForHost(RUN, "docs.example.com", NOW)?.grantId).toBe("grant-1");
    expect(store.resolveForHost(RUN, "api.example.com", NOW)).toBeUndefined();
    expect(store.resolveForHost(RUN, "evilexample.com", NOW)).toBeUndefined();
    expect(store.resolveForHost(RUN, "example.com.evil.com", NOW)).toBeUndefined();
  });

  it("prunes expired grants from activeGrants and resolveForHost", () => {
    const store = registry();
    store.register(
      RUN,
      makeScope({ expiresAt: new Date(NOW + 5_000).toISOString() }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(store.activeGrants(RUN, NOW + 4_999)).toHaveLength(1);
    expect(store.activeGrants(RUN, NOW + 6_000)).toHaveLength(0);
    expect(store.resolveForHost(RUN, "example.com", NOW + 6_000)).toBeUndefined();
  });
});

describe("ResearchGrantRegistry fetch reservation", () => {
  it("reserves fetches until the fetch-count budget is exhausted, before any network call", () => {
    const store = registry({ limits: { maxFetchesPerGrant: 2 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("ok");
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("ok");
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("limit-reached");
    expect(store.activeGrants(RUN, NOW)[0]?.usedFetches).toBe(2);
  });

  it("does not charge the byte budget when reserving a fetch", () => {
    const store = registry();
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    store.reserveFetch(RUN, "grant-1", NOW);
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(0);
  });

  it("returns expired after the grant elapses and unknown for a missing grant or run", () => {
    const store = registry();
    store.register(
      RUN,
      makeScope({ expiresAt: new Date(NOW + 5_000).toISOString() }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(store.reserveFetch(RUN, "grant-1", NOW + 6_000)).toBe("expired");
    expect(store.reserveFetch(RUN, "absent-grant", NOW)).toBe("unknown");
    expect(store.reserveFetch("other-run", "grant-1", NOW)).toBe("unknown");
  });

  // Regression: KEIKO-0379. `chargeFetch` runs AFTER a response body has been read, so a grant
  // whose byte budget has already been exhausted must refuse further reservations at the boundary
  // where outbound calls are gated. Without this, one extra hop per over-budget grant slips past
  // reserveFetch and only fails at charge time — real bytes leave the process first.
  it("refuses to reserve a fetch after the cumulative byte budget is exhausted", () => {
    const store = registry({ limits: { maxFetchesPerGrant: 10, maxTotalBytesPerGrant: 100 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", 100, NOW)).toBe("ok");
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("limit-reached");
    expect(store.activeGrants(RUN, NOW)[0]?.usedFetches).toBe(1);
  });

  // Regression: PR #3099 P1 follow-up. When an accepted charge leaves usedBytes below the
  // ceiling but the next charge exceeds the remainder (60 + 50 with a 100-byte cap), the reject
  // path must MARK the grant as terminally byte-exhausted — otherwise reserveFetch's byte gate
  // (usedBytes >= maxTotalBytes) never fires and additional real outbound hops slip through
  // until the fetch-count cap is reached.
  it("terminally exhausts the byte budget on a rejected over-limit charge", () => {
    const store = registry({ limits: { maxFetchesPerGrant: 10, maxTotalBytesPerGrant: 100 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.chargeFetch(RUN, "grant-1", 60, NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", 50, NOW)).toBe("limit-reached");
    // Before the fix, usedBytes stayed at 60 and reserveFetch admitted more hops. After: 100.
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(100);
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("limit-reached");
  });

  // Regression: PR #3099 R6 P1 (paired with the researchEgressPort finalizeResearch fix). A
  // single over-cap response should immediately saturate the grant's byte budget when charged
  // for maxTotalBytes — subsequent reserveFetch calls must fail closed. Verifies that a
  // single charge >= maxTotalBytes exhausts the grant in one step.
  it("saturates the byte budget on a single charge >= maxTotalBytes", () => {
    const store = registry({ limits: { maxFetchesPerGrant: 16, maxTotalBytesPerGrant: 100 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    // A single over-cap charge saturates the budget in one step.
    expect(store.chargeFetch(RUN, "grant-1", 999, NOW)).toBe("limit-reached");
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(100);
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("limit-reached");
  });

  // Regression: PR #3099 R7 P1 — saturateBytes is called by researchEgressPort's capped-read
  // failure path to make ONE strike exhaust the grant, since we cannot measure the exact bytes
  // read. Charging maxReadBytes (2 MB per response) against a 10 MB grant succeeds and admits
  // several more oversized responses before the fetch-count cap; saturating in one step
  // prevents that.
  it("saturateBytes exhausts the grant's byte budget in one call", () => {
    const store = registry({
      limits: { maxFetchesPerGrant: 16, maxTotalBytesPerGrant: 10_000_000 },
    });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("ok");
    store.saturateBytes(RUN, "grant-1");
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(10_000_000);
    expect(store.reserveFetch(RUN, "grant-1", NOW)).toBe("limit-reached");
  });

  it("saturateBytes on an unknown grant or run is a no-op", () => {
    const store = registry();
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);
    store.saturateBytes(RUN, "not-a-grant");
    store.saturateBytes("not-a-run", "grant-1");
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(0);
  });
});

describe("ResearchGrantRegistry byte-budget reconciliation", () => {
  it("does not touch the fetch-count budget when charging bytes", () => {
    const store = registry({ limits: { maxFetchesPerGrant: 1 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.chargeFetch(RUN, "grant-1", 1, NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", 1, NOW)).toBe("ok");
    expect(store.activeGrants(RUN, NOW)[0]?.usedFetches).toBe(0);
  });

  it("charges bytes until the cumulative byte budget is exhausted", () => {
    const store = registry({ limits: { maxTotalBytesPerGrant: 100, maxFetchesPerGrant: 10 } });
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.chargeFetch(RUN, "grant-1", 60, NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", 40, NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", 1, NOW)).toBe("limit-reached");
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(100);
  });

  it("clamps a negative or non-finite byte charge to zero", () => {
    const store = registry();
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);

    expect(store.chargeFetch(RUN, "grant-1", -5, NOW)).toBe("ok");
    expect(store.chargeFetch(RUN, "grant-1", Number.NaN, NOW)).toBe("ok");
    expect(store.activeGrants(RUN, NOW)[0]?.usedBytes).toBe(0);
  });

  it("returns expired after the grant elapses and unknown for a missing grant or run", () => {
    const store = registry();
    store.register(
      RUN,
      makeScope({ expiresAt: new Date(NOW + 5_000).toISOString() }),
      undefined,
      APPROVAL,
      NOW,
    );

    expect(store.chargeFetch(RUN, "grant-1", 1, NOW + 6_000)).toBe("expired");
    expect(store.chargeFetch(RUN, "absent-grant", 1, NOW)).toBe("unknown");
    expect(store.chargeFetch("other-run", "grant-1", 1, NOW)).toBe("unknown");
  });

  it("invalidateRun drops every grant for the run", () => {
    const store = registry();
    store.register(RUN, makeScope(), undefined, APPROVAL, NOW);
    store.invalidateRun(RUN);

    expect(store.activeGrants(RUN, NOW)).toHaveLength(0);
    expect(store.chargeFetch(RUN, "grant-1", 1, NOW)).toBe("unknown");
  });
});

describe("normalizeResearchHost", () => {
  it("lower-cases, strips IPv6 brackets, and strips a trailing dot", () => {
    expect(normalizeResearchHost("Example.COM.")).toBe("example.com");
    expect(normalizeResearchHost("[::1]")).toBe("::1");
    expect(normalizeResearchHost("  Docs.Example.Com ")).toBe("docs.example.com");
  });
});
