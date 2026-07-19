import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyLsofNetworkNames,
  missingRealBinaryEvidence,
  processIdsForExecutable,
  readMaterializedLimits,
  realBinaryEvidenceComplete,
} from "../run-code-task-real-binary.mjs";

describe("#2483 real-binary observation helpers", () => {
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
});
