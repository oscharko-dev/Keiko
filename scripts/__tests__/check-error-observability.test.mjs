import { describe, expect, it } from "vitest";

import {
  MIN_STRATIFIED_SITES,
  SERVER_TOP_LEVEL_SITE_ID,
  SITE_PROBES,
} from "../check-error-observability.mjs";

// FAILS BEFORE / PASSES AFTER (#2902 audit): before this widening the gate exercised and asserted
// against exactly ONE call site (`server.top-level-catch`) — it exported neither `SITE_PROBES` nor
// `MIN_STRATIFIED_SITES`, so this import itself would fail (`SITE_PROBES` undefined, the length
// assertion below throwing a TypeError) against the pre-widening script. This file counts the
// exercised sites PROGRAMMATICALLY (array length / Set size), not by eyeballing the diff, and then
// actually RUNS every non-HTTP probe end to end against the real built dist, asserting the shape of
// the diagnostic/log record each one produces — the site-1 HTTP round trip (opaque 500, header
// echo, no-leak, UI-id honoured) is covered by running `node scripts/check-error-observability.mjs`
// directly (see docs/qa/local-gates.md and the item's own verification instructions), not
// re-driven here, so this suite stays fast and does not bind a loopback port.
describe("check-error-observability gate — stratified site sample", () => {
  it(`exercises at least ${String(MIN_STRATIFIED_SITES)} distinct call sites, counted programmatically`, () => {
    const totalSites = SITE_PROBES.length + 1; // +1 for the HTTP-driven server.top-level-catch site
    expect(totalSites).toBeGreaterThanOrEqual(MIN_STRATIFIED_SITES);
  });

  it("every exercised site id — including the HTTP site — is distinct", () => {
    const ids = [SERVER_TOP_LEVEL_SITE_ID, ...SITE_PROBES.map((probe) => probe.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names one site per package/lane this epic touched", () => {
    const ids = SITE_PROBES.map((probe) => probe.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "sink.terminal-event-tee",
        "voice-realtime.negotiation-failure",
        "memory-consolidation.log-port.sink-failed",
        "memory-consolidation.summary-fallback",
        "security.macos-keychain.fallback",
      ]),
    );
    expect(ids.filter((id) => id.startsWith("memory-handlers.")).length).toBeGreaterThanOrEqual(2);
  });

  for (const probe of SITE_PROBES) {
    it(`site '${probe.id}' exercises the real dist call site and produces a shape-correct record`, async () => {
      // FAILS BEFORE / PASSES AFTER, per site: before this widening, none of these call sites were
      // reachable from this gate at all — a regression that reintroduces a bare `catch {}` at this
      // exact site makes `run()` return zero records (asserted below) instead of silently passing.
      const records = await probe.run();
      expect(records).toHaveLength(1);
      expect(() => {
        probe.assertShape(records[0]);
      }).not.toThrow();
    });
  }
});
