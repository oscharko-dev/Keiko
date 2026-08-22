import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_STRATIFIED_SITES,
  SERVER_TOP_LEVEL_SITE_ID,
  SITE_PROBES,
  main,
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

// ─── main() / runProbe / runServerTopLevelSite wiring (#2902 audit follow-up) ──────────────────
//
// The suite above calls `probe.run()` / `probe.assertShape()` directly, which exercises every site
// probe's body but never the private `runProbe` wrapper around them (the try/catch around `run()`,
// the `records.length !== 1` guard, the try/catch around `assertShape`, and the `exercised.push` on
// success), nor `runServerTopLevelSite`'s own `exercised.push`, nor `main()`'s loop and its "fewer
// than MIN_STRATIFIED_SITES" guard. `runProbe` and `runServerTopLevelSite` are not exported, and
// `main()` — the gate's only exported entry point — is the sole path that reaches them. `main()`
// binds a real loopback HTTP server the same way `dev-runner.test.mjs` and
// `dev-bff-shutdown.test.mjs` already do in this exact `scripts/__tests__/` directory (an
// OS-assigned 127.0.0.1 port, closed before the call returns), so calling it in-process here stays
// inside this repo's existing hermetic-test convention — no external network, no shared mutable
// state, no wall-clock waits. `fail()` calls `process.exit(1)` directly, so `process.exit` is
// stubbed to throw and keep the failure paths assertable in-band, matching the convention in
// `release-script-lcov-mapping.test.mjs` and `verify-portable-runtime-signing-args.test.mjs`.
describe("check-error-observability gate — runProbe / runServerTopLevelSite / main wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("main() exercises every stratified site end to end and reports PASS", async () => {
    // FAILS BEFORE / PASSES AFTER: before this test nothing in this suite ever called `main()`, so
    // a regression that broke `runServerTopLevelSite`'s or `runProbe`'s success bookkeeping (e.g.
    // dropping either `exercised.push`) would still leave this whole suite green.
    const originalExitCode = process.exitCode;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    try {
      await main();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      const passMessage = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(passMessage).toContain("check:error-observability PASS");
      expect(passMessage).toContain(SERVER_TOP_LEVEL_SITE_ID);
      for (const probe of SITE_PROBES) {
        expect(passMessage).toContain(probe.id);
      }
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  const RUN_PROBE_FAILURE_CASES = [
    {
      id: "gate-test.run-throws",
      label: "probe.run() throws",
      expectedFragment: "threw while exercising",
      makeProbe: (id) => ({
        id,
        async run() {
          throw new Error("gate-test-run-failure");
        },
        assertShape() {
          throw new Error("gate-test: assertShape must not run after a run() failure");
        },
      }),
    },
    {
      id: "gate-test.wrong-record-count",
      label: "probe.run() resolves with other than exactly one record",
      expectedFragment: "expected exactly 1 record, got 0",
      makeProbe: (id) => ({
        id,
        async run() {
          return [];
        },
        assertShape() {
          throw new Error("gate-test: assertShape must not run after a record-count failure");
        },
      }),
    },
    {
      id: "gate-test.assert-shape-throws",
      label: "probe.assertShape() throws",
      expectedFragment: "shape assertion failed",
      makeProbe: (id) => ({
        id,
        async run() {
          return [{ marker: "gate-test-record" }];
        },
        assertShape() {
          throw new Error("gate-test-shape-failure");
        },
      }),
    },
  ];

  for (const testCase of RUN_PROBE_FAILURE_CASES) {
    it(`runProbe: ${testCase.label} fails the gate via fail() without crediting the site`, async () => {
      // FAILS BEFORE / PASSES AFTER: a regression that widened `runProbe`'s try/catch (or dropped
      // the record-count/assertShape checks) would let a broken site pass silently instead of
      // failing the gate with this exact site id and reason.
      const brokenProbe = testCase.makeProbe(testCase.id);
      const originalExitCode = process.exitCode;
      SITE_PROBES.unshift(brokenProbe);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${String(code)})`);
      });
      try {
        await expect(main()).rejects.toThrow("process.exit(1)");
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [message] = errorSpy.mock.calls[0] ?? [];
        expect(String(message)).toContain(`site '${testCase.id}'`);
        expect(String(message)).toContain(testCase.expectedFragment);
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        SITE_PROBES.shift();
        process.exitCode = originalExitCode;
      }
    });
  }

  it("main(): fewer than the minimum stratified sites trips the sample-size guard", async () => {
    // FAILS BEFORE / PASSES AFTER: before this test, the "only N sites were exercised" guard —
    // main()'s own defence against a shrunk SITE_PROBES roster — had never actually been tripped;
    // a regression that miscounted `exercised` or dropped the guard entirely would go unnoticed.
    const originalProbes = SITE_PROBES.splice(0, SITE_PROBES.length);
    const keptProbes = originalProbes.slice(0, 2);
    SITE_PROBES.push(...keptProbes);
    const expectedExercised = keptProbes.length + 1; // +1 for the always-run HTTP site
    const originalExitCode = process.exitCode;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    try {
      await expect(main()).rejects.toThrow("process.exit(1)");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message] = errorSpy.mock.calls[0] ?? [];
      expect(String(message)).toContain(
        `only ${String(expectedExercised)} distinct sites were exercised, need >= ` +
          `${String(MIN_STRATIFIED_SITES)}`,
      );
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      SITE_PROBES.length = 0;
      SITE_PROBES.push(...originalProbes);
      process.exitCode = originalExitCode;
    }
  });
});
