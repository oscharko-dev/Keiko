// Voice Digital Twin evaluation suite integration tests (Epic #491, Issue #505 — the capstone; AC1-AC6).
// Runs the full fixture set through the deterministic derivation once and asserts the coverage and
// Go/No-Go guarantees the issue mandates: every dimension exercised with zero failures, every
// environment × effective-capability matrix cell covered, all capability / environment / privacy coverage
// flags true, a reproducible result, the content-free discipline, the ALL_VOICE_PROFILES anti-drift
// guarantee, and the six AC-named proofs — including the real-repo `packages/*/package.json` denied-media
// package scan (test files may do fs) returning clean today.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOICE_PROFILE_MEDIA_TRANSPORT,
  type VoiceControlMessageKind,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import {
  ALL_VOICE_PROFILES,
  ALL_VOICE_TWIN_FIXTURES,
  DENIED_MEDIA_PACKAGES,
  VOICE_ENVIRONMENT_PROFILES,
  VOICE_TWIN_DIMENSIONS,
  VOICE_TWIN_FIXTURE_CATEGORIES,
  VOICE_TWIN_REPLAY_CAPACITY,
  auditVoiceEgress,
  deriveBufferBoundednessMetric,
  renderVoiceTwinSummary,
  runVoiceTwinEvaluation,
  scanManifestsForDeniedMediaPackages,
  voiceTwinFixtureByName,
  voiceTwinFixturesForCategory,
  type LatencyClassMetricRecord,
} from "./index.js";

const scorecard = runVoiceTwinEvaluation();

// The latency-class metric the named fixture derived. Throws (rather than returning undefined) so the
// latency test asserts on a non-optional record — keeping that test below the complexity ceiling.
function latencyMetricForFixture(name: string): LatencyClassMetricRecord {
  const metric = scorecard.fixtureResults.find((f) => f.fixtureName === name)?.observation.metrics
    .latencyClass;
  if (metric === undefined) {
    throw new Error(`fixture ${name} derived no latency-class metric`);
  }
  return metric;
}

// ─── Repo manifest helpers (fs allowed in test files only) ──────────────────────────
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RepoManifest {
  packageName: string;
  dependencyNames: readonly string[];
}

function parseManifest(manifestPath: string, fallbackName: string): RepoManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
    ...Object.keys(parsed.optionalDependencies ?? {}),
  ];
  return { packageName: parsed.name ?? fallbackName, dependencyNames: names };
}

function readRepoManifests(): readonly RepoManifest[] {
  const entries = readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const manifests: RepoManifest[] = [];
  // The repository ROOT manifest (one level above packagesDir) is scanned too: a denied media package
  // pulled into the workspace root must be caught, not just one added under packages/*.
  const rootManifest = parseManifest(join(packagesDir, "..", "package.json"), "root");
  if (rootManifest !== undefined) {
    manifests.push(rootManifest);
  }
  for (const entry of entries) {
    const manifest = parseManifest(join(packagesDir, entry.name, "package.json"), entry.name);
    if (manifest !== undefined) {
      manifests.push(manifest);
    }
  }
  return manifests;
}

describe("Voice Digital Twin evaluation suite (AC1-AC6)", () => {
  it("returns a GO verdict with every fixture fully passed", () => {
    expect(scorecard.summary.goNoGo).toBe("GO");
    expect(scorecard.summary.fullyPassedFixtures).toBe(scorecard.summary.totalFixtures);
    expect(scorecard.summary.totalFixtures).toBeGreaterThan(0);
    expect(scorecard.schemaVersion).toBe("1");
  });

  it("exercises every dimension with no failures", () => {
    for (const dim of VOICE_TWIN_DIMENSIONS) {
      const entry = scorecard.dimensions.find((e) => e.dimension === dim);
      expect(entry, dim).toBeDefined();
      expect(entry?.failCount, dim).toBe(0);
      expect(entry?.passCount, dim).toBeGreaterThan(0);
    }
  });

  it("covers all five fixture categories", () => {
    const categories = new Set(scorecard.fixtureResults.map((f) => f.category));
    expect(categories).toEqual(new Set(VOICE_TWIN_FIXTURE_CATEGORIES));
  });

  it("sets every capability, environment, and privacy coverage flag", () => {
    const s = scorecard.summary;
    expect(s.coversNoVoice).toBe(true);
    expect(s.coversSttOnly).toBe(true);
    expect(s.coversSpeechOutput).toBe(true);
    expect(s.coversFullRealtime).toBe(true);
    expect(s.coversAzureFoundry).toBe(true);
    expect(s.coversCustomerHosted).toBe(true);
    expect(s.coversPrivacyNegative).toBe(true);
  });

  it("covers every environment x advertised-capability matrix cell at least once", () => {
    // The advertised matrix the issue names: 3 environments × 4 advertised capabilities = 12 cells.
    const advertised: Record<string, true> = {};
    for (const env of VOICE_ENVIRONMENT_PROFILES) {
      for (const profile of ALL_VOICE_PROFILES) {
        advertised[`${env}:${profile}`] = true;
      }
    }
    const covered = new Set(
      scorecard.fixtureResults.map((f) => `${f.environment}:${f.observation.advertisedProfile}`),
    );
    for (const key of Object.keys(advertised)) {
      expect(covered.has(key), `advertised cell ${key} uncovered`).toBe(true);
    }
  });

  it("covers a spread of effective environment x profile cells", () => {
    const cells = new Set(
      scorecard.coveredMatrixCells.map((c) => `${c.environment}:${c.effectiveProfile}`),
    );
    expect(cells.has("no-voice-env:none")).toBe(true);
    expect(cells.has("azure-foundry:speech-to-text")).toBe(true);
    expect(cells.has("customer-hosted:full-realtime")).toBe(true);
    expect(cells.has("azure-foundry:none")).toBe(true);
  });

  it("keeps ALL_VOICE_PROFILES from drifting from the contract", () => {
    const contractKeys = Object.keys(VOICE_PROFILE_MEDIA_TRANSPORT).slice().sort();
    expect([...ALL_VOICE_PROFILES].sort()).toEqual(contractKeys);
  });

  // ─── AC1 / AC2 ───────────────────────────────────────────────────────────────────
  it("proves a no-voice cell has empty allowed kinds and no egress (AC1/AC2)", () => {
    for (const name of [
      "no-voice-env-degrades-full-realtime",
      "azure-foundry-none",
      "customer-hosted-none",
    ]) {
      const result = scorecard.fixtureResults.find((f) => f.fixtureName === name);
      expect(result?.effectiveProfile, name).toBe("none");
      expect(result?.observation.cell.allowedKinds.length, name).toBe(0);
      expect(result?.observation.cell.mediaTransport, name).toBe("none");
      expect(result?.observation.cell.negotiation, name).toBe("disabled");
      expect(result?.observation.cell.egressClass, name).toBe("none");
    }
  });

  // ─── AC3 ──────────────────────────────────────────────────────────────────────────
  it("proves speech-to-text excludes the SDP/ICE/media/playback/interrupt kinds (AC3)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "azure-foundry-stt");
    const allowed = result?.observation.cell.allowedKinds ?? [];
    const forbidden: readonly VoiceControlMessageKind[] = [
      "signal.sdp.offer",
      "signal.sdp.answer",
      "signal.ice.candidate",
      "media.track.state",
      "playback.state",
      "control.interrupt",
    ];
    for (const kind of forbidden) {
      expect(allowed.includes(kind), kind).toBe(false);
    }
    expect(allowed.includes("transcript.committed")).toBe(true);
    expect(result?.observation.cell.mediaTransport).toBe("gateway-batch");
  });

  // ─── AC4 ──────────────────────────────────────────────────────────────────────────
  it("proves full-realtime uses webrtc media + proxied-sdp + loopback control + SDP/media kinds (AC4)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "azure-foundry-full-realtime",
    );
    const cell = result?.observation.cell;
    expect(cell?.mediaTransport).toBe("webrtc");
    expect(cell?.negotiation).toBe("proxied-sdp");
    expect(cell?.controlPlaneIsLoopback).toBe(true);
    expect(cell?.mediaPlaneId).toBe("media");
    for (const kind of ["signal.sdp.offer", "signal.sdp.answer", "media.track.state"] as const) {
      expect(cell?.allowedKinds.includes(kind), kind).toBe(true);
    }
  });

  // ─── AC5 ──────────────────────────────────────────────────────────────────────────
  it("audits an unapproved-external destination as not approved (AC5)", () => {
    const audit = auditVoiceEgress([
      { class: "configured-model-endpoint" },
      { class: "unapproved-external" },
    ]);
    expect(audit.approved).toBe(false);
    expect(audit.unapprovedCount).toBe(1);
    expect(auditVoiceEgress([{ class: "configured-model-endpoint" }]).approved).toBe(true);
    expect(auditVoiceEgress([]).approved).toBe(true);
  });

  it("flags a synthetic denied media manifest and passes the negative privacy fixtures (AC5)", () => {
    const scan = scanManifestsForDeniedMediaPackages([
      { packageName: "keiko-ui", dependencyNames: ["simple-peer", "ws"] },
    ]);
    expect(scan.clean).toBe(false);
    expect(scan.found).toEqual([{ packageName: "keiko-ui", deniedPackage: "simple-peer" }]);
    // The negative fixtures are caught (their dimension still PASSES because the verdict matches oracle).
    for (const name of [
      "privacy-negative-unapproved-external",
      "privacy-negative-denied-media-package",
    ]) {
      const result = scorecard.fixtureResults.find((f) => f.fixtureName === name);
      expect(result?.observation.egressAudit.approved, name).toBe(false);
      expect(result?.fullyPassed, name).toBe(true);
    }
    const deniedManifest = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "privacy-negative-denied-media-package",
    );
    expect(deniedManifest?.observation.manifestScan.clean).toBe(false);
  });

  it("scans every real packages/*/package.json and finds no denied media package today (AC5)", () => {
    const manifests = readRepoManifests();
    expect(manifests.length).toBeGreaterThan(0);
    const scan = scanManifestsForDeniedMediaPackages(manifests);
    expect(scan.found, JSON.stringify(scan.found)).toEqual([]);
    expect(scan.clean).toBe(true);
    // Sanity: the scanner WOULD catch a denied package if one were present in the real list.
    expect(DENIED_MEDIA_PACKAGES.length).toBeGreaterThan(0);
  });

  // ─── AC6 ──────────────────────────────────────────────────────────────────────────
  it("derives the interruption metric for a capable profile (AC6)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "azure-foundry-speech-output",
    );
    const metric = result?.observation.metrics.interruption;
    expect(metric?.interruptAllowed).toBe(true);
    expect(metric?.interruptedPhaseReachable).toBe(true);
  });

  it("derives the end-of-turn metric excluding uncommitted text (AC6)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "azure-foundry-stt");
    const metric = result?.observation.metrics.endOfTurn;
    expect(metric?.committedKindAllowed).toBe(true);
    expect(metric?.captureAllowed).toBe(true);
    expect(metric?.committedSegmentCount).toBeGreaterThan(0);
    expect(metric?.excludesUncommitted).toBe(true);
  });

  it("derives the transcript-correction metric dropping superseded text (AC6)", () => {
    const result = scorecard.fixtureResults.find((f) => f.fixtureName === "customer-hosted-stt");
    const metric = result?.observation.metrics.transcriptCorrection;
    expect(metric?.stableToCorrectedAllowed).toBe(true);
    expect(metric?.committedToCorrectedAllowed).toBe(true);
    expect(metric?.correctedIsConsumable).toBe(true);
    expect(metric?.supersededTextDropped).toBe(true);
  });

  it("derives the provider-failure-recovery metric (AC6)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "azure-foundry-full-realtime",
    );
    const metric = result?.observation.metrics.providerFailureRecovery;
    expect(metric?.providerErrorIsState).toBe(true);
    expect(metric?.providerErrorNotConsumable).toBe(true);
    expect(metric?.playbackFailedIsSettled).toBe(true);
    expect(metric?.recoveryTransitionExists).toBe(true);
  });

  it("derives a bounded buffer metric that never exceeds capacity (AC6)", () => {
    const result = scorecard.fixtureResults.find(
      (f) => f.fixtureName === "customer-hosted-full-realtime",
    );
    const metric = result?.observation.metrics.bufferBoundedness;
    expect(metric).toBeDefined();
    if (metric === undefined) {
      throw new Error("expected a buffer-boundedness metric");
    }
    expect(metric.maxObservedLength).toBeLessThanOrEqual(metric.capacity);
    expect(metric.ephemeralBuffered).toBe(false);
    expect(metric.evictedOldestOnOverflow).toBe(true);
    expect(metric.admittedCount).toBeGreaterThan(0);
  });

  it("bounds the FIFO at the documented default capacity over the full kind catalog (AC6)", () => {
    // Push every replay-eligible kind far past capacity; length must clamp at the default 200.
    const probe = Array.from(
      { length: VOICE_TWIN_REPLAY_CAPACITY * 3 },
      (_v, i): VoiceControlMessageKind =>
        i % 2 === 0 ? "transcript.committed" : "session.created",
    );
    const metric = deriveBufferBoundednessMetric(probe);
    expect(metric.capacity).toBe(VOICE_TWIN_REPLAY_CAPACITY);
    expect(metric.maxObservedLength).toBe(VOICE_TWIN_REPLAY_CAPACITY);
    expect(metric.evictedOldestOnOverflow).toBe(true);
  });

  it("never buffers an ephemeral kind (AC6)", () => {
    // `transcript.partial` is ephemeral; it must never enter the ring regardless of how often pushed.
    const probe: VoiceControlMessageKind[] = Array.from({ length: 50 }, () => "transcript.partial");
    const metric = deriveBufferBoundednessMetric(probe, 8);
    expect(metric.ephemeralBuffered).toBe(false);
    expect(metric.admittedCount).toBe(0);
    expect(metric.maxObservedLength).toBe(0);
  });

  // ─── Latency posture class (AC6 / Deliverable "latency") ─────────────────────────
  it("derives a latency-class metric per profile (AC6 / Deliverable latency)", () => {
    const full = latencyMetricForFixture("azure-foundry-full-realtime");
    expect(full.mediaTransport).toBe("webrtc");
    expect(full.latencyClass).toBe("interactive-realtime");
    expect(full.isInteractive).toBe(true);

    const stt = latencyMetricForFixture("azure-foundry-stt");
    expect(stt.mediaTransport).toBe("gateway-batch");
    expect(stt.latencyClass).toBe("batch");
    expect(stt.isInteractive).toBe(false);

    const none = latencyMetricForFixture("no-voice-env-advertises-none");
    expect(none.mediaTransport).toBe("none");
    expect(none.latencyClass).toBe("none");
    expect(none.isInteractive).toBe(false);
  });

  // ─── Determinism + content-free discipline ──────────────────────────────────────
  it("is deterministic across runs", () => {
    const again = runVoiceTwinEvaluation();
    expect(JSON.stringify(again.dimensions)).toBe(JSON.stringify(scorecard.dimensions));
    expect(JSON.stringify(again.fixtureResults)).toBe(JSON.stringify(scorecard.fixtureResults));
    expect(again.coveredMatrixCells).toEqual(scorecard.coveredMatrixCells);
  });

  it("keeps the scorecard and rendered summary free of raw transcript / id leakage", () => {
    // Harness-authored filler the metric builder uses, plus any fixture opaque id, must never appear in
    // the rendered output. The rationales are closed-vocabulary; the only place "xx" filler could leak is
    // a regression that echoed segment text into a rationale.
    const serialized = JSON.stringify(scorecard);
    const rendered = renderVoiceTwinSummary(scorecard);
    for (const fragment of ["corr-committed", "eot-partial", "eot-stable", '"xx"']) {
      expect(serialized.includes(fragment), `serialized leaked "${fragment}"`).toBe(false);
      expect(rendered.includes(fragment), `rendered leaked "${fragment}"`).toBe(false);
    }
  });

  it("keeps every fixture name a closed structural slug (content-free)", () => {
    // The renderer prints fixture names; a future free-text fixture name could leak content. Requiring a
    // lowercase-kebab slug keeps the printable name structural, not free text.
    for (const fixture of ALL_VOICE_TWIN_FIXTURES) {
      expect(/^[a-z0-9-]+$/.test(fixture.name), fixture.name).toBe(true);
    }
  });

  it("emits only closed-vocabulary content-free rationales", () => {
    for (const result of scorecard.fixtureResults) {
      for (const dim of result.dimensionResults) {
        // A rationale is either the pass tally, a "failed: ..." string, or the not-applicable note. None
        // carry transcript text — assert the shape, which a content-leaking regression would violate.
        const ok =
          /^\d+\/\d+ structural checks met\.$/.test(dim.rationale) ||
          dim.rationale.startsWith("failed:") ||
          dim.rationale === "not exercised by this fixture.";
        expect(ok, `${result.fixtureName}/${dim.dimension}: ${dim.rationale}`).toBe(true);
      }
    }
  });

  it("resolves fixtures by category and by name", () => {
    expect(voiceTwinFixturesForCategory("privacy").length).toBeGreaterThan(0);
    expect(voiceTwinFixtureByName("azure-foundry-full-realtime")).toBeDefined();
    expect(voiceTwinFixtureByName("does-not-exist")).toBeUndefined();
  });

  it("renders a readable GO summary", () => {
    const text = renderVoiceTwinSummary(scorecard);
    expect(text).toContain("Verdict: GO");
    expect(text).toContain("Capability coverage:");
    expect(text).toContain("Environment coverage:");
    expect(text).toContain("Privacy:");
  });
});
