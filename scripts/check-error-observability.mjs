#!/usr/bin/env node
// RB-6 release gate (GEN-OBS-DIAGNOSTICS-901, CORRELATION-103/402/601) — Server error observability.
//
// Drives the REAL built artifacts (packages/*/dist) across a STRATIFIED SAMPLE of >=10 distinct
// emitServerDiagnostic / structural-log-port call sites, one per package/lane this epic touched:
//
//   1. server.top-level-catch          — keiko-server, the request-entry catch (unchanged, full HTTP
//                                         round trip: opaque 500, header echo, no-leak, UI-id honoured)
//   2. sink.terminal-event-tee         — keiko-server, the harness/workflow terminal-event tee (sink.ts)
//   3. memory-handlers.handleGetMemory — keiko-server, a memory-handlers route catch
//   4. memory-handlers.handleMemoryReviewQueue — keiko-server, a second, differently-shaped memory-handlers catch
//   5. memory-handlers.handlePinMemory — keiko-server, a third memory-handlers catch
//   6. voice-realtime.negotiation-failure — keiko-server, the voice control-plane negotiation failure
//   7. memory-maintenance-handlers.resolveMemoryRetentionPolicy — keiko-server, an env-driven catch
//   8. memory-maintenance-handlers.resolveMaintenanceAutonomyMode — keiko-server, a store-driven catch
//   9. memory-consolidation.log-port.sink-failed — keiko-memory-consolidation's own structural log port
//  10. memory-consolidation.summary-fallback — keiko-memory-consolidation's runConsolidation fallback path
//  11. security.macos-keychain.fallback — keiko-security's own structural log port
//
// Before this widening the gate forced exactly ONE synchronous throw through the top-level server.ts
// catch and asserted against exactly one produced record — real coverage of the other ~100
// emitServerDiagnostic/structural-log-port call sites across the repo was zero. Each site below is
// exercised by calling the REAL production function (imported from its built dist, or its public
// package export) with a fault injected at the narrowest possible seam, then asserting the SHAPE of
// the diagnostic/log record it produces (operation/op, category/source, errorClass, and any
// site-specific fields) — not merely that "some emit call happened".
//
// It goes RED against the pre-RB-6 defect (site 1: a bare `.catch(() => { ... })` that discards the
// error and emits an id-less 500) and against a bare `catch {}`/dropped-diagnostic regression at any
// of sites 2-11 (each fails closed with `records.length !== 1` or a shape mismatch, never a silent
// pass). This is the standalone, workflow-wired counterpart to the in-suite regression tests
// (server.test.ts / chat-stream-handlers.test.ts / memory-handlers.test.ts / voice-realtime.test.ts /
// sink.test.ts / consolidate.test.ts / log-port.test.ts, one per site above).

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const serverEntry = resolve(here, "../packages/keiko-server/dist/index.js");

const SECRET_MARKER = "gate-secret-DO-NOT-LEAK";
const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HOST = "127.0.0.1";

export const SERVER_TOP_LEVEL_SITE_ID = "server.top-level-catch";
export const MIN_STRATIFIED_SITES = 10;

function fail(message) {
  console.error(`check:error-observability FAIL — ${message}`);
  process.exit(1);
}

// Throws (never exits the process) so both `main()`'s CLI failure path and a vitest assertion can
// use the same shape checks — `fail()` is reserved for `main()`'s own top-level orchestration.
function check(condition, message) {
  if (!condition) throw new Error(message);
}

function distPath(pkg, file) {
  return resolve(here, "..", "packages", pkg, "dist", file);
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: HOST, port, path, method: "GET", headers: { host: `${HOST}:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function loadServerModule() {
  let mod;
  try {
    mod = await import(serverEntry);
  } catch (error) {
    fail(
      `could not import built server at ${serverEntry} — run \`npm run build\` first (${String(error)})`,
    );
  }
  const required = [
    "createUiServer",
    "buildRedactor",
    "createInMemoryUiStore",
    "createRunRegistry",
    "buildCspHeader",
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") fail(`built server does not export ${name}`);
  }
  return mod;
}

function throwingDeps(mod, records) {
  const store = mod.createInMemoryUiStore();
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: mod.buildRedactor({}),
    diagnostics: { record: (r) => records.push(r) },
    registry: mod.createRunRegistry(),
    modelPortFactory: () => undefined,
    store: {
      ...store,
      listProjects: () => {
        throw Object.assign(new Error(SECRET_MARKER), {
          code: "OBSERVABILITY_GATE_FAILURE",
          requestId: "observability-gateway-request-7",
          partialUsage: { promptTokens: 13, completionTokens: 5 },
        });
      },
    },
  };
}

// Two-phase bind so the Host/Origin allow-check validates against the real listening port.
async function startServer(mod, records) {
  const probe = mod.createUiServer({ staticRoot: here, csp: mod.buildCspHeader([]), port: 0 });
  const port = await new Promise((res) => {
    probe.listen(0, HOST, () => res(probe.address().port));
  });
  await new Promise((res) => probe.close(res));
  const server = mod.createUiServer({
    staticRoot: here,
    csp: mod.buildCspHeader([]),
    port,
    handlerDeps: throwingDeps(mod, records),
  });
  await new Promise((res) => server.listen(port, HOST, res));
  return { server, port };
}

function parse500Body(res) {
  if (res.status !== 500) fail(`expected 500 on handler throw, got ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return fail(`500 body is not JSON: ${res.body.slice(0, 200)}`);
  }
}

function assertNoLeak(res) {
  const headerBlob = Object.entries(res.headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`)
    .join("\n");
  if (res.body.includes(SECRET_MARKER) || headerBlob.includes(SECRET_MARKER)) {
    fail("raw cause leaked into the client-visible response");
  }
}

function assertOpaque500WithId(res) {
  const parsed = parse500Body(res);
  const cid = parsed?.error?.correlationId;
  if (typeof cid !== "string" || !ID_PATTERN.test(cid)) {
    fail(`500 body carries no well-formed error.correlationId (got ${JSON.stringify(cid)})`);
  }
  if (parsed.error.code !== "INTERNAL")
    fail(`expected error.code INTERNAL, got ${parsed.error.code}`);
  if (res.headers["x-keiko-correlation-id"] !== cid) {
    fail(`X-Keiko-Correlation-Id (${res.headers["x-keiko-correlation-id"]}) != body id (${cid})`);
  }
  assertNoLeak(res);
  return cid;
}

function assertDiagnosticIdentity(record, cid) {
  if (record.correlationId !== cid)
    fail("diagnostic record correlationId does not match the 500 id");
  if (record.source !== "server.top-level-catch")
    fail(`unexpected diagnostic source ${record.source}`);
  if (record.operation !== "server.request") fail(`unexpected operation ${record.operation}`);
  if (record.errorClass !== "Error") fail(`unexpected errorClass ${record.errorClass}`);
}

function assertDiagnosticMachineMetadata(record) {
  if (record.message !== "server-operation-failed")
    fail(`unexpected body-free summary ${record.message}`);
  if (record.code !== "OBSERVABILITY_GATE_FAILURE")
    fail(`machine error code was not retained (${record.code})`);
  if (record.gatewayRequestId !== "observability-gateway-request-7")
    fail(`gateway request id was not retained (${record.gatewayRequestId})`);
  if (record.partialUsage?.promptTokens !== 13 || record.partialUsage?.completionTokens !== 5)
    fail("partial usage counts were not retained");
}

function assertDiagnosticCaptured(records, cid) {
  if (records.length !== 1) fail(`expected exactly 1 diagnostic record, got ${records.length}`);
  const [record] = records;
  assertDiagnosticIdentity(record, cid);
  assertDiagnosticMachineMetadata(record);
  if (JSON.stringify(record).includes(SECRET_MARKER))
    fail("raw cause leaked into the operator diagnostic record");
}

async function assertClientIdHonoured(port) {
  const clientId = "gate-ui-req-0123456789";
  const echoed = await rawGet(port, "/api/projects", { "x-keiko-correlation-id": clientId });
  const parsed = JSON.parse(echoed.body);
  if (
    echoed.headers["x-keiko-correlation-id"] !== clientId ||
    parsed.error.correlationId !== clientId
  ) {
    fail("a well-formed UI-supplied correlation id was not honoured end to end");
  }
}

// ─── Site probes 2-11: narrow, direct fault-injection against the real built dist ────────────────
//
// Each probe imports the REAL production module (never a fixture that restates its logic), injects
// a fault at the narrowest seam that reaches the site's own `emitServerDiagnostic`/log-port call,
// and returns the record(s) it produced. `assertShape` then checks the site-specific fields a
// regression at that exact call site would break. A bare `catch {}` regression at any site makes
// `run()` return zero records, which `runProbe` below turns into a hard gate failure.

function makeSinkTerminalTeeProbe() {
  const runId = `gate-sink-run-${randomUUID()}`;
  return {
    id: "sink.terminal-event-tee",
    async run() {
      const mod = await import(distPath("keiko-server", "sink.js"));
      const records = [];
      const sink = new mod.QueueEventSink({ diagnostics: { record: (r) => records.push(r) } });
      sink.emit({
        schemaVersion: "1",
        runId,
        fingerprint: "gate-fingerprint",
        seq: 1,
        ts: Date.now(),
        type: "run:failed",
      });
      return records;
    },
    assertShape(record) {
      check(
        record.correlationId === runId,
        `sink tee correlationId mismatch: ${record.correlationId}`,
      );
      check(record.operation === "harness.run.failed", `sink tee operation: ${record.operation}`);
      check(record.source === "sink.terminal-event", `sink tee source: ${record.source}`);
      check(record.errorClass === "HarnessRunFailed", `sink tee errorClass: ${record.errorClass}`);
      check(
        typeof record.message === "string" && record.message.length > 0,
        "sink tee message missing",
      );
    },
  };
}

async function loadVaultModule() {
  return import("@oscharko-dev/keiko-memory-vault");
}

function makeMemoryHandlerVaultProbe(id, operation, source, throwingVault) {
  return {
    id,
    async run() {
      const mod = await import(distPath("keiko-server", "memory-handlers.js"));
      const vaultMod = await loadVaultModule();
      const records = [];
      const vault = throwingVault(vaultMod);
      const deps = {
        memoryVault: vault,
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      const ctx = { params: { id: "gate-memory-id" } };
      const result = mod[operation.handlerName](ctx, deps);
      check(result.status === 500, `${id} expected 500, got ${result.status}`);
      return records;
    },
    assertShape(record) {
      check(record.operation === operation.label, `${id} operation: ${record.operation}`);
      check(record.source === source, `${id} source: ${record.source}`);
      check(record.errorClass === "MemoryStorageError", `${id} errorClass: ${record.errorClass}`);
      check(
        typeof record.correlationId === "string" && record.correlationId.length > 0,
        `${id} correlationId missing`,
      );
    },
  };
}

function makeMemoryGetProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handleGetMemory",
    { handlerName: "handleGetMemory", label: "memory.get" },
    "memory-handlers.handleGetMemory",
    (vaultMod) => ({
      getMemory() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-get-failure");
      },
    }),
  );
}

function makeMemoryReviewQueueProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handleMemoryReviewQueue",
    { handlerName: "handleMemoryReviewQueue", label: "memory.review-queue" },
    "memory-handlers.handleMemoryReviewQueue",
    (vaultMod) => ({
      listMemoryScopes() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-scopes-failure");
      },
    }),
  );
}

function makeMemoryPinProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handlePinMemory",
    { handlerName: "handlePinMemory", label: "memory.pin" },
    "memory-handlers.handlePinMemory",
    (vaultMod) => ({
      getMemory() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-pin-failure");
      },
    }),
  );
}

const VOICE_OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

function voiceGateSession() {
  return {
    sessionId: "gate-sess-1",
    idempotencyKey: "gate-idem-1",
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
    providerLocality: undefined,
    chatContext: undefined,
    hostSeq: 0,
    lastClientSeq: 0,
    replay: [],
    replayStart: 0,
    detachedAt: undefined,
    terminal: false,
  };
}

function makeVoiceRealtimeNegotiationProbe() {
  const correlationId = `gate-voice-${randomUUID()}`;
  return {
    id: "voice-realtime.negotiation-failure",
    async run() {
      const mod = await import(distPath("keiko-server", "voice-realtime.js"));
      const records = [];
      const conn = new mod.VoiceControlConnection({
        socket: {
          send() {
            // No-op fake socket: this probe only drives the negotiation-failure diagnostic, never
            // asserts on outbound frames.
          },
          close() {
            // No-op: see above.
          },
        },
        session: voiceGateSession(),
        negotiate: () => Promise.resolve({ ok: false, kind: "transport" }),
        redact: (value) => value,
        correlationId,
        diagnostics: { record: (r) => records.push(r) },
      });
      conn.start(false);
      await conn.receive(
        JSON.stringify({
          protocolVersion: "1",
          sessionId: "gate-sess-1",
          seq: 1,
          direction: "client-to-host",
          kind: "signal.sdp.offer",
          sdp: VOICE_OFFER_SDP,
        }),
      );
      return records;
    },
    assertShape(record) {
      check(
        record.correlationId === correlationId,
        `voice negotiate correlationId: ${record.correlationId}`,
      );
      check(
        record.operation === "voice.realtime.negotiate",
        `voice negotiate operation: ${record.operation}`,
      );
      check(record.source === "voice.realtime", `voice negotiate source: ${record.source}`);
      check(record.code === "transport", `voice negotiate code: ${record.code}`);
    },
  };
}

function makeRetentionPolicyProbe() {
  return {
    id: "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
    async run() {
      const mod = await import(distPath("keiko-server", "memory-maintenance-handlers.js"));
      const records = [];
      const deps = {
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "not-a-number" },
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      const resolution = mod.resolveMemoryRetentionPolicy(deps);
      check(resolution.ok === false, "resolveMemoryRetentionPolicy did not fail closed");
      return records;
    },
    assertShape(record) {
      check(
        record.operation === "memory.maintenance.retention-policy",
        `retention-policy operation: ${record.operation}`,
      );
      check(
        record.source === "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
        `retention-policy source: ${record.source}`,
      );
      check(record.errorClass === "TypeError", `retention-policy errorClass: ${record.errorClass}`);
    },
  };
}

function makeAutonomyModeProbe() {
  return {
    id: "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
    async run() {
      const mod = await import(distPath("keiko-server", "memory-maintenance-handlers.js"));
      const records = [];
      const deps = {
        store: {
          readMemoryAutonomyPolicy() {
            throw new Error("gate-store-unreadable");
          },
        },
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      mod.resolveMaintenanceAutonomyMode(deps);
      return records;
    },
    assertShape(record) {
      check(
        record.operation === "memory.maintenance.autonomy-mode",
        `autonomy-mode operation: ${record.operation}`,
      );
      check(
        record.source === "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
        `autonomy-mode source: ${record.source}`,
      );
      check(record.errorClass === "Error", `autonomy-mode errorClass: ${record.errorClass}`);
    },
  };
}

function makeConsolidationLogPortProbe() {
  return {
    id: "memory-consolidation.log-port.sink-failed",
    async run() {
      const mod = await import(distPath("keiko-memory-consolidation", "log-port.js"));
      const records = [];
      let calls = 0;
      const sink = {
        write(event) {
          calls += 1;
          if (calls === 1) throw new Error("gate-consolidation-sink-write-failure");
          records.push(event);
        },
      };
      mod.emitConsolidationLogEvent(sink, { category: "consolidation", op: "gate.probe.op" });
      return records;
    },
    assertShape(record) {
      check(
        record.category === "diagnostic",
        `consolidation log-port category: ${record.category}`,
      );
      check(
        record.op === "consolidation.log.sink-failed",
        `consolidation log-port op: ${record.op}`,
      );
      check(record.level === "error", `consolidation log-port level: ${record.level}`);
      check(
        record.extra?.droppedOp === "gate.probe.op",
        "consolidation log-port droppedOp not retained",
      );
      check(
        typeof record.errorKind === "string" && record.errorKind.length > 0,
        "consolidation log-port errorKind missing",
      );
    },
  };
}

const CONSOLIDATION_CLUSTER_BODIES = ["use tabs", "prefer compact diffs", "keep PR titles short"];

async function buildConsolidationClusterRecords() {
  const fixtures = await import("@oscharko-dev/keiko-contracts/memory-fixtures");
  return CONSOLIDATION_CLUSTER_BODIES.map((body, index) =>
    fixtures.makeMemoryRecord({
      id: `gate-consolidation-m-${String(index)}`,
      body,
      createdAt: 100 * (index + 1),
      updatedAt: 100 * (index + 1),
    }),
  );
}

function consolidationOptions(records, sink) {
  let edgeCounter = 0;
  let reviewCounter = 0;
  const nextEdgeId = () => {
    edgeCounter += 1;
    return `gate-edge-${String(edgeCounter)}`;
  };
  const nextReviewItemId = () => {
    reviewCounter += 1;
    return `gate-review-${String(reviewCounter)}`;
  };
  return {
    nowMs: 1_700_000_000_000,
    newEdgeId: nextEdgeId,
    newReviewItemId: nextReviewItemId,
    jaccardThreshold: 0,
    staleConfidenceThreshold: 0.3,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    maxClustersPerRun: 100,
    maxRecordsPerRun: 1000,
    summaryGenerator: () => {
      throw new Error("gate-summary-generator-failure");
    },
    logSink: sink,
  };
}

function makeConsolidationSummaryFallbackProbe() {
  return {
    id: "memory-consolidation.summary-fallback",
    async run() {
      const mod = await import(distPath("keiko-memory-consolidation", "consolidate.js"));
      const records = [];
      const sink = { write: (event) => records.push(event) };
      const clusterRecords = await buildConsolidationClusterRecords();
      mod.runConsolidation(clusterRecords, consolidationOptions(clusterRecords, sink));
      return records;
    },
    assertShape(record) {
      check(record.category === "consolidation", `summary-fallback category: ${record.category}`);
      check(record.op === "consolidation.summary.fallback", `summary-fallback op: ${record.op}`);
      check(
        record.extra?.reason === "generator-threw",
        `summary-fallback reason: ${record.extra?.reason}`,
      );
    },
  };
}

function makeKeychainFallbackProbe() {
  return {
    id: "security.macos-keychain.fallback",
    async run() {
      const mod = await import(distPath("keiko-security", "macos-keychain.js"));
      const records = [];
      const sink = { write: (event) => records.push(event) };
      const error = Object.assign(new Error("gate-keychain-failure"), { code: "ENOENT" });
      mod.emitKeychainFallback(sink, error, () => 42);
      return records;
    },
    assertShape(record) {
      check(record.category === "security", `keychain fallback category: ${record.category}`);
      check(record.op === "security.keychain.fallback", `keychain fallback op: ${record.op}`);
      check(record.level === "warn", `keychain fallback level: ${record.level}`);
      check(record.durationMs === 42, `keychain fallback durationMs: ${record.durationMs}`);
      check(typeof record.extra?.reasonKind === "string", "keychain fallback reasonKind missing");
      check(
        typeof record.extra?.boundedExitKind === "string",
        "keychain fallback boundedExitKind missing",
      );
    },
  };
}

export const SITE_PROBES = [
  makeSinkTerminalTeeProbe(),
  makeMemoryGetProbe(),
  makeMemoryReviewQueueProbe(),
  makeMemoryPinProbe(),
  makeVoiceRealtimeNegotiationProbe(),
  makeRetentionPolicyProbe(),
  makeAutonomyModeProbe(),
  makeConsolidationLogPortProbe(),
  makeConsolidationSummaryFallbackProbe(),
  makeKeychainFallbackProbe(),
];

async function runProbe(probe, exercised) {
  let records;
  try {
    records = await probe.run();
  } catch (error) {
    fail(`site '${probe.id}' threw while exercising: ${String(error?.stack ?? error)}`);
    return;
  }
  if (records.length !== 1) {
    fail(`site '${probe.id}' expected exactly 1 record, got ${records.length}`);
    return;
  }
  try {
    probe.assertShape(records[0]);
  } catch (error) {
    fail(`site '${probe.id}' shape assertion failed: ${String(error?.stack ?? error)}`);
    return;
  }
  exercised.push(probe.id);
}

async function runServerTopLevelSite(exercised) {
  const mod = await loadServerModule();
  const records = [];
  const { server, port } = await startServer(mod, records);
  try {
    const cid = assertOpaque500WithId(await rawGet(port, "/api/projects"));
    assertDiagnosticCaptured(records, cid);
    await assertClientIdHonoured(port);
    exercised.push(SERVER_TOP_LEVEL_SITE_ID);
  } finally {
    await new Promise((res) => server.close(res));
  }
}

export async function main() {
  const exercised = [];
  await runServerTopLevelSite(exercised);
  for (const probe of SITE_PROBES) {
    await runProbe(probe, exercised);
  }
  if (exercised.length < MIN_STRATIFIED_SITES) {
    fail(`only ${exercised.length} distinct sites were exercised, need >= ${MIN_STRATIFIED_SITES}`);
  }
  console.log(
    `check:error-observability PASS — ${String(exercised.length)} distinct call sites verified ` +
      `(${exercised.join(", ")}).`,
  );
}

if (process.argv[1] === scriptPath) {
  try {
    await main();
  } catch (error) {
    fail(`unexpected gate error: ${String(error?.stack ?? error)}`);
  }
}
