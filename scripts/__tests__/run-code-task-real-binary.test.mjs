import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildJourneyReport,
  classifyLsofNetworkNames,
  createJourneyContext,
  createNetworkObserver,
  ensureMacTarget,
  governedExecutable,
  missingRealBinaryEvidence,
  readGatewayObservation,
  processIdsForExecutable,
  readMaterializedLimits,
  realBinaryEvidenceComplete,
} from "../run-code-task-real-binary.mjs";

/**
 * Whether `candidate` really lives under `root`, separator-aware.
 *
 * `candidate.startsWith(root)` accepts `${root}-evil/state`, a SIBLING directory — so a state path
 * assembled by concatenation instead of `join` would satisfy a prefix pin while escaping the
 * resolved temp root the helper exists to stay inside.
 */
function containedIn(root, candidate) {
  const offset = relative(root, candidate);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

describe("#2483 real-binary observation helpers", () => {
  it("rejects the Windows dev-lane target before its macOS-only real-binary journey", () => {
    expect(() => ensureMacTarget("windows-x64")).toThrow("requires macOS arm64 or x64");
    expect(ensureMacTarget("macos-arm64")).toBe("macos-arm64");
  });

  it("classifies connections without returning a persisted endpoint projection", () => {
    const observations = classifyLsofNetworkNames(
      [
        "p200",
        "n127.0.0.1:52340->127.0.0.1:32483",
        "n[::1]:52341->[::1]:32483",
        "n[::ffff:127.0.0.1]:52342->[::ffff:127.0.0.1]:32483",
        "n127.0.0.1:32483",
        "n10.0.0.2:52343->203.0.113.8:443",
      ].join("\n"),
    );

    expect(observations.map(({ scope }) => scope)).toEqual([
      "loopback",
      "loopback",
      "loopback",
      "external",
    ]);
  });

  it("matches only command lines led by the exact staged executable", () => {
    const executable = "/repo/.portable-sidecar-payloads/macos-arm64/opencode/payload/bin/opencode";
    const processList = [
      `  41 ${executable} serve --hostname 127.0.0.1`,
      `  42 node observer.js ${executable}`,
      "  43 /usr/bin/opencode serve",
      `  44 ${executable}-shadow serve`,
    ].join("\n");

    expect(processIdsForExecutable(processList, executable)).toEqual([41]);
  });

  it("reads only the content-free model limit pair from a materialized child config", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-2483-limits-"));
    const configDir = join(
      stateDir,
      "bff-state",
      "ui-db",
      "coding-runtime",
      "opencode",
      "run-1",
      "config",
      "opencode",
    );
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "opencode.json"),
        JSON.stringify({
          provider: {
            "keiko-runtime": {
              models: { coding: { limit: { context: 32_768, output: 4_096 } } },
            },
          },
          prompt: "must-not-be-projected",
        }),
      );

      expect(readMaterializedLimits(stateDir)).toEqual([{ context: 32_768, output: 4_096 }]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("requires every real-binary acceptance observation before reporting success", () => {
    const complete = {
      journey: { exitCode: 0 },
      limits: {
        materializedChildLimits: [{ context: 32_768, output: 4_096 }],
        gatewayRequestCount: 1,
        observedGatewayOutputTokenLimits: [4_096],
      },
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
    };

    expect(realBinaryEvidenceComplete(complete)).toBe(true);
    expect(
      realBinaryEvidenceComplete({
        ...complete,
        limits: { ...complete.limits, materializedChildLimits: [] },
      }),
    ).toBe(false);
  });

  it("names every missing observation so a failed run explains itself", () => {
    const complete = {
      journey: { exitCode: 0 },
      limits: {
        materializedChildLimits: [{ context: 32_768, output: 4_096 }],
        gatewayRequestCount: 1,
        observedGatewayOutputTokenLimits: [4_096],
      },
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
    };

    expect(missingRealBinaryEvidence(complete)).toEqual([]);
    expect(missingRealBinaryEvidence({ ...complete, journey: { exitCode: 1 } })).toEqual([
      "journey exit code 1",
    ]);
    expect(
      missingRealBinaryEvidence({
        ...complete,
        limits: { ...complete.limits, gatewayRequestCount: 0 },
      }),
    ).toEqual(["no gateway request was observed"]);
    expect(
      missingRealBinaryEvidence({
        ...complete,
        limits: { ...complete.limits, observedGatewayOutputTokenLimits: [8_192] },
      }),
    ).toEqual(["no gateway request carried the effective output limit 4096"]);
    expect(
      missingRealBinaryEvidence({
        ...complete,
        missingPayload: { passed: false, unavailableReason: "probe-failed" },
      }),
    ).toEqual(["payload-missing probe did not pass (reason probe-failed)"]);
    // A probe that "passed" while reporting a different reason is the subtler failure: readiness
    // failed closed for something other than the missing payload, so the negative proof is not the
    // one the evidence claims.
    expect(
      missingRealBinaryEvidence({
        ...complete,
        missingPayload: { passed: true, unavailableReason: "runtime-unqualified" },
      }),
    ).toEqual(["payload-missing probe reported runtime-unqualified"]);
  });

  it("reports every gap at once rather than only the first", () => {
    const gaps = missingRealBinaryEvidence({
      journey: { exitCode: 1 },
      limits: {
        materializedChildLimits: [],
        gatewayRequestCount: 0,
        observedGatewayOutputTokenLimits: [],
      },
      missingPayload: undefined,
    });

    expect(gaps).toHaveLength(5);
  });

  it("resolves a governed executable only from a fixed absolute path", () => {
    // A bare name resolved through PATH could be shadowed on a developer or CI machine, and the
    // shadowed binary would silently decide what the egress evidence claims.
    expect(governedExecutable(["/definitely/missing", "/bin/sh"], "sh")).toBe("/bin/sh");
    expect(() => governedExecutable(["/definitely/missing"], "nope")).toThrow(
      /nope not found at a governed absolute path/u,
    );
  });

  it("reports a content-free egress projection with no endpoint or content fields", () => {
    const observer = createNetworkObserver("/nonexistent/opencode");
    const report = observer.report();

    expect(report).toMatchObject({
      method: "sampled-established-tcp-sockets",
      sampleCount: 0,
      observedProcessCount: 0,
      socketObservationCount: 0,
      distinctLoopbackConnectionCount: 0,
      distinctExternalConnectionCount: 0,
      truncated: false,
      contentFieldsRecorded: false,
      endpointFieldsRecorded: false,
    });
    // Every reported value is a count, a method name, or a boolean flag — never an endpoint,
    // a host, or a connection hash.
    for (const [key, value] of Object.entries(report)) {
      const shape = key === "method" ? "string" : typeof value === "boolean" ? "boolean" : "number";
      expect(typeof value).toBe(shape);
    }
  });

  it("treats a missing or malformed gateway observation as zero rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-2483-"));
    const absent = join(dir, "absent.json");
    const partial = join(dir, "partial.json");
    writeFileSync(
      partial,
      JSON.stringify({ requestCount: 3, outputTokenLimits: [4096, "x", 8192] }),
    );

    expect(readGatewayObservation(absent)).toEqual({ requestCount: 0, outputTokenLimits: [] });
    // Non-integer entries are dropped rather than admitted into the evidence.
    expect(readGatewayObservation(partial)).toEqual({
      requestCount: 3,
      outputTokenLimits: [4096, 8192],
    });
  });

  it("derives a run-scoped journey context without leaking it into the repository", () => {
    const context = createJourneyContext("macos-arm64");

    expect(context.executable).toContain("macos-arm64");
    expect(context.executable.endsWith("/payload/bin/opencode")).toBe(true);
    // State and probe directories live outside the checkout so a run cannot dirty the tree, and
    // under the RESOLVED temp root: this journey forces these paths into KEIKO_E2E_STATE_DIR, which
    // e2eStateDir returns verbatim, so an unresolved one would route the whole lane around the
    // symlink resolution the helper exists to perform (#2955 follow-up). The pin moved from
    // `tmpdir()` to its realpath — the same invariant, one step stricter.
    const tempRoot = realpathSync(tmpdir());
    for (const statePath of [context.stateDir, context.probeState]) {
      expect(containedIn(tempRoot, statePath)).toBe(true);
    }
    // The negative control a prefix test cannot express: a SIBLING whose name starts with the temp
    // root passes `startsWith` and is not inside it. Without this, a state path built by string
    // concatenation rather than `join` would satisfy the pin.
    expect(containedIn(tempRoot, `${tempRoot}-evil/state`)).toBe(false);
    expect(context.stateDir).not.toBe(context.probeState);
  });

  it("assembles an evidence report that carries counts and outcomes only", () => {
    const report = buildJourneyReport({
      exitCode: 0,
      gateway: { requestCount: 7, outputTokenLimits: [4096] },
      limits: [{ context: 32_768, output: 4_096 }],
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
      observer: createNetworkObserver("/nonexistent/opencode"),
      target: "macos-arm64",
      wallClockMs: 41_128,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      issue: 2483,
      evidenceClass: "functional-not-platform-qualified",
      runtime: { name: "opencode-compatible", version: "1.17.17", target: "macos-arm64" },
      journey: { exitCode: 0, wallClockMs: 41_128 },
    });
    expect(missingRealBinaryEvidence(report)).toEqual([]);
    // The whole report must stay free of paths, endpoints, and page or prompt text.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain("http");
  });
});
