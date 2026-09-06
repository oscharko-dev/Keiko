import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRealBinaryScenarioArtifact,
  buildJourneyReport,
  classifyLsofNetworkNames,
  createJourneyContext,
  createNetworkObserver,
  ensureMacTarget,
  governedExecutable,
  missingRealBinaryEvidence,
  readGatewayObservation,
  readH1SearchEvidence,
  readManagedCatalogEvidence,
  retainJourneyActivityLog,
  processIdsForExecutable,
  readMaterializedLimits,
  realBinaryEvidenceComplete,
  writeManagedCatalogObservation,
  writeRealBinaryQualificationEvidence,
} from "../run-code-task-real-binary.mjs";
import { readReceipts } from "../check-coding-issue-journey-evidence.mjs";

const H1_SEARCH = {
  schemaVersion: 1,
  toolCallId: "h1-real-binary-search",
  hitCount: 1,
  pathDigest: "a".repeat(64),
  snippetDigest: "b".repeat(64),
  startLine: 1,
  endLine: 1,
  readTargetDerivedFromResult: true,
};
const ACTIVITY_LOG = { status: "retained", sha256: "c".repeat(64) };
const SOURCE_HEAD = "1".repeat(40);
const CATALOG_BINDING = {
  catalogRevision: "d".repeat(64),
  profile: { id: "opencode", version: 1 },
  projectionDigest: "e".repeat(64),
  handlerSetDigest: "f".repeat(64),
};
const MANAGED_CATALOG = {
  binding: CATALOG_BINDING,
  correlationId: "real-binary-correlation",
  settlementCount: 3,
  proof: {
    kind: "managed-search-read",
    searchSettled: true,
    boundedReadSettled: true,
    causalHandoff: true,
  },
};

function completeQualificationReport() {
  return buildJourneyReport({
    sourceHead: SOURCE_HEAD,
    exitCode: 0,
    gateway: {
      requestCount: 2,
      outputTokenLimits: [4_096],
      catalogBindingRequestCount: 2,
    },
    limits: [{ context: 32_768, output: 4_096 }],
    missingPayload: { passed: true, unavailableReason: "payload-missing" },
    h1Search: H1_SEARCH,
    managedCatalog: MANAGED_CATALOG,
    activityLog: ACTIVITY_LOG,
    observer: createNetworkObserver("/nonexistent/opencode"),
    target: "macos-arm64",
    wallClockMs: 41_128,
    completedAt: "2026-09-06T11:30:00.000Z",
  });
}

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
  it("retains the existing activity log before deleting ephemeral journey state", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-real-binary-activity-"));
    const context = {
      stateDir: join(root, "state"),
      evidencePath: join(root, "out", "report.json"),
    };
    try {
      expect(retainJourneyActivityLog(context)).toEqual({ status: "missing" });
      const source = join(context.stateDir, "activity", "logs", "server.log");
      mkdirSync(dirname(source), { recursive: true });
      const line = '{"op":"coding-runtime.run-started","correlationId":"run-fixture"}\n';
      writeFileSync(source, line);
      expect(retainJourneyActivityLog(context)).toMatchObject({ status: "retained" });
      rmSync(context.stateDir, { recursive: true });
      expect(readFileSync(`${context.evidencePath}.activity.jsonl`, "utf8")).toBe(line);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains only validated body-free H1 consumption facts before state cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-h1-real-binary-receipt-"));
    const path = join(root, "h1-result-consumption.json");
    try {
      expect(readH1SearchEvidence(root)).toBeUndefined();
      writeFileSync(path, JSON.stringify({ ...H1_SEARCH, rawContent: "never retained" }));
      expect(readH1SearchEvidence(root)).toEqual(H1_SEARCH);
      writeFileSync(path, JSON.stringify({ ...H1_SEARCH, pathDigest: "/raw/path" }));
      expect(readH1SearchEvidence(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
      sourceHead: SOURCE_HEAD,
      journey: { exitCode: 0 },
      limits: {
        materializedChildLimits: [{ context: 32_768, output: 4_096 }],
        gatewayRequestCount: 1,
        gatewayCatalogBindingRequestCount: 1,
        observedGatewayOutputTokenLimits: [4_096],
      },
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
      h1Search: H1_SEARCH,
      managedCatalog: MANAGED_CATALOG,
      activityLog: ACTIVITY_LOG,
    };

    expect(realBinaryEvidenceComplete(complete)).toBe(true);
    expect(realBinaryEvidenceComplete({ ...complete, h1Search: undefined })).toBe(false);
    expect(
      realBinaryEvidenceComplete({
        ...complete,
        limits: { ...complete.limits, materializedChildLimits: [] },
      }),
    ).toBe(false);
  });

  it("projects the complete real-binary producer report into closed qualification evidence", () => {
    const artifact = buildRealBinaryScenarioArtifact(completeQualificationReport());

    expect(artifact).toMatchObject({
      scenarioId: "real-binary-lane",
      evidenceClass: "production-functional",
      sourceCommitSha: SOURCE_HEAD,
      platformTarget: "macos-arm64",
      result: "passed",
      runtime: { name: "opencode-compatible", version: "1.17.17" },
      run: {
        correlationId: MANAGED_CATALOG.correlationId,
        activityLogSha256: ACTIVITY_LOG.sha256,
      },
      limits: {
        contextWindow: 32_768,
        outputTokens: 4_096,
        gatewayRequestCount: 2,
        gatewayCatalogBindingRequestCount: 2,
      },
      h1Search: {
        toolCallId: H1_SEARCH.toolCallId,
        hitCount: 1,
        pathDigest: H1_SEARCH.pathDigest,
        snippetDigest: H1_SEARCH.snippetDigest,
        startLine: 1,
        endLine: 1,
        readTargetDerivedFromResult: true,
      },
      managedCatalog: {
        binding: CATALOG_BINDING,
        settlementCount: 3,
        proof: MANAGED_CATALOG.proof,
      },
    });
    expect(JSON.stringify(artifact)).not.toMatch(/raw|path\/|endpoint|prompt|response/iu);
  });

  it("checks the complete-run predicate before projecting report fields", () => {
    const incomplete = {
      ...completeQualificationReport(),
      sourceHead: "main",
      get runtime() {
        throw new Error("projection must not run");
      },
    };

    expect(() => buildRealBinaryScenarioArtifact(incomplete)).toThrow(
      "real-binary qualification evidence is incomplete",
    );
  });

  it("writes an optional production-functional receipt that the shared reader validates", () => {
    const receiptsDir = mkdtempSync(join(tmpdir(), "keiko-real-binary-receipt-"));
    try {
      expect(
        writeRealBinaryQualificationEvidence(completeQualificationReport(), {
          KEIKO_CODE_TASK_QUALIFICATION_RECEIPTS_DIR: receiptsDir,
        }),
      ).toBe(true);
      const receipt = readReceipts(receiptsDir).get("real-binary-lane");
      expect(receipt).toMatchObject({
        scenarioId: "real-binary-lane",
        commitSha: SOURCE_HEAD,
        platform: "macos-arm64",
        testStatus: "passed",
        recordedAt: "2026-09-06T11:30:00.000Z",
        provenance: "production-functional",
        artifactValidationErrors: [],
      });
    } finally {
      rmSync(receiptsDir, { recursive: true, force: true });
    }
  });

  it("keeps ordinary runs unchanged and refuses incomplete configured qualification", () => {
    const receiptsDir = mkdtempSync(join(tmpdir(), "keiko-real-binary-receipt-"));
    const incomplete = { ...completeQualificationReport(), h1Search: undefined };
    try {
      expect(writeRealBinaryQualificationEvidence(incomplete, {})).toBe(false);
      expect(readdirSync(receiptsDir)).toEqual([]);
      expect(() =>
        writeRealBinaryQualificationEvidence(incomplete, {
          KEIKO_CODE_TASK_QUALIFICATION_RECEIPTS_DIR: receiptsDir,
        }),
      ).toThrow("real-binary qualification evidence is incomplete");
      expect(readdirSync(receiptsDir)).toEqual([]);
    } finally {
      rmSync(receiptsDir, { recursive: true, force: true });
    }
  });

  it("refuses a qualification receipt directory writable by another local user", () => {
    const receiptsDir = mkdtempSync(join(tmpdir(), "keiko-real-binary-receipt-"));
    try {
      chmodSync(receiptsDir, 0o755);
      expect(() =>
        writeRealBinaryQualificationEvidence(completeQualificationReport(), {
          KEIKO_CODE_TASK_QUALIFICATION_RECEIPTS_DIR: receiptsDir,
        }),
      ).toThrow("qualification receipts directory must be a private real directory");
      expect(readdirSync(receiptsDir)).toEqual([]);
    } finally {
      rmSync(receiptsDir, { recursive: true, force: true });
    }
  });

  it("names every missing observation so a failed run explains itself", () => {
    const complete = {
      sourceHead: SOURCE_HEAD,
      journey: { exitCode: 0 },
      limits: {
        materializedChildLimits: [{ context: 32_768, output: 4_096 }],
        gatewayRequestCount: 1,
        gatewayCatalogBindingRequestCount: 1,
        observedGatewayOutputTokenLimits: [4_096],
      },
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
      h1Search: H1_SEARCH,
      managedCatalog: MANAGED_CATALOG,
      activityLog: ACTIVITY_LOG,
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
    ).toEqual([
      "no gateway request was observed",
      "not every gateway request carried the stable productive catalog binding",
    ]);
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

  it("writes managed qualification only after the whole real-binary journey is complete", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-managed-observation-"));
    const complete = {
      sourceHead: SOURCE_HEAD,
      journey: { exitCode: 0 },
      limits: {
        materializedChildLimits: [{ context: 32_768, output: 4_096 }],
        gatewayRequestCount: 1,
        gatewayCatalogBindingRequestCount: 1,
        observedGatewayOutputTokenLimits: [4_096],
      },
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
      h1Search: H1_SEARCH,
      managedCatalog: MANAGED_CATALOG,
      activityLog: ACTIVITY_LOG,
    };
    process.env.KEIKO_TOOL_CATALOG_QUALIFICATION_DIR = directory;
    process.env.KEIKO_TOOL_CATALOG_QUALIFICATION_HEAD = "2".repeat(40);
    try {
      expect(writeManagedCatalogObservation({ ...complete, h1Search: undefined })).toBe(false);
      expect(writeManagedCatalogObservation(complete)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
      process.env.KEIKO_TOOL_CATALOG_QUALIFICATION_HEAD = SOURCE_HEAD;
      expect(writeManagedCatalogObservation(complete)).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(directory, "managed-opencode.managed-opencode.observation.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        component: "managed-opencode",
        binding: CATALOG_BINDING,
        settlementCount: 3,
        proof: MANAGED_CATALOG.proof,
        runBinding: {
          correlationId: MANAGED_CATALOG.correlationId,
          activityLogSha256: ACTIVITY_LOG.sha256,
        },
      });
    } finally {
      delete process.env.KEIKO_TOOL_CATALOG_QUALIFICATION_DIR;
      delete process.env.KEIKO_TOOL_CATALOG_QUALIFICATION_HEAD;
      rmSync(directory, { recursive: true, force: true });
    }
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

    expect(gaps).toHaveLength(10);
    expect(gaps).toContain("no exact source head was retained");
    expect(gaps).toContain("no useful H1 search-to-read result evidence");
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

    expect(readGatewayObservation(absent)).toEqual({
      requestCount: 0,
      outputTokenLimits: [],
      catalogBinding: undefined,
      catalogBindingRequestCount: 0,
    });
    // Non-integer entries are dropped rather than admitted into the evidence.
    expect(readGatewayObservation(partial)).toEqual({
      requestCount: 3,
      outputTokenLimits: [4096, 8192],
      catalogBinding: undefined,
      catalogBindingRequestCount: 0,
    });
  });

  it("joins actual gateway binding to successful search and derived bounded-read settlements", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-managed-catalog-"));
    const logPath = join(stateDir, "activity", "logs", "server.log");
    const correlationId = "real-binary-correlation";
    const settled = (canonicalId, invocationId, status = "completed") => ({
      op: "tool-catalog.invocation-settled",
      correlationId,
      invocationId,
      status,
      toolRef: { canonicalId, contractVersion: 1 },
      catalogRevision: CATALOG_BINDING.catalogRevision,
      profile: CATALOG_BINDING.profile,
      projectionDigest: CATALOG_BINDING.projectionDigest,
    });
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(
        logPath,
        [
          settled("keiko.repo.search", "search-invocation"),
          settled("keiko.workspace.edit", "edit-invocation"),
          settled("keiko.workspace.read", "read-invocation"),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
      const gateway = {
        requestCount: 4,
        outputTokenLimits: [4096],
        catalogBinding: CATALOG_BINDING,
        catalogBindingRequestCount: 4,
      };

      expect(readManagedCatalogEvidence(stateDir, gateway, H1_SEARCH)).toEqual(MANAGED_CATALOG);
      expect(
        readManagedCatalogEvidence(
          stateDir,
          { ...gateway, catalogBindingRequestCount: 3 },
          H1_SEARCH,
        ),
      ).toBeUndefined();
      writeFileSync(
        logPath,
        [
          settled("keiko.workspace.read", "read-invocation"),
          settled("keiko.repo.search", "search-invocation"),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      );
      expect(readManagedCatalogEvidence(stateDir, gateway, H1_SEARCH)).toBeUndefined();
      writeFileSync(logPath, '{"op":"tool-catalog.invocation-settled"\n');
      expect(readManagedCatalogEvidence(stateDir, gateway, H1_SEARCH)).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
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
      sourceHead: SOURCE_HEAD,
      exitCode: 0,
      gateway: {
        requestCount: 7,
        outputTokenLimits: [4096],
        catalogBindingRequestCount: 7,
      },
      limits: [{ context: 32_768, output: 4_096 }],
      missingPayload: { passed: true, unavailableReason: "payload-missing" },
      h1Search: H1_SEARCH,
      managedCatalog: MANAGED_CATALOG,
      activityLog: ACTIVITY_LOG,
      observer: createNetworkObserver("/nonexistent/opencode"),
      target: "macos-arm64",
      wallClockMs: 41_128,
      completedAt: "2026-09-06T11:30:00.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      issue: 2483,
      sourceHead: SOURCE_HEAD,
      evidenceClass: "functional-not-platform-qualified",
      runtime: { name: "opencode-compatible", version: "1.17.17", target: "macos-arm64" },
      journey: {
        exitCode: 0,
        wallClockMs: 41_128,
        completedAt: "2026-09-06T11:30:00.000Z",
      },
    });
    expect(missingRealBinaryEvidence(report)).toEqual([]);
    // The whole report must stay free of paths, endpoints, and page or prompt text.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain("http");
  });
});
